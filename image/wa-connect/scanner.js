// WA Connect Service — Browser Scanner Module v4.0
// Manages Chromium + xvfb + noVNC lifecycle for each scan session
// v4: idle timeout + WAHA session status check
import { spawn, execSync } from 'child_process';
import http from 'http';
import url from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import config from './config.js';

const log = (msg) => console.log(`[scanner] ${msg}`);

// Slot states
const slots = new Map(); // token -> { processes, display, vncWebPort, status, createdAt, lastActivity }

// ── Auto-scaling de slots baseado nos recursos DO CONTAINER (cgroup) ──
// Em K8s, /proc/meminfo e os.cpus() reportam o NÓ inteiro (não o limite do pod),
// o que super-dimensiona e leva a OOMKill. Aqui lemos os limites de cgroup
// (v2 → v1) e só caímos no nó como último recurso.
function readContainerMemLimitBytes() {
  // cgroup v2
  try {
    const v = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (v && v !== 'max') { const n = parseInt(v, 10); if (n > 0) return n; }
  } catch (e) {}
  // cgroup v1
  try {
    const n = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim(), 10);
    // v1 usa um valor gigante quando "ilimitado" — ignora se for irreal
    if (n > 0 && n < os.totalmem() * 8) return n;
  } catch (e) {}
  // fallback: RAM do nó
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemTotal:\s+(\d+)/);
    if (m) return parseInt(m[1], 10) * 1024;
  } catch (e) {}
  return null;
}

function readContainerCpuLimit() {
  // cgroup v2: "<quota> <period>" (ou "max <period>" = ilimitado)
  try {
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota && quota !== 'max') {
      const c = parseInt(quota, 10) / parseInt(period, 10);
      if (c > 0) return c;
    }
  } catch (e) {}
  // cgroup v1
  try {
    const q = parseInt(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim(), 10);
    const p = parseInt(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim(), 10);
    if (q > 0 && p > 0) return q / p;
  } catch (e) {}
  // fallback: CPUs do nó
  try { return os.cpus().length; } catch (e) { return null; }
}

function calcDynamicMaxSlots() {
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const memPerSlotMb = num(process.env.MEM_PER_SLOT_MB, 700);      // footprint do Chrome por sessão
  const memReserveMb = num(process.env.MEM_RESERVE_MB, 512);       // margem p/ serviço/SO
  const cpuPerSlot   = num(process.env.CPU_PER_SLOT, 0.5);         // CPU por sessão
  const ceiling      = Math.floor(num(process.env.MAX_SLOTS, 10)); // teto duro de segurança

  // Orçamento de memória: MEM_BUDGET_MB (explícito) tem prioridade — útil para
  // dimensionar pelo container do WAHA (onde o Chrome roda), que este processo
  // não consegue ler. Sem ele, usa o limite de cgroup deste container.
  let memBudgetMb = num(process.env.MEM_BUDGET_MB, 0);
  if (!memBudgetMb) {
    const b = readContainerMemLimitBytes();
    if (b) memBudgetMb = b / (1024 * 1024);
  }

  let byMem = ceiling;
  if (memBudgetMb) byMem = Math.max(1, Math.floor((memBudgetMb - memReserveMb) / memPerSlotMb));

  let byCpu = ceiling;
  const cpu = readContainerCpuLimit();
  if (cpu) byCpu = Math.max(1, Math.floor(cpu / cpuPerSlot));

  const auto = Math.max(1, Math.min(byMem, byCpu, ceiling));
  log(`Auto-scaling slots: mem=${byMem} (orçamento ${Math.round(memBudgetMb)}MB), cpu=${byCpu} (${cpu ? cpu.toFixed(2) : '?'} cores), teto=${ceiling} → ${auto}`);
  return auto;
}

const DYNAMIC_MAX_SLOTS = calcDynamicMaxSlots();

// FIFO queue callback (notified quando slot é liberado)
let _onSlotFreed = null;
export function onSlotFreed(cb) { _onSlotFreed = cb; }

// Clean up zombies from previous runs
try {
  ['Xvfb :2[0-4]', 'x11vnc.*592[0-4]', 'novnc.*702[0-4]', 'chromium.*--user-data-dir=/tmp/wa-profiles']
    .forEach(p => execSync(`pkill -f "${p}" 2>/dev/null`, { stdio: 'pipe' }));
} catch (e) {}


