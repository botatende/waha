/**
 * Resolução das abas do Chromium WEBJS (portado do build 17945a2b, funcional).
 *
 * Garante que o Chromium do WAHA (único) abra EXATAMENTE:
 *   - 1 client page: web.whatsapp.com (o WAHA/Puppeteer a navega),
 *   - 1 aba auxiliar: accounts.google.com (por padrão),
 * ambos no MESMO Chromium. O wa-connect (open-vnc display-only) NUNCA sobe
 * Chromium próprio; por isso é crítico que aqui o WhatsApp NUNCA seja duplicado
 * como aba inicial (a duplicação era causada por segundo Chromium/página).
 *
 * @param display display config da sessão (ex.: ":20") ou null/quando ausente.
 * @param openGoogle true para abrir a aba Google (default true se display setado).
 * @param googleUrl URL da aba auxiliar Google.
 * @returns args extras a injetar no launch do Chromium.
 */
export function resolveWebjsBrowserTabArgs(
  display: string | null | undefined,
  openGoogle: boolean,
  googleUrl = 'https://accounts.google.com/',
): string[] {
  const args: string[] = [];
  if (display) {
    args.push(`--display=${display}`);
  }
  if (openGoogle) {
    // Abre a 2a aba Google no MESMO Chromium, maximizado (não duplica WhatsApp).
    args.push('--start-maximized');
    args.push(googleUrl);
  } else {
    args.push('--kiosk');
  }
  return args;
}

/** Lê a flag de abrir aba Google a partir do env, com default true. */
export function shouldOpenGoogleTab(env: NodeJS.ProcessEnv): boolean {
  return String(env.WAHA_WEBJS_OPEN_GOOGLE_TAB || 'true').toLowerCase() !== 'false';
}

/** Lê a URL da aba Google a partir do env. */
export function googleTabUrlFromEnv(env: NodeJS.ProcessEnv): string {
  return env.WAHA_WEBJS_GOOGLE_TAB_URL || 'https://accounts.google.com/';
}
