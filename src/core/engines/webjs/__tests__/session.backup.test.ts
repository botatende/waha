/**
 * Testes obrigatórios v8 — orquestração da persistência da auth no PostgreSQL.
 * (foca no comportamento de ORQUESTRAÇÃO; compressão/zip é mockada)
 *   1. backup imediato: ensureInitialBackup grava e, só se arquivo existir,
 *      retorna true (marca persistida).
 *   2. eventos duplicados (AUTHENTICATED/READY) NÃO duplicam gravação (single-flight).
 *   3. falha + retry: não marca persistida até o arquivo existir no store.
 *   4. flush no shutdown (destroy) chama o backup final.
 *   5. logout remove a auth; stop/start preserva (delete só no logout).
 */
import { RemoteAuth } from '@waha/core/engines/webjs/RemoteAuth';

function makeFakeLogger() {
  return {
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
    child: () => makeFakeLogger(),
  };
}

async function newRemoteAuth(store: any) {
  const ra: any = new (RemoteAuth as any)({
    clientId: 'test',
    store,
    backupSyncIntervalMs: 60000,
    logger: makeFakeLogger(),
    zipper: { compress: jest.fn() },
    coordinator: null,
  });
  // Pula compressão/fs reais: sobrescreve storeRemoteSession p/ contabilizar o save.
  ra._saved = 0;
  const originalStoreRemote = ra.storeRemoteSession.bind(ra);
  ra.storeRemoteSession = async () => {
    ra._saved++;
    await store.save({ session: ra.sessionName });
  };
  return ra;
}

describe('v8 — persistência da auth (RemoteAuth) — orquestração', () => {
  it('backup imediato: grava e só marca persistida se arquivo existe no store', async () => {
    let exists = false;
    const store = {
      save: jest.fn(async () => { exists = true; }),
      sessionExists: jest.fn(async () => exists),
      extract: jest.fn(), delete: jest.fn(),
    };
    const ra = await newRemoteAuth(store);
    const persisted = await ra.ensureInitialBackup();
    expect(persisted).toBe(true);
    expect(store.save).toHaveBeenCalled();
    expect(store.sessionExists).toHaveBeenCalled();
  });

  it('eventos duplicados (AUTHENTICATED/READY) não duplicam gravação (single-flight)', async () => {
    let saveCount = 0;
    const store = {
      save: jest.fn(async () => { saveCount++; }),
      sessionExists: jest.fn(async () => true),
      extract: jest.fn(), delete: jest.fn(),
    };
    const ra = await newRemoteAuth(store);
    // 3 chamadas concorrentes → mesma promise (1 gravação)
    const results = await Promise.all([
      ra.ensureInitialBackup(), ra.ensureInitialBackup(), ra.ensureInitialBackup(),
    ]);
    expect(results[0]).toBe(true);
    expect(store.save).toHaveBeenCalledTimes(1); // single-flight
  });

  it('falha: não marca persistida até arquivo existir (retry com backoff)', async () => {
    let exists = false;
    const store = {
      save: jest.fn(async () => {}),
      sessionExists: jest.fn(async () => exists),
      extract: jest.fn(), delete: jest.fn(),
    };
    const ra = await newRemoteAuth(store);
    const p = ra.ensureInitialBackup();
    // após ~200ms ainda retentando (backoff 2s) → não resolveu true
    const early = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 220))]);
    expect(early).toBe('pending');
    // só depois que o arquivo aparece no store, resolve true
    setTimeout(() => { exists = true; }, 2600);
    const persisted = await p;
    expect(persisted).toBe(true);
  }, 15000);

  it('flush no shutdown (destroy) dispara o backup final', async () => {
    const store = {
      save: jest.fn(async () => {}),
      sessionExists: jest.fn(async () => true),
      extract: jest.fn(), delete: jest.fn(),
    };
    const ra = await newRemoteAuth(store);
    const before = ra._saved;
    await ra.destroy();
    expect(ra._saved).toBeGreaterThanOrEqual(before + 1); // flush gravou
  });

  it('logout remove auth (delete); stop/start preserva (sem delete)', async () => {
    const del = jest.fn();
    const store = {
      save: jest.fn(async () => {}),
      sessionExists: jest.fn(async () => true),
      extract: jest.fn(), delete: del,
    };
    const ra = await newRemoteAuth(store);
    // destroy (stop/restart) NÃO apaga
    await ra.destroy();
    expect(del).not.toHaveBeenCalled();
    // logout → disconnect → deleteRemoteSession apaga
    await ra.disconnect();
    expect(del).toHaveBeenCalled();
  }, 15000);
});