// --- Session restart tracker (anti-loop) ---
const sessionRestartTracker = new Map();
const RESTART_THRESHOLD = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const BLOCK_DURATION_MS = 10 * 60 * 1000;
const WORKING_STABLE_MS = parseInt(
  process.env.WA_CONNECT_WORKING_STABLE_MS ||
    process.env.WORKING_STABLE_MS ||
    '20000',
  10
);
const MIN_WORKING_STABLE_MS = parseInt(process.env.MIN_WORKING_STABLE_MS || '5000', 10);
const MAX_WORKING_STABLE_MS = parseInt(process.env.MAX_WORKING_STABLE_MS || '300000', 10);

export function normalizeWorkingStableMs(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return WORKING_STABLE_MS;

  const min = Number.isFinite(MIN_WORKING_STABLE_MS) && MIN_WORKING_STABLE_MS >= 0
    ? MIN_WORKING_STABLE_MS
    : 5000;
  const max = Number.isFinite(MAX_WORKING_STABLE_MS) && MAX_WORKING_STABLE_MS > 0
    ? MAX_WORKING_STABLE_MS
    : 300000;
  return Math.min(Math.max(parsed, min), max);
}

function checkSessionRestartRate(sessionName) {
  if (!sessionName) return true;
  const now = Date.now();
  let tracker = sessionRestartTracker.get(sessionName);
  if (tracker && tracker.blockedUntil) {
    if (now < tracker.blockedUntil) {
      console.log("[scanner] Session " + sessionName + " BLOCKED " + Math.round((tracker.blockedUntil - now) / 1000) + "s remaining");
      return false;
    }
    console.log("[scanner] Session " + sessionName + " unblocked");
    sessionRestartTracker.delete(sessionName);
    return true;
  }
  if (!tracker) {
    sessionRestartTracker.set(sessionName, { count: 1, firstRestartAt: now, blockedUntil: null });
    return true;
  }
  if (now - tracker.firstRestartAt < RESTART_WINDOW_MS) {
    tracker.count++;
    if (tracker.count >= RESTART_THRESHOLD) {
      tracker.blockedUntil = now + BLOCK_DURATION_MS;
      console.log("[scanner] Session " + sessionName + " BLOCKED for " + (BLOCK_DURATION_MS/1000) + "s (loop protection)");
      return false;
    }
    console.log("[scanner] Session " + sessionName + " restart " + tracker.count + "/" + RESTART_THRESHOLD);
  } else {
    tracker.count = 1;
    tracker.firstRestartAt = now;
  }
  return true;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// WAHA API helpers
// ============================================

/**
 * Consulta status de uma sessão no WAHA.
 * Retorna { exists: bool, status: string, data: object } ou null se erro
 */
export function getWahaSessionStatus(sessionName) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(config.waha.apiUrl);
      const opts = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: '/api/sessions/' + encodeURIComponent(sessionName),
        method: 'GET',
        headers: { 'X-Api-Key': config.waha.apiKey },
        timeout: 5000,
      };

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 404) {
            resolve({ exists: false, status: 'NOT_FOUND', data: null });
            return;
          }
          if (res.statusCode !== 200) {
            resolve({ exists: false, status: 'ERROR', data: { statusCode: res.statusCode } });
            return;
          }
          try {
            const session = JSON.parse(data);
            const s = session.status || 'UNKNOWN';
            resolve({ exists: true, status: s, data: session });
          } catch (e) {
            resolve({ exists: false, status: 'PARSE_ERROR', data: null });
          }
        });
      });
      req.on('error', (e) => resolve({ exists: false, status: 'NET_ERROR', data: { error: e.message } }));
      req.end();
    } catch (e) {
      resolve({ exists: false, status: 'EXCEPTION', data: { error: e.message } });
    }
  });
}

/**
 * Encontra slot existente pelo sessionName
 */
export function findSlotBySessionName(sessionName) {
  for (const [token, entry] of slots.entries()) {
    if (entry.status === 'cleaned') continue;
    if (entry.sessionName === sessionName) return { token, entry };
  }
  return null;
}

/**
 * Deleta sessão WAHA remota
 */
export function deleteWahaSession(sessionName) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(config.waha.apiUrl);
      const opts = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: '/api/sessions/' + encodeURIComponent(sessionName),
        method: 'DELETE',
        headers: { 'X-Api-Key': config.waha.apiKey },
        timeout: 5000,
      };
      const req = http.request(opts, () => resolve(true));
      req.on('error', () => resolve(false));
      req.end();
    } catch (e) { resolve(false); }
  });
}

