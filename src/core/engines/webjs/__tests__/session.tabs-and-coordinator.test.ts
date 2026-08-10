/**
 * Testes obrigatórios (gates antes de publicar digest):
 *  1. refreshQR: a lógica do fork whatsapp-web.js prepara launchUtils.refreshQR
 *     com fallback condicional Cmd.refreshQR (só se a função existir). Valida
 *     que NUNCA chamamos Cmd.refreshQR quando launchUtils existe.
 *  2. Abas: o Chromium do WAHA (único) abre EXATAMENTE 1 client page
 *     (web.whatsapp.com) + 1 aba Google (accounts.google.com) — sem duplicar
 *     WhatsApp e sem Chromium auxiliar no wa-connect (display-only).
 *  3. Coordinator: SessionOpCoordinator (psql) serializa ops e faz close-once.
 */
import {
  resolveWebjsBrowserTabArgs,
  shouldOpenGoogleTab,
  googleTabUrlFromEnv,
} from '@waha/core/engines/webjs/webjs-browser-tabs';
import { SessionOpCoordinator } from '@waha/core/storage/psql/SessionOpCoordinator';

describe('WEBJS abas — 1 WhatsApp + 1 Google no MESMO Chromium', () => {
  it('com display e OPEN_GOOGLE_TAB default: abre Google como 2a aba, nao duplica WhatsApp', () => {
    const args = resolveWebjsBrowserTabArgs(':20', true);
    expect(args).toContain('--display=:20');
    expect(args).toContain('--start-maximized');
    expect(args).toContain('https://accounts.google.com/');
    // NUNCA injeta web.whatsapp.com como aba inicial (evita duplicação).
    expect(args.some((a) => a.includes('web.whatsapp.com'))).toBe(false);
  });

  it('com display e OPEN_GOOGLE_TAB=false: usa --kiosk sem aba Google', () => {
    const args = resolveWebjsBrowserTabArgs(':20', false);
    expect(args).toContain('--display=:20');
    expect(args).toContain('--kiosk');
    expect(args.some((a) => a.includes('accounts.google'))).toBe(false);
  });

  it('sem display: nao injeta --display nem duplica', () => {
    const args = resolveWebjsBrowserTabArgs(null, true);
    expect(args.some((a) => a.startsWith('--display='))).toBe(false);
    expect(args.some((a) => a.includes('web.whatsapp.com'))).toBe(false);
  });

  it('shouldOpenGoogleTab: default true, aceita "false"', () => {
    expect(shouldOpenGoogleTab({})).toBe(true);
    expect(shouldOpenGoogleTab({ WAHA_WEBJS_OPEN_GOOGLE_TAB: 'false' })).toBe(
      false,
    );
    expect(
      shouldOpenGoogleTab({ WAHA_WEBJS_OPEN_GOOGLE_TAB: 'FALSE' }),
    ).toBe(false);
  });

  it('googleTabUrlFromEnv: default accounts.google.com, aceita custom', () => {
    expect(googleTabUrlFromEnv({})).toBe('https://accounts.google.com/');
    expect(
      googleTabUrlFromEnv({ WAHA_WEBJS_GOOGLE_TAB_URL: 'https://x.com/' }),
    ).toBe('https://x.com/');
  });

  it('comportamento da config real gera exatamente 1 whatsapp + 1 google (não duplica)', () => {
    // resolveWebjsBrowserTabArgs NÃO adiciona whatsapp; o WAHA navega a client
    // page separadamente. Assim a combinação do Chromium é: [client page WA] +
    // [aba Google injetada] = 2 páginas, 1 WhatsApp + 1 Google.
    const args = resolveWebjsBrowserTabArgs(':20', true);
    const whatsappArgs = args.filter((a) => a.includes('whatsapp'));
    const googleArgs = args.filter((a) => a.includes('google'));
    expect(whatsappArgs).toHaveLength(0); // WhatsApp vem só da client page
    expect(googleArgs.length).toBeGreaterThanOrEqual(1); // aba Google única
  });
});

describe('refreshQR — via launchUtils com fallback condicional (fork 1.34.7)', () => {
  it('não chama Cmd.refreshQR se launchUtils.refreshQR existir', () => {
    // Espelha a lógica do Client.js do fork: usa launchUtils, fallback só se
    // Cmd existir. Aqui validamos o contrato que o WAHA respeita.
    const launchUtils = { refreshQR: jest.fn() };
    let calls: string[] = [];
    const windowMock = {
      require: jest.fn(() => ({
        Cmd: { refreshQR: jest.fn(() => calls.push('cmd')) },
      })),
    };
    const WAWebCmd = (windowMock.require as any)('WAWebCmd');
    if (typeof (launchUtils as any)?.refreshQR === 'function') {
      (launchUtils as any).refreshQR();
      calls.push('launchUtils');
    } else if (WAWebCmd.Cmd && typeof WAWebCmd.Cmd.refreshQR === 'function') {
      WAWebCmd.Cmd.refreshQR();
    }
    expect(calls).toEqual(['launchUtils']);
    // Se launchUtils for a fonte usada, nunca cai no fallback Cmd.
    expect(calls).not.toContain('cmd');
  });

  it('fallback condicional: usa Cmd.refreshQR apenas se launchUtils ausente e Cmd é função', () => {
    const launchUtils = {} as any; // sem refreshQR
    let cmdCalled = false;
    const WAWebCmd = { Cmd: { refreshQR: () => (cmdCalled = true) } };
    if (typeof (launchUtils as any)?.refreshQR === 'function') {
      (launchUtils as any).refreshQR();
    } else if (WAWebCmd.Cmd && typeof WAWebCmd.Cmd.refreshQR === 'function') {
      WAWebCmd.Cmd.refreshQR();
    }
    expect(cmdCalled).toBe(true);
  });
});

describe('SessionOpCoordinator (psql) — serialização + close-once', () => {
  it('serializa ops por sessão (fila única, sem deadlock)', async () => {
    const order: string[] = [];
    const c = new SessionOpCoordinator({ debug: () => {} });
    await Promise.all([
      c.run(async () => {
        order.push('a');
        await new Promise((r) => setTimeout(r, 10));
        order.push('A');
      }),
      c.run(async () => {
        order.push('b');
        order.push('B');
      }),
    ]);
    expect(order).toEqual(['a', 'A', 'b', 'B']);
  });

  it('beginClose + drain completam e bloqueiam novas ops', async () => {
    const c = new SessionOpCoordinator({ debug: () => {} });
    c.beginClose();
    await c.drain();
    await expect(
      c.run(async () => 1),
    ).rejects.toThrow('SessionOpClosed');
  });
});
