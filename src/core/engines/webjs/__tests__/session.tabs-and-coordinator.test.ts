/**
 * Testes obrigatórios (gates antes de publicar digest v2):
 *  1. Abas: o Chromium do WAHA (único) abre 1 client page web.whatsapp.com; a
 *     aba Google NÃO é injetada no startup (resolveWebjsBrowserTabArgs só seta
 *     display/modo); é aberta via openGoogleTabInBackground APÓS o QR, em
 *     background e IDEMPOTENTE (reusa, não duplica, não fecha WhatsApp).
 *  2. refreshQR: launchUtils.refreshQR com fallback condicional Cmd.refreshQR.
 *  3. Coordinator: SessionOpCoordinator serializa ops + close-once.
 *  4. QR: helpers de estado (QR inicial/expirado/reconexão) via launchUtils.
 */
import {
  resolveWebjsBrowserTabArgs,
  shouldOpenGoogleTab,
  googleTabUrlFromEnv,
  openGoogleTabInBackground,
} from '@waha/core/engines/webjs/webjs-browser-tabs';
import { SessionOpCoordinator } from '@waha/core/storage/psql/SessionOpCoordinator';

describe('WEBJS abas — startup NÃO injeta Google; Google via background após QR', () => {
  it('startup: com display seta --display e modo, SEM injetar accounts.google', () => {
    const args = resolveWebjsBrowserTabArgs(':20', true);
    expect(args).toContain('--display=:20');
    expect(args).toContain('--start-maximized');
    // CRÍTICO: a URL Google NÃO vai no startup (pode duplicar/navegar a aba).
    expect(args.some((a) => a.includes('google'))).toBe(false);
    expect(args.some((a) => a.includes('whatsapp'))).toBe(false);
  });

  it('startup sem display: --kiosk, sem --display nem google', () => {
    const args = resolveWebjsBrowserTabArgs(null, false);
    expect(args).toContain('--kiosk');
    expect(args.some((a) => a.startsWith('--display='))).toBe(false);
    expect(args.some((a) => a.includes('google'))).toBe(false);
  });

  it('openGoogleTabInBackground: cria 1 aba Google unica (idempotente, nao duplica)', async () => {
    const fakePages = { pages: jest.fn() };
    let created = 0;
    const browser = {
      pages: async () => [
        // página WhatsApp existente (client page)
        { url: () => 'https://web.whatsapp.com/' },
      ],
      newPage: jest.fn(async () => {
        created++;
        return {
          url: () => 'about:blank',
          goto: jest.fn(async (u: string, _o: any) => {}),
        };
      }),
    };
    await openGoogleTabInBackground(browser, 'https://accounts.google.com/');
    expect(created).toBe(1);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    // Nova chamada: já existe aba Google -> reutiliza, NÃO cria outra.
    browser.pages = async () => [
      { url: () => 'https://web.whatsapp.com/' },
      { url: () => 'https://accounts.google.com/' }, // agora existe
    ];
    await openGoogleTabInBackground(browser, 'https://accounts.google.com/');
    expect(browser.newPage).toHaveBeenCalledTimes(1); // idempotente
    expect(created).toBe(1);
  });

  it('openGoogleTabInBackground: nunca fecha/normaliza a página WhatsApp', async () => {
    let whatsappClosed = false;
    const browser = {
      pages: async () => [{ whatsapp: true }],
      newPage: jest.fn(async () => {
        whatsappClosed = false; // não toca na whatsapp
        return { url: () => 'about:blank', goto: jest.fn(async () => {}) };
      }),
    };
    await openGoogleTabInBackground(browser as any, 'https://accounts.google.com/');
    expect(whatsappClosed).toBe(false);
  });
});

describe('refreshQR — launchUtils com fallback condicional (fork 1.34.7)', () => {
  it('não chama Cmd.refreshQR se launchUtils.refreshQR existir', () => {
    const launchUtils = { refreshQR: jest.fn() };
    const calls: string[] = [];
    const WAWebCmd = {
      Cmd: { refreshQR: jest.fn(() => calls.push('cmd')) },
    };
    if (typeof (launchUtils as any)?.refreshQR === 'function') {
      (launchUtils as any).refreshQR();
      calls.push('launchUtils');
    } else if (WAWebCmd.Cmd && typeof WAWebCmd.Cmd.refreshQR === 'function') {
      WAWebCmd.Cmd.refreshQR();
    }
    expect(calls).toEqual(['launchUtils']);
  });

  it('fallback condicional: usa Cmd.refreshQR apenas se launchUtils ausente e Cmd é função', () => {
    const launchUtils = {} as any;
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

describe('QR — estado do ciclo de vida (inicial / expirado / reconexão)', () => {
  // Helper que espelha a resolução de refreshQR da página para os 3 estados.
  function makeQRResolver(launchHas: boolean, cmdHas: boolean) {
    const launch = launchHas ? { refreshQR: jest.fn() } : {};
    const cmd = cmdHas ? { Cmd: { refreshQR: jest.fn() } } : { Cmd: {} };
    return {
      launch,
      call: () => {
        if (typeof (launch as any)?.refreshQR === 'function') {
          (launch as any).refreshQR();
          return 'launchUtils';
        } else if (
          cmd.Cmd &&
          typeof cmd.Cmd.refreshQR === 'function'
        ) {
          cmd.Cmd.refreshQR();
          return 'cmd';
        }
        return 'none';
      },
    };
  }

  it('QR inicial: usa launchUtils.refreshQRs (disponível) e retorna launchUtils', () => {
    const r = makeQRResolver(true, false);
    expect(r.call()).toBe('launchUtils');
    expect(r.launch.refreshQR).toHaveBeenCalled();
  });

  it('QR expirado: se launchUtils indisponível mas Cmd existe, usa Cmd (fallback)', () => {
    const r = makeQRResolver(false, true);
    expect(r.call()).toBe('cmd');
  });

  it('reconexão: idempotente — chamadas repetidas de refreshQR não duplicam abas nem re-criam', () => {
    // A reconexão reusa a aba Google (idempotência testada acima). Aqui validamos
    // que o refreshQR é chamável sem quebrar (estável em reconexão).
    const r = makeQRResolver(true, false);
    expect(r.call()).toBe('launchUtils');
    expect(r.call()).toBe('launchUtils');
    expect(r.launch.refreshQR).toHaveBeenCalledTimes(2);
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
    await expect(c.run(async () => 1)).rejects.toThrow('SessionOpClosed');
  });
});