/**
 * Cria sessão WAHA com display configurado
 */
export function createWahaSession(sessionName, displayNum) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(config.waha.apiUrl);
      // Sem config.webhooks a sessão nasce "surda": o WAHA não emite nenhum
      // evento (inbound/eco fromMe) e as mensagens somem do inbox, embora o
      // envio continue funcionando. Regressão observada quando o reconnect
      // recriou a sessão por aqui.
      const webhookUrl = String(config.waha.webhookUrl || '').trim();
      const webhooks = webhookUrl
        ? [
            {
              url: webhookUrl,
              events: String(config.waha.webhookEvents || '')
                .split(',')
                .map((e) => e.trim())
                .filter(Boolean),
            },
          ]
        : undefined;
      const sessionBody = JSON.stringify({
        name: sessionName,
        config: {
          engine: 'WEBJS',
          webjs: { tagsEventsOn: false },
          client: { display: ':' + displayNum },
          ...(webhooks ? { webhooks } : {}),
        },
        start: true,
      });

      const postReq = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: '/api/sessions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': config.waha.apiKey,
        },
        timeout: 10000,
      }, (postRes) => {
        let data = '';
        postRes.on('data', (chunk) => data += chunk);
        postRes.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve(data); }
        });
      });
      postReq.on('error', (e) => reject(e));
      postReq.write(sessionBody);
      postReq.end();
    } catch (e) { reject(e); }
  });
}

/**
 * Lista todas as sessões do WAHA (GET /api/sessions). Retorna [] em erro.
 */
function buildWahaSessionConfig(displayNum) {
  const webhookUrl = String(config.waha.webhookUrl || '').trim();
  const webhooks = webhookUrl
    ? [{
        url: webhookUrl,
        events: String(config.waha.webhookEvents || '')
          .split(',')
          .map((event) => event.trim())
          .filter(Boolean),
      }]
    : undefined;
  return {
    engine: 'WEBJS',
    webjs: { tagsEventsOn: false },
    client: { display: ':' + displayNum },
    ...(webhooks ? { webhooks } : {}),
  };
}

function requestWaha(method, path, body, acceptedStatuses = []) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(config.waha.apiUrl);
      const serialized = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path,
        method,
        headers: {
          'X-Api-Key': config.waha.apiKey,
          ...(serialized ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(serialized),
          } : {}),
        },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if ((res.statusCode >= 200 && res.statusCode < 300) || acceptedStatuses.includes(res.statusCode)) {
            try { resolve(data ? JSON.parse(data) : {}); }
            catch { resolve(data); }
            return;
          }
          reject(new Error('WAHA ' + method + ' ' + path + ' failed: HTTP ' + res.statusCode + ' ' + data));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('WAHA ' + method + ' ' + path + ' timed out')));
      if (serialized) req.write(serialized);
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

export async function reconnectWahaSession(sessionName, displayNum) {
  const encoded = encodeURIComponent(sessionName);
  await requestWaha('POST', '/api/sessions/' + encoded + '/stop', undefined, [404]);
  await requestWaha('PUT', '/api/sessions/' + encoded, {
    name: sessionName,
    config: buildWahaSessionConfig(displayNum),
  });
  await requestWaha('POST', '/api/sessions/' + encoded + '/start');
}

function listWahaSessions() {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(config.waha.apiUrl);
      const req = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: '/api/sessions',
        method: 'GET',
        headers: { 'X-Api-Key': config.waha.apiKey },
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try { const j = JSON.parse(data); resolve(Array.isArray(j) ? j : []); }
          catch (e) { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.end();
    } catch (e) { resolve([]); }
  });
}



// ============================================
// Pool management
// ============================================

export function getAvailableSlot() {
  const maxSlots = DYNAMIC_MAX_SLOTS;
  // Indices de slot atualmente em uso (cada slot ativo carrega seu slotId).
  // Retornar um INDICE LIVRE (nao a contagem) evita que dois slots caiam no
  // mesmo display/porta VNC -- causa de o VNC mostrar o browser de outra sessao.
  const used = new Set();
  for (const s of slots.values()) {
    if (s.status === 'cleaned') continue;
    if (typeof s.slotId === 'number') used.add(s.slotId);
  }
  for (let i = 0; i < maxSlots; i++) {
    if (!used.has(i)) return i;
  }
  return null;
}

