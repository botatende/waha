// WA Connect Service — Configuração AX41
export default {
  port: parseInt(process.env.PORT || '3001'),
  host: process.env.HOST || '65.108.43.18',

  auth: {
    apiKey: process.env.WA_CONNECT_API_KEY || process.env.WAHA_API_KEY || null,
  },

  waha: {
    apiUrl: process.env.WAHA_API_URL || 'http://localhost:3000',
    apiKey: process.env.WAHA_API_KEY || 'cab4a20cd99b7f8143f29e62952cb9ad6ac750989f1b9062c3e7862e6a19f0b6',
    sessionsDir: process.env.WAHA_SESSIONS_DIR || '/app/.sessions',
  },

  pool: {
    maxSlots: parseInt(process.env.MAX_SLOTS || '10'),
    displayStart: parseInt(process.env.DISPLAY_START || '20'),
    vncRfbStart: parseInt(process.env.VNC_RFB_START || '5920'),
    vncWebStart: parseInt(process.env.VNC_WEB_START || '7020'),
    vncExternalPortStart: parseInt(process.env.VNC_EXTERNAL_PORT_START || '7020'),
    vncExternalHost: process.env.VNC_EXTERNAL_HOST || process.env.HOST || '195.7.7.154',
  },

  scan: {
    timeout: parseInt(process.env.SCAN_TIMEOUT || '300'),
    pollInterval: parseInt(process.env.POLL_INTERVAL || '3000'),
    maxAuthWait: parseInt(process.env.MAX_AUTH_WAIT || '300000'),
  },

  chromium: {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
    userDataDir: process.env.USER_DATA_DIR || '/tmp/wa-profiles',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--mute-audio',
      '--hide-scrollbars',
      '--disable-infobars',
      '--window-size=1280,1024',
      '--window-position=0,0',
      '--force-device-scale-factor=0.8',
    ],
  },
};
