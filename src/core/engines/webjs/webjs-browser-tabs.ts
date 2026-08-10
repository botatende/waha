/**
 * Resolução das abas do Chromium WEBJS (WEBJS 1 WhatsApp + 1 Google).
 *
 * O Chromium do WAHA é o ÚNICO dono da página web.whatsapp.com (client page)
 * e também hospeda UMA aba Google (accounts.google.com) no MESMO browser.
 * O wa-connect (open-vnc display-only) NUNCA sobe Chromium próprio.
 *
 * Estratégia (pós-diagnóstico):
 *  - A URL Google NÃO é injetada no startup (evita que o Puppeteer navegue a
 *    única aba para web.whatsapp e "com a Google" ou duplique). O WhatsApp abre
 *    primeiro e o QR renderizado é o evento que dispara a 2a aba Google.
 *  - A aba Google é criada DEPOIS do QR, em background, de forma IDEMPOTENTE:
 *    se já existe uma página Google no browser, REUTILIZA (nunca duplica, nunca
 *    normaliza, nunca fecha a página WhatsApp).
 *
 * @param display display config da sessão (ex.: ":20") ou null.
 * @param openGoogle flag (default true) indicando se a aba Google é desejada.
 * @returns args extras no launch do Chromium (display + modo, SEM url Google).
 */
export function resolveWebjsBrowserTabArgs(
  display: string | null | undefined,
  openGoogle: boolean,
): string[] {
  const args: string[] = [];
  if (display) {
    args.push(`--display=${display}`);
  }
  // Modo de janela SEM injetar a URL Google no startup (a aba Google é aberta
  // via openGoogleTabInBackground após o QR renderizado).
  args.push(openGoogle ? '--start-maximized' : '--kiosk');
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

/**
 * Abre (ou reutiliza) UMA aba Google em background no MESMO Chromium.
 * Idempotente: se já existe uma página cuja URL aponta para o domínio alvo,
 * apenas a foca/recarrega se necessário; NUNCA cria uma segunda página Google
 * nem toca na página WhatsApp.
 *
 * @param browser Puppeteer Browser (this.whatsapp.pupBrowser).
 * @param url URL da aba Google (default accounts.google.com).
 */
export async function openGoogleTabInBackground(browser: any, url: string): Promise<void> {
  if (!browser) return;
  try {
    const pages = await browser.pages();
    // Reutiliza a aba Google existente (idempotente) — não duplica.
    const googlePage = pages.find((p: any) => {
      try {
        const u = p.url() || '';
        return u.includes('accounts.google.com') || u.includes('google.com');
      } catch {
        return false;
      }
    });
    if (googlePage) {
      // Já existe — não recria; garante apenas que não está fechada.
      return;
    }
    // Cria a aba Google em background (não usar bringToFront; evita desviar o
    // foco da página WhatsApp/QR). Sem retries — falha silenciosa.
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    // Sem bringToFront e sem fechar/duplicar o WhatsApp.
  } catch (e) {
    // Non-fatal: a aba Google é auxiliar; se falhar, não bloqueia o QR/scan.
  }
}