// Mata qualquer processo residual num display/portas antes de reutiliza-lo,
// para o VNC nunca exibir o framebuffer/browser de uma sessao anterior.
function killDisplayArtifacts(slot) {
  const patterns = [
    `Xvfb :${slot.display}\\b`,
    `x11vnc.*-rfbport ${slot.rfbPort}\\b`,
    `novnc.*${slot.webPort}\\b`,
    `novnc_proxy.*${slot.webPort}\\b`,
  ];
  for (const p of patterns) {
    try { execSync(`pkill -f "${p}" 2>/dev/null`, { stdio: 'pipe' }); } catch (e) {}
  }
}

export function getSlotInfo(token) {
  return slots.get(token) || null;
}

function safeSpawn(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: 'ignore', ...opts });
    proc.on('error', (err) => reject(new Error(`spawn ${bin} failed: ${err.message}`)));
    proc.on('spawn', () => resolve(proc));
    setTimeout(() => { if (!proc.killed) resolve(proc); }, 100);
  });
}

// ============================================
// WAHA session monitor (auto-cleanup)
// ============================================

function startWahaMonitor(token, sessionName) {
  const entry = slots.get(token);
  if (!entry) return;

  const interval = setInterval(() => {
    const current = slots.get(token);
    if (!current || current.status === 'cleaned') {
      clearInterval(interval);
      return;
    }

    getWahaSessionStatus(sessionName).then((result) => {
      if (!result.exists) {
        log(`WAHA session ${sessionName} deleted, auto-cleanup`);
        clearInterval(interval);
        cleanup(token);
        return;
      }
      // Koolaber state-machine fix: FAILED / STARTING / SCAN_QR_CODE / PAIRING MUST
      // NOT clean the display during pairing. Only cleanup after WORKING stable,
      // explicit cancel, pod shutdown, or a hard-timeout for a stale slot.
      const staleMs = 3600 * 1000;
      if (current._allocatedAt && (Date.now() - current._allocatedAt) > staleMs) {
        log(`WAHA session ${sessionName} slot stale (>1h); auto-cleanup once`);
        clearInterval(interval);
        cleanup(token);
        return;
      }

      if (result.status === 'WORKING') {
        const now = Date.now();
        const workingStableMs = normalizeWorkingStableMs(current.workingStableMs);
        if (!current._workingSince) {
          current._workingSince = now;
          current.status = 'working_waiting_stable';
          current.authenticated = true;
          log(
            `WAHA session ${sessionName} is WORKING; waiting ${Math.round(workingStableMs / 1000)}s before cleanup`
          );
          return;
        }

        if (now - current._workingSince >= workingStableMs) {
          log(`WAHA session ${sessionName} stayed WORKING, auto-cleanup`);
          clearInterval(interval);
          cleanup(token);
        }
        return;
      }

      if (current._workingSince) {
        log(`WAHA session ${sessionName} left WORKING (${result.status}); keeping VNC alive`);
        current._workingSince = null;
        if (current.status === 'working_waiting_stable') {
          current.status = 'display_allocated';
        }
      }
    });
  }, 5000);

  entry._monitorInterval = interval;
}

// ============================================
// VNC client connection checker
// ============================================

/**
 * Verifica se o noVNC teve alguma conexão de cliente recente.
 * Tenta conectar na porta VNC Web (noVNC via HTTP) e verifica se há
 * conexões estabelecidas. Como fallback, checa se o noVNC aceita conexão.
 */
function hasVncClientConnection(slot) {
  // Se não tem slot, não tem conexão
  if (!slot) return false;

  // Tenta verificar conexões TCP na porta noVNC
  try {
    const result = execSync(
      `ss -tnp 2>/dev/null | grep -E ":${slot.webPort}\\s" | grep -v "LISTEN" | wc -l`,
      { encoding: 'utf8', timeout: 3000 }
    );
    const count = parseInt(result.trim());
    return count > 0;
  } catch (e) {
    // fallback: tenta socket connection pra ver se tem client
    return false;
  }
}

// ============================================
// Idle timeout check
// ============================================

function getIdleTimeoutConfig() {
  return {
    noClientTimeout: config.idle?.noClientTimeout || 120000,
    maxTotalSlotTime: config.idle?.maxTotalSlotTime || 600000,
  };
}

// ============================================
// Allocate Display
// ============================================

