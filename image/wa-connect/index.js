// WA Connect Service — Browser Helper API
// Chamado pelo Koolaber App para abrir navegador real em sessão WAHA
import http from "http";
import url from "url";
import { v4 as uuid } from "uuid";
import config from "./config.js";
import { startBrowser, allocateDisplay, cleanup, getSlotInfo, getPoolStatus, startCleanupInterval } from "./scanner.js";
import { monitorAuth, extractAndInject } from "./extractor.js";

const log = (msg) => console.log(`[api] ${msg}`);
const sessions = new Map();

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

// Auth middleware: check X-Api-Key header against config
function checkAuth(req, res) {
  if (!config.auth.apiKey) return true; // no key configured = open
  const headerKey = req.headers["x-api-key"];
  if (headerKey === config.auth.apiKey) return true;
  json(res, 401, { error: "Unauthorized" });
  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
    });
    res.end();
    return;
  }

  const pathname = url.parse(req.url, true).pathname;

  try {
    // =============================================
    //  POST /connect/open-browser
    //  Recebe sessionName, abre navegador com VNC
    //  Frontend usa a vncUrl pra abrir iframe
    // =============================================
    // Auth required for all POST/DELETE endpoints
    if (req.method !== "GET" && !checkAuth(req, res)) return;

    if (req.method === "POST" && pathname === "/connect/open-browser") {
      const body = await parseBody(req);
      const sessionName = body.sessionName || `wa_scan_${Date.now()}`;
      const proxyUrl = body.proxyUrl || null;
      const callbackUrl = body.callbackUrl || null;

      const token = uuid();
      log(`Opening browser for session ${sessionName} (token: ${token})`);

      try {
        const browserInfo = await startBrowser(token, sessionName, proxyUrl);
        const slotInfo = getSlotInfo(token);

        sessions.set(token, {
          status: "waiting_qr",
          sessionName,
          slotInfo,
          createdAt: Date.now(),
          callbackUrl,
        });

        // Auto-detect auth in background (passando config como na CX33)
        monitorAuth(token, slotInfo, config)
          .then(async (authResult) => {
            log(`Auth detected for ${sessionName}!`);
            sessions.set(token, { ...sessions.get(token), status: "authenticated" });
            const result = await extractAndInject(token, slotInfo, config);
            sessions.set(token, { ...sessions.get(token), status: "extracted", ...result });
            cleanup(token);
            // Callback pro App se configurado
            if (callbackUrl) {
              try {
                await fetch(callbackUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ sessionName, token, status: "extracted" }),
                });
              } catch (e) {
                log(`Callback failed: ${e.message}`);
              }
            }
          })
          .catch((err) => {
            log(`Auth error for ${sessionName}: ${err.message}`);
            sessions.set(token, { ...sessions.get(token), status: "error", error: err.message });
            cleanup(token);
          });

        json(res, 200, {
          token,
          sessionName,
          status: "waiting_qr",
          vncUrl: browserInfo.vncUrl,
          vncPort: browserInfo.vncPort,
          expiresIn: config.scan.timeout,
        });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
      return;
    }

    // =============================================
    //  POST /connect/allocate-display
    //  Apenas aloca display (Xvfb + x11vnc + noVNC), sem Chrome
    //  Frontend/App cria sessao WAHA com client.display e conecta VNC
    // =============================================
    if (req.method === "POST" && pathname === "/connect/allocate-display") {
      const body = await parseBody(req);
      const sessionName = body.sessionName || "wa_display_" + Date.now();
      const token = body.token || sessionName;

      log("Allocating display for session " + sessionName + " (token: " + token + ")");

      try {
        const displayInfo = await allocateDisplay(token, sessionName);
        sessions.set(token, {
          status: "display_allocated",
          sessionName,
          createdAt: Date.now(),
        });

        json(res, 200, {
          token,
          sessionName,
          status: "display_allocated",
          vncUrl: displayInfo.vncUrl,
          display: displayInfo.display,
        });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
      return;
    }

    // =============================================
    //  POST /connect/open-vnc
    //  Recebe nome da sessao, aloca/vincula display ao slot, faz merge idempotente
    //  de client.display na config da sessao WAHA (PRESERVANDO webhook/engine/
    //  PostgreSQL) e start/reconnect — NUNCA logout/delete. Retorna VNC URL.
    //  Abra repetido reutiliza o mesmo slot e reaplica o vinculo se ausente.
    // =============================================
    if (req.method === "POST" && pathname === "/connect/open-vnc") {
      const body = await parseBody(req);
      const sessionName = body.sessionName || "wa_vnc_" + Date.now();
      const token = body.token || sessionName;

      log("Opening VNC for session " + sessionName + " (token: " + token + ")");

      try {
        // 1. Alocar display (reutiliza slot vivo da mesma sessao se houver).
        const displayInfo = await allocateDisplay(token, sessionName);
        const displayNum = displayInfo.display; // ex.: 20 (slot)

        // 2. Gravar vinculo sessionName -> display (lifecycle do wa-connect).
        sessions.set(token, {
          status: "display_allocated",
          sessionName,
          display: displayNum,
          createdAt: Date.now(),
        });

        // 3. Merge idempotente: garantir client.display.":" + displayNum na config
        //    da sessao, preservando TODO o restante (webhook, engine, PostgreSQL).
        const wahaBase = new URL(config.waha.apiUrl);
        const sessionPath = "/api/sessions/" + encodeURIComponent(sessionName);

        // 3a. Checar se a sessao ja existe (GET).
        const existing = await new Promise((resolve) => {
          const req2 = http.request({
            hostname: wahaBase.hostname, port: wahaBase.port,
            path: sessionPath, method: "GET",
            headers: { "X-Api-Key": config.waha.apiKey }, timeout: 8000,
          }, (res2) => {
            let d = ""; res2.on("data", (c) => d += c);
            res2.on("end", () => {
              try { resolve({ exists: res2.statusCode === 200, body: JSON.parse(d) }); }
              catch { resolve({ exists: res2.statusCode === 200, body: d }); }
            });
          });
          req2.on("error", () => resolve({ exists: false }));
          req2.end();
        });

        if (existing && existing.exists) {
          // Reconnect: stop -> merge display -> start (NUNCA logout/delete).
          log("open-vnc: sessao existe " + sessionName + " — reconnect com display :" + displayNum);
          await new Promise((resolve) => {
            const r = http.request({
              hostname: wahaBase.hostname, port: wahaBase.port,
              path: sessionPath + "/stop", method: "POST",
              headers: { "X-Api-Key": config.waha.apiKey }, timeout: 8000,
            }, () => { resolve(); }); r.on("error", () => resolve()); r.end();
          });
          // Preserva a config existente e garante client.display (merge idempotente).
          const curConfig = (existing.body && existing.body.config) || {};
          const mergedConfig = Object.assign({}, curConfig, {
            client: Object.assign({}, (curConfig.client || {}), { display: ":" + displayNum }),
          });
          await new Promise((resolve, reject) => {
            const putReq = http.request({
              hostname: wahaBase.hostname, port: wahaBase.port,
              path: sessionPath, method: "PUT",
              headers: { "Content-Type": "application/json", "X-Api-Key": config.waha.apiKey },
            }, (res2) => { let d=""; res2.on("data",(c)=>d+=c); res2.on("end",()=>resolve(d)); });
            putReq.on("error", reject);
            putReq.write(JSON.stringify({ name: sessionName, config: mergedConfig }));
            putReq.end();
          });
          await new Promise((resolve) => {
            const r = http.request({
              hostname: wahaBase.hostname, port: wahaBase.port,
              path: sessionPath + "/start", method: "POST",
              headers: { "X-Api-Key": config.waha.apiKey }, timeout: 8000,
            }, () => { resolve(); }); r.on("error", () => resolve()); r.end();
          });
          log("WAHA session reconnected: " + sessionName + " (display :" + displayNum + ")");
        } else {
          // 3b. Criar sessao nova com client.display.
          const sessionBody = JSON.stringify({
            name: sessionName,
            config: {
              engine: "WEBJS",
              webjs: { tagsEventsOn: false },
              client: { display: ":" + displayNum },
            },
            start: true,
          });
          await new Promise((resolve, reject) => {
            const postReq = http.request({
              hostname: wahaBase.hostname, port: wahaBase.port,
              path: "/api/sessions", method: "POST",
              headers: { "Content-Type": "application/json", "X-Api-Key": config.waha.apiKey },
            }, (postRes) => { let d=""; postRes.on("data",(c)=>d+=c); postRes.on("end",()=>resolve(d)); });
            postReq.on("error", reject);
            postReq.write(sessionBody);
            postReq.end();
          });
          log("WAHA session created: " + sessionName + " (display :" + displayNum + ")");
        }

        json(res, 200, {
          token,
          sessionName,
          status: "display_allocated",
          vncUrl: displayInfo.vncUrl,
          display: displayNum,
        });
      } catch (e) {
        log("open-vnc error: " + e.message);
        json(res, 500, { error: e.message });
      }
      return;
    }

    // =============================================
    //  GET /connect/status/:token
    //  Polling do frontend pra saber status
    // =============================================
    if (req.method === "GET" && pathname.startsWith("/connect/status/")) {
      const token = pathname.split("/")[3];
      const session = sessions.get(token);
      if (!session) {
        json(res, 404, { status: "not_found" });
        return;
      }
      const slotInfo = getSlotInfo(token);
      json(res, 200, {
        status: session.status,
        sessionName: session.sessionName,
        vncUrl: slotInfo?.vncUrl || null,
        error: session.error || null,
      });
      return;
    }

    // =============================================
    //  POST /connect/close/:token
    //  Força fechamento do navegador
    // =============================================
    if (req.method === "POST" && pathname.startsWith("/connect/close/")) {
      const token = pathname.split("/")[3];
      cleanup(token);
      json(res, 200, { status: "closed" });
      return;
    }

    // =============================================
    //  GET /connect/pool — Métricas (requer API key)
    // =============================================
    if (req.method === "GET" && pathname === "/connect/pool") {
      if (!checkAuth(req, res)) return;
      json(res, 200, getPoolStatus());
      return;
    }

    // =============================================
    //  GET /connect/health — Publico (sem auth)
    // =============================================
    if (req.method === "GET" && pathname === "/connect/health") {
      json(res, 200, { status: "ok", uptime: process.uptime() });
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (e) {
    log(`Error: ${e.message}`);
    json(res, 500, { error: e.message });
  }
});

startCleanupInterval();
server.listen(config.port, "0.0.0.0", () => {
  log(`WA Connect Service ready`);
  log(`Port: ${config.port}`);
  log(`Pool: ${config.pool.maxSlots} slots`);
  log(`Auto-extract: ON`);
  log(`WAHA API: ${config.waha.apiUrl}`);
});
