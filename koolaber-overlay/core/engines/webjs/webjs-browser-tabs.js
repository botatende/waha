"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWebjsBrowserTabArgs = resolveWebjsBrowserTabArgs;
exports.shouldOpenGoogleTab = shouldOpenGoogleTab;
exports.googleTabUrlFromEnv = googleTabUrlFromEnv;
exports.openGoogleTabInBackground = openGoogleTabInBackground;
function resolveWebjsBrowserTabArgs(display, openGoogle) {
    const args = [];
    if (display) {
        args.push(`--display=${display}`);
    }
    // FIX tabs visiveis (2026-08-12, cumulativo EXATAMENTE sobre 817dcc38):
    // usar --start-maximized quando a aba Google estiver habilitada (caso managed
    // staging) para MANTER a barra de abas do Chromium visivel e permitir alternar
    // WhatsApp <-> Google. O Google abre em background via openGoogleTabInBackground
    // (idempotente). Soh usa --kiosk quando o Google esta DESABILITADO (fallback).
    args.push(openGoogle ? '--start-maximized' : '--kiosk');
    return args;
}
function shouldOpenGoogleTab(env) {
    return String(env.WAHA_WEBJS_OPEN_GOOGLE_TAB || 'true').toLowerCase() !== 'false';
}
function googleTabUrlFromEnv(env) {
    return env.WAHA_WEBJS_GOOGLE_TAB_URL || 'https://accounts.google.com/';
}
async function openGoogleTabInBackground(browser, url) {
    if (!browser)
        return;
    try {
        const pages = await browser.pages();
        const googlePage = pages.find((p) => {
            try {
                const u = p.url() || '';
                return u.includes('accounts.google.com') || u.includes('google.com');
            }
            catch (_a) {
                return false;
            }
        });
        if (googlePage) {
            await bringWhatsAppToFront(browser, pages);
            return;
        }
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
        // Garante WhatsApp em primeiro plano APOS abrir a aba Google em background.
        await bringWhatsAppToFront(browser, await browser.pages());
    }
    catch (e) {
    }
}
// Re-foca a pagina WhatsApp (web.whatsapp.com) apos a Google abrir em background.
// Usa Page.bringToFront() padrao (nao experimental, nao destrutivo); nunca cria,
// feha ou normaliza abas; WhatsApp permanece a aba ativa de primeiro plano.
async function bringWhatsAppToFront(browser, pages) {
    try {
        const list = pages || (await browser.pages());
        const wa = list.find((p) => {
            try {
                const u = p.url() || '';
                return u.includes('web.whatsapp.com');
            }
            catch (_a) {
                return false;
            }
        });
        if (wa && typeof wa.bringToFront === 'function') {
            await wa.bringToFront();
        }
    }
    catch (_a) {
        // non-fatal
    }
}
//# sourceMappingURL=webjs-browser-tabs.js.map
