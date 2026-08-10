// WA Connect Service — Auth Monitor & Extractor v3
// Baseado no script que funcionou nos testes da CX33
// Polls Chromium profile for WhatsApp auth data. When found:
// 1. Kills Chromium to flush writes
// 2. Copies profile to WAHA directory
// 3. Syncs to Contabo WAHA WebJS via SCP
// 4. Creates session via WAHA API on Contabo

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const log = (msg) => console.log(`[extractor] ${msg}`);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function monitorAuth(token, slotInfo, config) {
  return new Promise(async (resolve, reject) => {
    const timeout = config.scan.maxAuthWait;
    const startTime = Date.now();
    const lsDir = path.join(slotInfo.userDataDir, "Default", "Local Storage", "leveldb");
    const idbBase = path.join(slotInfo.userDataDir, "Default", "IndexedDB");

    log(`Monitorando auth para ${slotInfo.sessionName}`);

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeout) {
        clearInterval(interval);
        reject(new Error("Auth detection timeout"));
        return;
      }

      // Check 1: LocalStorage — WANoise + WAToken
      try {
        if (fs.existsSync(lsDir)) {
          const files = fs.readdirSync(lsDir);
          for (const file of files) {
            if (!file.endsWith(".log") && !file.endsWith(".ldb")) continue;
            try {
              const buf = fs.readFileSync(path.join(lsDir, file));
              if (buf.indexOf("WANoise") >= 0 && buf.indexOf("WAToken") >= 0) {
                clearInterval(interval);
                log(`Auth (LocalStorage) ${slotInfo.sessionName}`);
                slotInfo.authenticated = true;
                slotInfo.authMethod = "localstorage";
                resolve({ method: "localstorage" });
                return;
              }
            } catch (e) {}
          }
        }
      } catch (e) {}

      // Check 2: IndexedDB — keyPair + identity
      // Também suporta novos marcadores pós-passkey (DbEncKey, bulkCreateIdentity, token exchange)
      try {
        if (fs.existsSync(idbBase)) {
          const dbDirs = fs.readdirSync(idbBase);
          for (const dir of dbDirs) {
            const idbDir = path.join(idbBase, dir);
            if (!fs.statSync(idbDir).isDirectory()) continue;
            const idbLevel = path.join(idbDir, "leveldb");
            if (!fs.existsSync(idbLevel)) continue;
            const files = fs.readdirSync(idbLevel);
            
            // Multi-marker detection
            let fKP = false, fId = false, fEnc = false, fToken = false;
            for (const f of files) {
              if (!f.endsWith(".log") && !f.endsWith(".ldb")) continue;
              try {
                const buf = fs.readFileSync(path.join(idbLevel, f));
                if (buf.indexOf("keyPair") >= 0 || buf.indexOf("encKey") >= 0 || buf.indexOf("DbEncKey") >= 0) {
                  fKP = true;
                  fEnc = true;
                }
                if (buf.indexOf("identity") >= 0 || buf.indexOf("bulkCreateIdentity") >= 0) fId = true;
                if (buf.indexOf("token exchange succeeded") >= 0) fToken = true;
              } catch (e) {}
            }
            
            // Auth: keyPair + identity OR DbEncKey + identity OR token exchange + encKey
            if ((fKP || fEnc) && fId) {
              clearInterval(interval);
              log(`Auth (IndexedDB) ${slotInfo.sessionName} (key/enc=${fKP||fEnc}, identity=${fId})`);
              slotInfo.authenticated = true;
              slotInfo.authMethod = "indexeddb";
              resolve({ method: "indexeddb" });
              return;
            }
            if (fToken && (fEnc || fKP)) {
              clearInterval(interval);
              log(`Auth (IndexedDB/token) ${slotInfo.sessionName} (tokenSuccess=${fToken})`);
              slotInfo.authenticated = true;
              slotInfo.authMethod = "indexeddb_token";
              resolve({ method: "indexeddb" });
              return;
            }
          }
        }
      } catch (e) {}
    }, config.scan.pollInterval || 3000);
  });
}

