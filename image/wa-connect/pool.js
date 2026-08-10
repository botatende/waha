// WA Connect Service — Pool & Queue (BullMQ + Redis)
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import config from './config.js';
import { startBrowser, cleanup, getSlotInfo, getPoolStatus } from './scanner.js';
import { monitorAuth, extractAuth } from './extractor.js';

const log = (msg) => console.log(`[pool] ${msg}`);

// Redis connection
const connection = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
});

// Queue for scan requests
const scanQueue = new Queue('wa-scan-queue', { connection });

// Active scan sessions cache
const sessions = new Map(); // token -> { status, createdAt, sessionName, resolved }

// Start a scan job
export async function enqueueScan(sessionName, proxyUrl, callbackUrl) {
  const job = await scanQueue.add('scan', {
    sessionName,
    proxyUrl: proxyUrl || null,
    callbackUrl: callbackUrl || null,
  }, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 50,
  });

  const token = job.id;
  sessions.set(token, {
    status: 'queued',
    createdAt: Date.now(),
    sessionName,
    resolved: false,
  });

  log(`Scan queued: ${sessionName} (token: ${token})`);
  return token;
}

// Get scan status
export function getScanStatus(token) {
  const cached = sessions.get(token);
  if (cached) {
    if (cached.status === 'extracted') return { status: 'extracted', sessionName: cached.sessionName };
    if (cached.status === 'error') return { status: 'error', error: cached.error };
    if (cached.status === 'authenticated') return { status: 'authenticated' };
    if (cached.status === 'authenticating') return { status: 'authenticating' };
    return {
      status: cached.status,
      expiresIn: Math.max(0, Math.floor((config.scan.maxAuthWait - (Date.now() - cached.createdAt)) / 1000)),
    };
  }

  // Check scanner for browser status
  const slotInfo = getSlotInfo(token);
  if (slotInfo) {
    return {
      status: slotInfo.authenticated ? 'authenticated' : 'waiting_qr',
      vncUrl: slotInfo.vncUrl,
      expiresIn: Math.max(0, Math.floor((config.scan.maxAuthWait - (Date.now() - slotInfo.createdAt)) / 1000)),
    };
  }

  return { status: 'unknown' };
}

// Worker processes the scan queue
const worker = new Worker('wa-scan-queue', async (job) => {
  const { sessionName, proxyUrl } = job.data;
  const token = job.id;
  log(`Processing scan: ${sessionName}`);

  const cached = sessions.get(token);
  if (!cached) throw new Error('Session cache not found');

  try {
    cached.status = 'starting';

    // Start browser
    const browserInfo = await startBrowser(token, sessionName, proxyUrl);
    cached.status = 'waiting_qr';
    log(`Browser running for ${sessionName}: VNC on :${browserInfo.vncPort}`);

    const slotInfo = getSlotInfo(token);
    if (!slotInfo) throw new Error('Slot info not found after browser start');

    // Auto-monitor for auth detection (non-blocking for the worker)
    monitorAuth(token, slotInfo)
      .then((authResult) => {
        log(`Auth detected for ${sessionName}! Method: ${authResult.method}`);
        cached.status = 'authenticated';

        // Auto-extract
        return extractAuth(token, slotInfo)
          .then((extractResult) => {
            log(`Extraction complete for ${sessionName}`);
            cached.status = 'extracted';
            cached.resolved = true;
            return extractResult;
          });
      })
      .then(() => {
        // Clean up browser
        cleanup(token);
      })
      .catch((err) => {
        log(`Auth/extraction error for ${sessionName}: ${err.message}`);
        cached.status = 'error';
        cached.error = err.message;
        cleanup(token);
      });

    return browserInfo;
  } catch (e) {
    cached.status = 'error';
    cached.error = e.message;
    log(`Scan failed for ${sessionName}: ${e.message}`);
    throw e;
  }
}, {
  connection,
  concurrency: config.pool.maxSlots,
  lockDuration: config.scan.timeout * 1000,
});

worker.on('completed', (job) => {
  log(`Scan job started: ${job.data.sessionName}`);
});

worker.on('failed', (job, err) => {
  log(`Scan job failed: ${job.data.sessionName} - ${err.message}`);
});

// Pool metrics
export async function getMetrics() {
  const waiting = await scanQueue.getWaitingCount();
  const active = await scanQueue.getActiveCount();
  return {
    pool: getPoolStatus(),
    queue: { waiting, active },
  };
}

export { connection };
