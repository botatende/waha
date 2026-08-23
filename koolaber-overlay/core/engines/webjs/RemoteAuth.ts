import { sleep } from '@waha/utils/promiseTimeout';
import { SinglePeriodicJobRunner } from '@waha/utils/SinglePeriodicJobRunner';
import { SessionOpCoordinator } from '../../storage/psql/SessionOpCoordinator';
import * as path from 'path';
import pino, { Logger } from 'pino';
import { AuthStrategy, Client, Events, Store } from 'whatsapp-web.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prettyBytes = require('pretty-bytes');

/* Require Optional Dependencies */
let fs;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  fs = require('fs-extra');
} catch {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  fs = undefined;
}

async function isValidPath(path: string) {
  try {
    await fs.promises.access(path);
    return true;
  } catch {
    return false;
  }
}

async function getFilesizeInBytes(filename: string) {
  const stats = await fs.promises.lstat(filename).catch(() => null);
  if (!stats) {
    return;
  }
  return stats.size;
}

export interface Zipper {
  compress(path: string, archivePath: string): Promise<void>;

  uncompress(archivePath: string, path: string): Promise<void>;
}

/**
 * Remote-based authentication
 * @param {object} options - options
 * @param {object} options.store - Remote database store instance
 * @param {string} options.clientId - Client id to distinguish instances if you are using multiple, otherwise keep null if you are using only one instance
 * @param {string} options.dataPath - Change the default path for saving session files, default is: "./.wwebjs_auth/"
 * @param {number} options.backupSyncIntervalMs - Sets the time interval for periodic session backups. Accepts values starting from 60000ms {1 minute}
 */
export class RemoteAuth implements AuthStrategy {
  // Required Files & Dirs in WWebJS to restore session
  private REQUIRED_DIRS = ['Default', 'IndexedDB', 'Local Storage'];
  // Initial delay sync required for session to be stable enough to recover
  private INITIAL_DELAY_MS = 60000;

  private readonly clientId: string;
  private readonly dataPath: string;
  private readonly tempDir: string;
  private readonly store: Store;
  private readonly logger: Logger;

  private client: any;
  private userDataDir: string;
  private sessionName: string;
  private backupSyncRunner: SinglePeriodicJobRunner;
  private zipper: Zipper;
  private coordinator: SessionOpCoordinator | null;

  constructor(
    { clientId, dataPath, store, backupSyncIntervalMs, logger, zipper, coordinator }: any = {},) {
    if (!fs)
      throw new Error(
        'Optional Dependencies [fs-extra] are required to use RemoteAuth. Make sure to run npm install correctly and remove the --no-optional flag',
      );

    const idRegex = /^[-_\w]+$/i;
    if (clientId && !idRegex.test(clientId)) {
      throw new Error(
        'Invalid clientId. Only alphanumeric characters, underscores and hyphens are allowed.',
      );
    }
    if (!backupSyncIntervalMs || backupSyncIntervalMs < 60000) {
      throw new Error(
        'Invalid backupSyncIntervalMs. Accepts values starting from 60000ms {1 minute}.',
      );
    }
    if (!store) throw new Error('Remote database store is required.');

    this.store = store;
    this.coordinator = coordinator || null;
    this.clientId = clientId;
    this.dataPath = path.resolve(dataPath || './.wwebjs_auth/');
    this.tempDir = `${this.dataPath}/wwebjs_temp_session_${this.clientId}`;
    this.zipper = zipper;
    this.logger = logger || pino({ name: RemoteAuth.name });
    this.backupSyncRunner = new SinglePeriodicJobRunner(
      'RemoteAuth Backup Sync',
      backupSyncIntervalMs,
      this.logger,
    );
  }

  get compressedSessionPath() {
    return `${this.sessionName}.zip`;
  }

  setup(client: Client) {
    this.client = client;
  }

  async afterBrowserInitialized() {
    return;
  }

  async onAuthenticationNeeded() {
    return {
      failed: false,
      restart: false,
      failureEventPayload: undefined,
    };
  }

  async getAuthEventPayload() {
    return;
  }