export async function allocateDisplay(token, sessionName, options = {}) {
  // Pool full nunca deve consumir restart budget — não é um restart de verdade.
  // Koolaber fix: NÃO bloquear por restart (2/3) durante pareamento/reconexão
  // legítima. O open-vnc deve reabrir o mesmo slot de forma idempotente;
  // o single-flight evita starts duplicados, não o restart rate.
  // Apenas verifica wa-connect slots, WAHA pode ter 100+ sessões e o display
  // é um slot temporário do VNC, não um lock fixo na sessão WAHA.
  // REUSE: se a sessao ja tem um slot vivo, reutiliza (mesmo display/portas)
  // em vez de alocar novo — evita "Pool full" em open-vnc repetido e garante
  // o vinculo sessionName -> display estavel (nothing to recreate).
  const existingSlot = findSlotBySessionName(sessionName);
  if (existingSlot && existingSlot.entry && existingSlot.entry.status !== 'cleaned') {
    const e = existingSlot.entry;
    e.lastActivity = Date.now();
    // IMPORTANTE: webPort/rfbPort SEMPRE derivados do slotId (nunca 0), para o
    // hasVncClientConnection detectar o cliente e evitar idle-cleanup indevido.
    const slot = e.slot && (e.slot.webPort || e.slot.rfbPort)
      ? e.slot
      : {
          slotId: e.slotId,
          display: e.display ?? config.pool.displayStart + e.slotId,
          rfbPort: (e.slot && e.slot.rfbPort) || config.pool.vncRfbStart + e.slotId,
          webPort: (e.slot && e.slot.webPort) || config.pool.vncWebStart + e.slotId,
        };
    log(`allocateDisplay: reutilizando slot vivo de ${sessionName} (slot ${e.slotId}, display :${slot.display})`);
    startWahaMonitor(existingSlot.token, sessionName);
    return {
      token: existingSlot.token,
      sessionName,
      vncUrl: e.vncUrl || `http://${config.pool.vncExternalHost}:${config.pool.vncExternalPortStart + e.slotId}/vnc_lite.html?autoconnect=true&resize=scale&show_dot=false&showControlBar=false`,
      display: slot.display,
      webPort: config.pool.vncWebStart + e.slotId,
      workingStableMs: e.workingStableMs || WORKING_STABLE_MS,
    };
  }

  const maxSlots = DYNAMIC_MAX_SLOTS;
  const used = new Set();
  for (const s of slots.values()) {
    if (s.status === 'cleaned') continue;
    if (typeof s.slotId === 'number') used.add(s.slotId);
  }
  let slotId = null;
  for (let i = 0; i < maxSlots; i++) {
    if (used.has(i)) continue;
    slotId = i; break;
  }
  if (slotId === null) throw new Error('Pool full');

  // SÓ DEPOIS: como decidimos não bloquear por restart mere pareamento legítimo,
  // avança direto sem gate de restart (o single-flight já garante 1 start por vez).
  // (o gate de restart FICA desligado para reconexão estável.)
  // e a falha será genuína (não pool full).

  const workingStableMs = normalizeWorkingStableMs(options.workingStableMs);

  // Reserva o indice IMEDIATAMENTE (sincrono, antes de qualquer await) para que
  // dois requests concorrentes nunca peguem o mesmo display/porta VNC.
  const reservedAt = Date.now();
  slots.set(token, {
    token, sessionName, slotId,
    processes: {}, createdAt: reservedAt, lastActivity: reservedAt, _allocatedAt: reservedAt,
    status: 'allocating', authenticated: false, workingStableMs,
  });

  const slot = {
    slotId,
    display: config.pool.displayStart + slotId,
    rfbPort: config.pool.vncRfbStart + slotId,
    webPort: config.pool.vncWebStart + slotId,
  };

  // Garante que o display/portas estejam limpos (sem browser/Xvfb de sessao anterior).
  killDisplayArtifacts(slot);

  log(`Allocating display for ${sessionName} (slot ${slotId}, display :${slot.display}, web ${slot.webPort})`);

  let xvfb, x11vnc, novnc;

  try {
    xvfb = await safeSpawn('Xvfb', [`:${slot.display}`, '-screen', '0', '1920x1080x24', '-ac']);
    await sleep(1500);

    x11vnc = await safeSpawn('x11vnc', [
      '-display', `:${slot.display}`, '-forever', '-shared',
      '-rfbport', String(slot.rfbPort), '-nopw', '-listen', '0.0.0.0',
    ]);
    await sleep(500);

    novnc = await safeSpawn('/usr/share/novnc/utils/novnc_proxy', [
      '--listen', String(slot.webPort), '--vnc', `localhost:${slot.rfbPort}`,
    ]);
    await sleep(1000);
  } catch (e) {
    try { if (xvfb) xvfb.kill('SIGKILL'); } catch (e2) {}
    try { if (x11vnc) x11vnc.kill('SIGKILL'); } catch (e2) {}
    try { if (novnc) novnc.kill('SIGKILL'); } catch (e2) {}
    slots.delete(token); // libera a reserva do slot em caso de falha
    throw e;
  }

  const now = Date.now();
  const entry = {
    token,
    sessionName,
    slotId,
    slot,
    processes: { xvfb, x11vnc, novnc },
    createdAt: now,
    lastActivity: now,
    status: 'display_allocated',
    workingStableMs,
    vncUrl: `http://${config.pool.vncExternalHost}:${config.pool.vncExternalPortStart + slotId}/vnc_lite.html?autoconnect=true&resize=scale&show_dot=false&showControlBar=false`,
    authenticated: false,
  };

  slots.set(token, entry);
  log(`Display allocated: ${sessionName} -> VNC :${slot.webPort} (display :${slot.display})`);

  // Auto-monitor WAHA session for cleanup
  startWahaMonitor(token, sessionName);

  return {
    token,
    sessionName,
    vncUrl: entry.vncUrl,
    display: slot.display,
    webPort: slot.webPort,
    workingStableMs,
  };
}

