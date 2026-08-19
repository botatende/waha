/**
 * Resolução das abas do Chromium WEBJS (WEBJS 1 WhatsApp + 1 Google).
 *
 * O Chromium do WAHA é o ÚNICO dono da página web.whatsapp.com (client page)
 * e também hospeda UMA aba Google (accounts.google.com) no MESMO browser.
 * O wa-connect (open-vnc display-only) NUNCA sobe Chromium próprio.
 *
 * FIX tabs visiveis (2026-08-12, cumulativo EXATAMENTE sobre 817dcc38):
 *  - Removido o --kiosk incondicional que escondia a barra de abas.
 *  - Com a aba Google habilitada (managed staging) usa --start-maximized para
 *    MANTER a barra de abas visivel (alternar WhatsApp <-> Google).
 *  - A aba Google abre em background e idempotente; APOS abrir, re-foca a aba
 *    WhatsApp (Page.bringToFront padrao, nao experimental/destrutiva) para que
 *    o WhatsApp permaneça a aba ativa de primeiro plano (o browser.newPage do
 *    Puppeteer, se usado desacompanhado, roubaria o foco para a Google).
 *  - Sem Google habilitado, mantem --kiosk (fallback/contrato original).
 *
 * @param display display config da sessão (ex.: ":20") ou null.
 * @param openGoogle flag (default true) indicando se a aba Google é desejada.
 * @returns args extras no launch do Chromium (display + modo).
 */
export function resolveWebjsBrowserTabArgs(
  display: string | null | undefined,
  openGoogle: boolean,
): string[] {
  const args: string[] = [];
  if (display) {
    args.push(`--display=${display}`);
  }
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

/** Re-foca a página WhatsApp (web.whatsapp.com), mantendo-a a aba ativa. */
async function bringWhatsAppToFront(
  browser: any,
  pages?: any[],
  preferred?: any,
): Promise<void> {
  try {
    const list = pages || (await browser.pages());
    const wa = preferred || list.find((p: any) => {
      try {
        const u = p.url() || '';
        return u.includes('web.whatsapp.com');
      } catch {
        return false;
      }
    });
    if (wa && typeof wa.bringToFront === 'function') {
      await wa.bringToFront();
    }
  } catch {
    // non-fatal
  }
}

/**
 * Abre (ou reutiliza) UMA aba Google em background no MESMO Chromium e garante
 * que o WhatsApp volta a ser a aba ativa de primeiro plano.
 * Idempotente: se já existe uma página cujo domínio é o alvo, reutiliza; NUNCA
 * cria segunda página Google. Preserva a primeira página WhatsApp existente e
 * fecha somente páginas WhatsApp excedentes, evitando o segundo QR no startup.
 * Não usa Target.createTarget nem APIs experimentais.
 *
 * @param browser Puppeteer Browser (this.whatsapp.pupBrowser).
 * @param url URL da aba Google (default accounts.google.com).
 */
export async function openGoogleTabInBackground(browser: any, url: string): Promise<void> {
  if (!browser) return;
  try {
    const pages = await browser.pages();
    const primaryWhatsAppPage = await keepSingleWhatsAppPage(pages);
    const googlePage = pages.find((p: any) => {
      try {
        const u = p.url() || '';
        return u.includes('accounts.google.com') || u.includes('google.com');
      } catch {
        return false;
      }
    });
    if (googlePage) {
      await bringWhatsAppToFront(browser, await browser.pages(), primaryWhatsAppPage);
      return;
    }
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    const updatedPages = await browser.pages();
    const keptWhatsAppPage = await keepSingleWhatsAppPage(updatedPages, primaryWhatsAppPage);
    await bringWhatsAppToFront(browser, await browser.pages(), keptWhatsAppPage);
  } catch (e) {
    // Non-fatal: a aba Google é auxiliar; se falhar, não bloqueia o QR/scan.
  }
}

/** Preserva a página WhatsApp principal e fecha somente duplicatas excedentes. */
async function keepSingleWhatsAppPage(pages: any[], preferred?: any): Promise<any | undefined> {
  const whatsappPages = pages.filter((p: any) => {
    try {
      return String(p.url?.() || '').includes('web.whatsapp.com');
    } catch {
      return false;
    }
  });
  const keep = preferred && whatsappPages.includes(preferred) ? preferred : whatsappPages[0];
  for (const page of whatsappPages) {
    if (page === keep || typeof page.close !== 'function') continue;
    await page.close().catch(() => {});
  }
  return keep;
}