  async beforeBrowserInitialized() {
    const puppeteerOpts = this.client.options.puppeteer;
    const sessionDirName = this.clientId
      ? `RemoteAuth-${this.clientId}`
      : 'RemoteAuth';
    const dirPath = path.join(this.dataPath, sessionDirName);

    if (puppeteerOpts.userDataDir && puppeteerOpts.userDataDir !== dirPath) {
      throw new Error(
        'RemoteAuth is not compatible with a user-supplied userDataDir.',
      );
    }

    this.userDataDir = dirPath;
    this.logger.debug(`User data dir: ${this.userDataDir}`);
    this.sessionName = sessionDirName;
    this.logger.debug(`Session name: ${this.sessionName}`);

    await this.extractRemoteSession();
    await this.removeSingletonFiles(dirPath);

    this.client.options.puppeteer = {
      ...puppeteerOpts,
      userDataDir: dirPath,
    };
  }

  /**
   * Find in direction Singleton* files and try to remove it
   * Fix for SingletonLock and other files
   */
  private async removeSingletonFiles(dir: string) {
    const files = await fs.promises.readdir(dir);

    const lockPath = path.join(dir, 'SingletonLock');
    let lockTarget = '';
    try {
      lockTarget = await fs.promises.readlink(lockPath);
    } catch {}

    const pidMatch = lockTarget.match(/-(\d+)$/);
    if (pidMatch) {
      const pid = Number(pidMatch[1]);
      try {
        process.kill(pid, 0);
        throw new Error(
          `Chromium singleton belongs to active process ${pid}; refusing cleanup`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') throw error;
      }
    }

    // Chromium keeps SingletonSocket as a symlink to a per-process directory
    // under /tmp. Removing only the profile symlink leaves the stale socket and
    // can make the next launch exit without mapping a browser window.
    const socketLink = path.join(dir, 'SingletonSocket');
    let socketTarget = '';
    try {
      socketTarget = await fs.promises.readlink(socketLink);
      if (!path.isAbsolute(socketTarget)) {
        socketTarget = path.resolve(dir, socketTarget);
      }
    } catch {}

    for (const file of files) {
      if (file.startsWith('Singleton')) {
        const filePath = path.join(dir, file);
        try {
          await fs.promises.rm(filePath, {
            maxRetries: 4,
            recursive: true,
            force: true,
          });
        } catch (err) {
          this.logger.error(err, `Error deleting: ${filePath}`);
        }
      }
    }

    if (socketTarget.startsWith('/tmp/org.chromium.Chromium.')) {
      await fs.promises.rm(socketTarget, { force: true }).catch(() => {});
      await fs.promises
        .rmdir(path.dirname(socketTarget))
        .catch(() => {});
    }
  }

  // Pool PostgreSQL vive por toda a vida útil da SESSÃO (regra: não recriar/destruir
  // durante reconnect). `closeStoreOnDestroy` só é true num LOGOUT REAL.
  private pooledClosed = false;
  private closingPoolPromise: Promise<void> | null = null;

  async syncData() {
    // no-op placeholder to keep interface stable
  }

  async shutdownStore() {
    await this.drainRepositoryOperations();
    await this._closePoolOnce();
  }

  private async drainRepositoryOperations() {
    const repo = (this.store as any)?.repository;
    if (repo && typeof repo.drain === 'function') {
      try {
        await repo.drain();
      } catch (e) {
        this.logger.warn(`RemoteAuth.drain falhou: ${(e as Error).message}`);
      }
    }
    // pequeno grace para resolver micro-tarefas pendentes
    await new Promise((r) => setTimeout(r, 50));
  }

  private async _closePoolOnce() {
    if (this.pooledClosed || this.closingPoolPromise) return this.closingPoolPromise;
    // @ts-ignore
    if (!this.store?.close) return;
    this.pooledClosed = true;
    // @ts-ignore
    this.closingPoolPromise = Promise.resolve().then(async () => {
      try {
        // @ts-ignore
        await this.store.close();
      } catch (err) {
        this.logger.warn(`RemoteAuth._closePoolOnce: store.close falhou (${(err as Error).message}) — pool nao bloqueia sessao`);
      }
    }).catch(() => {}).finally(() => { this.closingPoolPromise = null; });
    return this.closingPoolPromise;
  }

  async logout() {
    // Keep the coordinator open until the logout-owned repository deletion
    // finishes. Closing it first makes deleteRemoteSession/sessionExists reject
    // with SessionOpClosed and turns a normal page logout into an unhandled
    // session failure.
    this.backupSyncRunner.stop();
    if (this.coordinator) {
      await this.coordinator.drain();
    }
    try {
      await this.disconnect(); // deleteRemoteSession still needs the coordinator
    } finally {
      if (this.coordinator) {
        this.coordinator.beginClose();
        await this.coordinator.drain();
      }
      await this.shutdownStore();
    }
  }

  async destroy() {
    // Reconnect/stop->start/restart: NAO fecha o pool PostgreSQL (regra 1/3) e
    // NUNCA apaga a auth. Executa um FLUSH FINAL (backup pendente + drain) com
    // timeout curto (menor que o grace period do SIGTERM) para garantir que o
    // ultimo backup gravado persista antes de o processo encerrar.
    this.backupSyncRunner.stop();
    try {
      // Se o backup inicial ainda nao concluiu/confirmou, forca um flush agora.
      const FLUSH_TIMEOUT_MS = 10000; // < grace period (SIGTERM)
      await Promise.race([
        this.ensureInitialBackup().catch(() => false),
        new Promise((r) => setTimeout(r, FLUSH_TIMEOUT_MS)),
      ]);
      await this.drainRepositoryOperations();
    } catch (e) {
      this.logger.warn(`RemoteAuth.destroy flush falhou: ${(e as Error).message}`);
    }
  }

  async disconnect() {
    await this.deleteRemoteSession();
    await this.deleteLocalSession();
  }

  private initialBackupPromise: Promise<boolean> | null = null;
  private initialBackupAttempt = 0;

  /**
   * Backup inicial: single-flight e idempotente (apenas UMA gravacao concorrente).
   * afterAuthReady, AUTHENTICATED e READY podem chamar; a primeira gravacao vence.
   * - Remove o delay de 60s do primeiro backup (restart precoce perdia a sessao).
   * - Marca "auth persistida" SOMENTE apos storeRemoteSession() concluir E o
   *   arquivo existir no PostgreSQL.
   * - Em falha: mantem a sessao conectada e faz retry com backoff; NAO marca
   *   a sessao como persistida.
   */
  async ensureInitialBackup(): Promise<boolean> {
    if (this.initialBackupPromise) {
      return this.initialBackupPromise;
    }
    const backupPromise = (async () => {
      // Retry com backoff exponencial, com LIMITE para nao travar o shutdown.
      // O runner periodico (60s) continua tentando depois; aqui nao fica em
      // loop infinito que seguraria SIGTERM/flush.
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        this.initialBackupAttempt = attempt;
        try {
          await this.storeRemoteSession();
          const exists = await this.store.sessionExists({
            session: this.sessionName,
          });
          if (exists) {
            this.logger.info(
              `RemoteAuth: auth persistida confirmada (backup #${this.initialBackupAttempt})`,
            );
            return true;
          }
          this.logger.error(
            `RemoteAuth: backup concluido mas arquivo NAO existe no store (tentativa #${this.initialBackupAttempt})`,
          );
        } catch (e) {
          this.logger.error(
            `RemoteAuth: backup inicial falhou (tentativa #${this.initialBackupAttempt}): ${(e as Error).message}`,
          );
        }
        if (attempt < MAX_ATTEMPTS) {
          const backoff = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
          await sleep(backoff);
        }
      }
      this.logger.error(
        `RemoteAuth: backup inicial nao confirmado apos ${MAX_ATTEMPTS} tentativas (runner 60s continuara)`,
      );
      return false;
    })();
    this.initialBackupPromise = backupPromise;
    const persisted = await backupPromise;
    if (!persisted && this.initialBackupPromise === backupPromise) {
      this.initialBackupPromise = null;
    }
    return persisted;
  }