// ============================================
// Start Browser
// ============================================

export async function startBrowser(token, sessionName, proxyUrl, options = {}) {
  // Single-flight por sessionName (mesma regra do open-vnc): se já existe slot
  // vivo para esta sessão, não criar outro Chromium auxiliar. Retorna o mesmo
  // slot/token para não duplicar inicialização.
  const existingSingle = findSlotBySessionName(sessionName);
  if (existingSingle && existingSingle.entry && existingSingle.entry.status !== 'cleaned') {
    const e = existingSingle.entry;
    e.lastActivity = Date.now();
    log(`startBrowser: reutilizando slot vivo existente de ${sessionName} (display :${e.slot?.display})`);
    return {
      token: existingSingle.token,
      sessionName,
      vncUrl: e.vncUrl || null,
      vncPort: e.slot?.webPort ? config.pool.vncExternalPortStart + e.slot.slotId : null,
      display: e.slot?.display ?? null,
      workingStableMs: e.workingStableMs || WORKING_STABLE_MS,
      reused: true,
    };
  }

  const slotId = getAvailableSlot();
  if (slotId === null) throw new Error('Pool full');

  const workingStableMs = normalizeWorkingStableMs(options.workingStableMs);

  // Reserva o indice imediatamente (anti-corrida), igual ao allocateDisplay.
  const reservedAt = Date.now();
  slots.set(token, {
    token, sessionName, slotId,
    processes: {}, createdAt: reservedAt, lastActivity: reservedAt, _allocatedAt: reservedAt,
    status: 'allocating', authenticated: false, workingStableMs,
  });

  const slot = {
    slotId,
    display: config.pool.displayStart + slotId,
    rfbPort: config.pool.vncRfbStart + slotId,
    webPort: config.pool.vncWebStart + slotId,
  };

  // Limpa qualquer residuo no display/portas antes de reutilizar.
  killDisplayArtifacts(slot);

  const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const userDataDir = path.join(config.chromium.userDataDir, safeName);
  fs.mkdirSync(userDataDir, { recursive: true });

  log(`Starting browser ${sessionName} (slot ${slotId}, display :${slot.display}, web ${slot.webPort})`);

  // Clean old lock files
  try {
    const files = fs.readdirSync(userDataDir);
    files.forEach(f => {
      if (f.startsWith('Singleton') || f.startsWith('.org.chromium'))
        try { fs.unlinkSync(path.join(userDataDir, f)); } catch (e) {}
    });
  } catch (e) {}

  let xvfb, x11vnc, novnc, chromium;
  let stderrData = '';

  try {
    xvfb = await safeSpawn('Xvfb', [`:${slot.display}`, '-screen', '0', '1920x1080x24', '-ac']);
    await sleep(1500);

    x11vnc = await safeSpawn('x11vnc', [
      '-display', `:${slot.display}`, '-forever', '-shared',
      '-rfbport', String(slot.rfbPort), '-nopw', '-listen', '0.0.0.0',
    ]);
    await sleep(500);

    novnc = await safeSpawn('novnc_server', [
      '--listen', String(slot.webPort), '--vnc', `localhost:${slot.rfbPort}`,
    ]);
    await sleep(1000);

    // O Chromium auxiliar NUNCA abre WhatsApp: o WAHA/Puppeteer é o único
    // proprietário da página web.whatsapp.com (client page). O auxiliar abre uma
    // página neutra accounts.google.com (usada no fluxo passkey/Google), igual
    // ao browser direct. Iniciar o auxiliar em web.whatsapp.com aqui disputava
    // display/página/bindings com o Puppeteer do WAHA -> 2 abas WhatsApp.
    const chromiumArgs = [
      ...config.chromium.args,
      '--window-size=1920,1080',
      '--window-position=0,0',
      '--force-device-scale-factor=0.75',
      '--user-data-dir=' + userDataDir,
      'https://accounts.google.com',
    ];
    // Guarda de baixo custo: nunca subir um segundo Chromium auxiliar para uma
    // sessão que já tem slot/display vivo (impede duplicação de inicialização).
    if (findSlotBySessionName(sessionName)) {
      log(`startBrowser: sessão ${sessionName} já possui slot vivo — não iniciando Chromium auxiliar extra`);
      throw new Error('Auxiliary browser already alive for ' + sessionName);
    }
    if (proxyUrl) chromiumArgs.unshift('--proxy-server=' + proxyUrl);

    const env = { ...process.env, DISPLAY: `:${slot.display}` };
    chromium = spawn(config.chromium.executablePath, chromiumArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    chromium.stderr.on('data', (d) => {
      stderrData += d.toString();
      const line = d.toString().trim();
      if (line.includes('FATAL') || line.includes('ERROR') || line.includes('Aborted') || line.includes('CRASH')) {
        log(`[CHROMIUM_ERR] ${sessionName}: ${line.slice(0, 200)}`);
      }
    });

    // O fechamento do Chromium AUXILIAR não pode derrubar Xvfb/x11vnc/noVNC nem
    // o navegador do WAHA. O usuário pode fechar a página/aba Google sem querer
    // derrubar o display. Aqui mantemos Xvfb+x11vnc+noVNC vivos (e o browser WAHA)
    // e, no máximo, tentamos reabrir a página Google. cleanup() completo só em
    // release explícito (/connect/close) ou timeout autorizado (idle/hard/auto).
    chromium.on('exit', (code, signal) => {
      log(`Chromium auxiliar ${sessionName} exited (code=${code}, signal=${signal})`);
      if (code !== 0 || signal) {
        log(`[CHROMIUM_STDERR] ${sessionName}: ${stderrData.slice(-500)}`);
      }
      const cur = slots.get(token);
      if (cur) cur._auxExited = true;
      // NÃO chamar cleanup(token) aqui. O lifecycle do display pertence ao
      // slot (Xvfb/x11vnc/noVNC) e ao monitor/close/timesout, não ao Chromium
      // auxiliar. Xvfb/VNC continuam servindo o browser do WAHA.
      log(`Chromium auxiliar ${sessionName} encerrado; Xvfb/x11vnc/noVNC mantidos vivos (auxiliary-only exit)`);
    });

  } catch (e) {
    log(`Browser startup failed for ${sessionName}: ${e.message}`);
    try { if (xvfb) xvfb.kill('SIGKILL'); } catch (e2) {}
    try { if (x11vnc) x11vnc.kill('SIGKILL'); } catch (e2) {}
    try { if (novnc) novnc.kill('SIGKILL'); } catch (e2) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e2) {}
    slots.delete(token); // libera a reserva do slot em caso de falha
    throw e;
  }

  const now = Date.now();
  const entry = {
    token,
    sessionName,
    safeName,
    slotId,
    slot,
    userDataDir,
    processes: { xvfb, x11vnc, novnc, chromium },
    createdAt: now,
    lastActivity: now,
    status: 'waiting_qr',
    workingStableMs,
    vncUrl: `http://${config.pool.vncExternalHost}:${config.pool.vncExternalPortStart + slotId}/vnc_lite.html?autoconnect=true&resize=scale&show_dot=false&showControlBar=false`,
    authenticated: false,
    _internalWebPort: slot.webPort,
  };

  slots.set(token, entry);

  log(`Browser ready: ${sessionName} -> VNC :${slot.webPort} (external ${config.pool.vncExternalPortStart + slotId})`);

  return {
    token,
    sessionName,
    vncUrl: entry.vncUrl,
    vncPort: config.pool.vncExternalPortStart + slotId,
    display: slot.display,
    workingStableMs,
  };
}