export async function extractAndInject(token, slotInfo, config) {
  log(`Extraindo e injetando ${slotInfo.sessionName}...`);

  // 1. Mata Chromium (flush writes)
  try {
    execSync(`pkill -f "chromium.*${slotInfo.userDataDir}" 2>/dev/null`);
  } catch (e) {}
  await sleep(3000);

  // 2. Remove Singleton locks
  try {
    const files = fs.readdirSync(slotInfo.userDataDir);
    for (const f of files) {
      if (f.startsWith("Singleton"))
        try { fs.unlinkSync(path.join(slotInfo.userDataDir, f)); } catch (e) {}
    }
  } catch (e) {}

  // 3. Cria dir WAHA e copia profile
  const wsd = config.waha.sessionsDir + "/webjs/" + slotInfo.safeName;
  const wpd = wsd + "/session-" + slotInfo.safeName;
  fs.mkdirSync(wsd, { recursive: true });

  try {
    execSync(`rm -rf ${wpd} 2>/dev/null; cp -a ${slotInfo.userDataDir} ${wpd}`);
    log(`Profile copiado p/ ${wpd}`);
  } catch (e) {
    throw new Error("Falha copiar profile: " + e.message);
  }

  // 4. Config .waha.session.config.json
  fs.writeFileSync(
    path.join(wsd, ".waha.session.config.json"),
    JSON.stringify({
      webjs: { tagsEventsOn: false },
      _connectorProfile: wpd,
    })
  );

  // 5. SCP sync to Contabo WAHA WebJS PVC
  log("Syncing profile to Contabo WAHA WebJS...");
  try {
    const contSsh = "ssh -i /root/.ssh/contabo_ed25519_sync -o StrictHostKeyChecking=no";
    const contHost = "root@195.7.7.154";
    const pvcPath = `/var/snap/microk8s/common/default-storage/wahab-waha-noweb-pvc-pvc-13269bea-4125-4173-be93-a12736121508/webjs/${slotInfo.safeName}/session-${slotInfo.safeName}`;

    execSync(`${contSsh} ${contHost} "mkdir -p $(dirname ${pvcPath})" 2>/dev/null`, { stdio: "pipe" });
    execSync(
      `scp -i /root/.ssh/contabo_ed25519_sync -o StrictHostKeyChecking=no -r ${wpd} ${contHost}:${pvcPath}`,
      { stdio: "pipe", timeout: 120000 }
    );
    log(`Profile synced to Contabo: ${pvcPath}`);
  } catch (e) {
    log(`Warning: Contabo sync failed: ${e.message}`);
    // Continua mesmo se sync falhar — WAHA pode ler local se configurado
  }

  // 6. WAHA API — deleta existente + cria nova no Contabo WebJS
  log("Criando sessao WAHA no Contabo WebJS...");
  try {
    await fetch(`${config.waha.apiUrl}/api/sessions/${slotInfo.safeName}`, {
      method: "DELETE",
      headers: { "X-Api-Key": config.waha.apiKey },
    });
    log(`Deleted existing session ${slotInfo.safeName}`);
  } catch (e) {
    log(`No existing session to delete: ${e.message}`);
  }
  await sleep(1500);

  const resp = await fetch(`${config.waha.apiUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": config.waha.apiKey },
    body: JSON.stringify({
      name: slotInfo.safeName,
      config: { webjs: { tagsEventsOn: false } },
      start: true,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`WAHA create falhou: ${resp.status} ${text.slice(0, 200)}`);
  }

  log(`Sessao ${slotInfo.safeName} criada!`);
  return {
    sessionName: slotInfo.safeName,
    wahaSessionDir: wsd,
    wahaProfileDir: wpd,
    authMethod: slotInfo.authMethod || "unknown",
  };
}