  async afterAuthReady() {
    // Backup imediato (sem delay de 60s) — single-flight, aguarda conclusao.
    const persisted = await this.ensureInitialBackup();
    if (!persisted) {
      throw new Error('RemoteAuth initial backup was not confirmed');
    }
    this.client.emit(Events.REMOTE_SESSION_SAVED);

    this.backupSyncRunner.start(async () => {
      await this.storeRemoteSession();
    });
  }

  async storeRemoteSession() {
    // Backup periódico: baixa prioridade + cancelable pelo coordenador da sessão.
    const doBackup = async () => {
      if (this.coordinator && this.coordinator.isClosing()) return;
      const pathExists = await isValidPath(this.userDataDir);
      if (!pathExists) {
        this.logger.warn('User data dir does not exist. Skipping session backup.');
        return;
      }
      await this.compressSession();
      await this.store.save({ session: this.sessionName });
      await this.removePathSilently(this.compressedSessionPath);
      await this.removePathSilently(this.tempDir);
    };
    if (this.coordinator) {
      return this.coordinator.run(doBackup, { priority: 'low' }).catch((e) => {
        if ((e && e.message) !== 'SessionOpClosed') this.logger.error(e, 'backup sync error');
        throw e;
      });
    }
    return doBackup();
  }

  async extractRemoteSession() {
    await this.removePathSilently(this.userDataDir);

    const sessionExists = await this.store.sessionExists({
      session: this.sessionName,
    });
    if (!sessionExists) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      return;
    }