// ============================================
// Cleanup
// ============================================

export function cleanup(token) {
  const entry = slots.get(token);
  if (!entry || entry.status === 'cleaned') return;
  entry.status = 'cleaned';
  log(`Cleaning up: ${entry.sessionName}`);

  if (entry._monitorInterval) {
    clearInterval(entry._monitorInterval);
    entry._monitorInterval = null;
  }

  try { if (entry.processes.chromium) entry.processes.chromium.kill('SIGKILL'); } catch (e) {}
  try { if (entry.processes.x11vnc) entry.processes.x11vnc.kill('SIGKILL'); } catch (e) {}
  try { if (entry.processes.novnc) entry.processes.novnc.kill('SIGKILL'); } catch (e) {}
  try { if (entry.processes.xvfb) entry.processes.xvfb.kill('SIGKILL'); } catch (e) {}

  // Clean up lock files
  try {
    if (entry.userDataDir) {
      const files = fs.readdirSync(entry.userDataDir);
      files.forEach(f => {
        if (f.startsWith('Singleton'))
          try { fs.unlinkSync(path.join(entry.userDataDir, f)); } catch (e) {}
      });
    }
  } catch (e) {}

  // Notifica a fila assim que o slot sai de uso; a remocao do Map fica atrasada
  // apenas para status/debug e para dar tempo aos processos encerrarem.
  if (_onSlotFreed) setImmediate(_onSlotFreed);
  setTimeout(() => {
    slots.delete(token);
  }, 5000);
  log(`Cleaned up: ${entry.sessionName}`);
}