    await this.store.extract({
      session: this.sessionName,
      path: this.compressedSessionPath,
    });
    await this.removePathSilently(this.userDataDir);
    await this.unCompressSession();
    await this.removePathSilently(this.compressedSessionPath);
  }

  private async deleteRemoteSession() {
    const sessionExists = await this.store.sessionExists({
      session: this.sessionName,
    });
    if (sessionExists) await this.store.delete({ session: this.sessionName });
  }

  private async deleteLocalSession() {
    await this.removePathSilently(this.userDataDir);
  }

  async compressSession() {
    // Chrome's Storage Partitioning creates symlinks with numeric names inside the
    // profile.  fs-extra's copy resolves them and throws "subdirectory of itself"
    // when it detects a cycle.  We skip symlinks entirely — session-critical data
    // (IndexedDB, Local Storage, cookies) lives in regular files only.
    const skipSymlinks = async (src: string) => {
      try {
        const lstat = await fs.promises.lstat(src);
        return !lstat.isSymbolicLink();
      } catch {
        return false;
      }
    };

    await fs.copy(this.userDataDir, this.tempDir, { filter: skipSymlinks });
    await this.deleteMetadata();

    this.logger.debug('Compressing session...');
    await this.zipper.compress(this.tempDir, this.compressedSessionPath);
    this.logger.debug('Session compressed.');

    const zipSize = await getFilesizeInBytes(this.compressedSessionPath);
    this.logger.debug(`Session archive size: ${prettyBytes(zipSize)}`);
  }

  async unCompressSession() {
    const zipSize = await getFilesizeInBytes(this.compressedSessionPath);
    this.logger.debug(`Restored Session archive size: ${prettyBytes(zipSize)}`);

    this.logger.debug('Uncompressing session...');
    await this.zipper.uncompress(this.compressedSessionPath, this.userDataDir);
    this.logger.debug('Session uncompressed.');
  }

  async deleteMetadata() {
    const sessionDirs = [this.tempDir, path.join(this.tempDir, 'Default')];
    for (const dir of sessionDirs) {
      const sessionFiles = await fs.promises.readdir(dir);
      for (const element of sessionFiles) {
        if (this.REQUIRED_DIRS.includes(element)) {
          continue;
        }
        const dirElement = path.join(dir, element);
        await this.removePathSilently(dirElement);
      }
    }
  }

  private async removePathSilently(path: string) {
    const exists = await isValidPath(path);
    if (!exists) {
      return;
    }

    try {
      await fs.promises.rm(path, {
        maxRetries: 4,
        recursive: true,
        force: true,
      });
    } catch (err) {
      this.logger.error(err, `Error deleting: ${path}`);
    }
  }
}