// ============================================
// Pool status
// ============================================

export function getPoolStatus() {
  const maxSlots = DYNAMIC_MAX_SLOTS;
  const active = [...slots.values()].filter(s => s.status !== 'cleaned');
  return {
    totalSlots: maxSlots,
    configuredSlots: config.pool.maxSlots,
    active: active.length,
    free: maxSlots - active.length,
    dynamicAutoScale: true,
    connectors: active.map(s => ({
      token: s.token,
      sessionName: s.sessionName,
      status: s.status,
      uptime: Math.floor((Date.now() - s.createdAt) / 1000),
      vncPort: s.slot?.webPort || null,
      authenticated: s.authenticated,
      workingStableMs: s.workingStableMs || WORKING_STABLE_MS,
    })),
  };
}

// ============================================
// Startup cleanup — orfãs WAHA de instância anterior
// ============================================

/**
 * WAHA pode ter 100+ sessões e o display é um slot temporário do VNC,
 * não um lock fixo. Só loga as sessões existentes como info — não deleta
 * nada porque WAHA gerencia suas próprias sessões independentemente.
 */
export async function startupCleanup() {
  log("Startup cleanup: WAHA gerencia suas próprias sessões, wa-connect não interfere.");
  log("Startup cleanup: display é slot temporário do VNC, não lock fixo na sessão WAHA.");
}


// ============================================
// Periodic cleanup (idle timeout + stale sessions)
// ============================================

export function startCleanupInterval() {
  const { noClientTimeout, maxTotalSlotTime } = getIdleTimeoutConfig();
  const checkInterval = config.idle?.checkInterval || 15000;

  setInterval(() => {
    const now = Date.now();

    for (const [token, entry] of slots.entries()) {
      if (entry.status === 'cleaned') continue;

      // Hard limit: max total slot time
      if (now - entry.createdAt > maxTotalSlotTime) {
        log(`Hard limit reached for ${entry.sessionName} (${Math.floor((now - entry.createdAt) / 1000)}s), cleaning up`);
        cleanup(token);
        continue;
      }

      // Cleanup por idle NO-CLIENT e DESATIVADO durante pareamento (waiting_qr /
      // display_allocated nao autenticada): hasVncClientConnection=false NAO pode
      // limpar o slot enquanto o scan esta em andamento (evita abort do VNC/QR).
      // Cleanup ocorre apenas por: cancelamento explicito, sessao removida,
      // WORKING apos grace, ou hard-timeout (maxTotalSlotTime).

      // Stale unauthenticated sessions (fallback, already handled by maxAuthWait in index.js)
      if (!entry.authenticated && now - entry.createdAt > config.scan.maxAuthWait) {
        log(`Auth timeout for ${entry.sessionName}, cleaning up`);
        cleanup(token);
      }
    }
  }, checkInterval);
}
