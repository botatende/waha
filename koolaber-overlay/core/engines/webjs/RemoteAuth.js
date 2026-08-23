"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteAuth = void 0;
const promiseTimeout_1 = require("../../../utils/promiseTimeout");
const SinglePeriodicJobRunner_1 = require("../../../utils/SinglePeriodicJobRunner");
const path = require("path");
const pino_1 = require("pino");
const whatsapp_web_js_1 = require("whatsapp-web.js");
const prettyBytes = require('pretty-bytes');
let fs;
try {
    fs = require('fs-extra');
}
catch (_a) {
    fs = undefined;
}
async function isValidPath(path) {
    try {
        await fs.promises.access(path);
        return true;
    }
    catch (_a) {
        return false;
    }
}
async function getFilesizeInBytes(filename) {
    const stats = await fs.promises.lstat(filename).catch(() => null);
    if (!stats) {
        return;
    }
    return stats.size;
}
class RemoteAuth {
    constructor({ clientId, dataPath, store, backupSyncIntervalMs, logger, zipper, coordinator } = {}) {
        this.REQUIRED_DIRS = ['Default', 'IndexedDB', 'Local Storage'];
        this.INITIAL_DELAY_MS = 60000;
        this.pooledClosed = false;
        this.closingPoolPromise = null;
        this.initialBackupPromise = null;
        this.initialBackupAttempt = 0;
        if (!fs)
            throw new Error('Optional Dependencies [fs-extra] are required to use RemoteAuth. Make sure to run npm install correctly and remove the --no-optional flag');
        const idRegex = /^[-_\w]+$/i;
        if (clientId && !idRegex.test(clientId)) {
            throw new Error('Invalid clientId. Only alphanumeric characters, underscores and hyphens are allowed.');
        }
        if (!backupSyncIntervalMs || backupSyncIntervalMs < 60000) {
            throw new Error('Invalid backupSyncIntervalMs. Accepts values starting from 60000ms {1 minute}.');
        }
        if (!store)
            throw new Error('Remote database store is required.');
        this.store = store;
        this.coordinator = coordinator || null;
        this.clientId = clientId;
        this.dataPath = path.resolve(dataPath || './.wwebjs_auth/');
        this.tempDir = `${this.dataPath}/wwebjs_temp_session_${this.clientId}`;
        this.zipper = zipper;
        this.logger = logger || (0, pino_1.default)({ name: RemoteAuth.name });
        this.backupSyncRunner = new SinglePeriodicJobRunner_1.SinglePeriodicJobRunner('RemoteAuth Backup Sync', backupSyncIntervalMs, this.logger);
    }
    get compressedSessionPath() {
        return `${this.sessionName}.zip`;
    }
    setup(client) {
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
            throw new Error('RemoteAuth is not compatible with a user-supplied userDataDir.');
        }
        this.userDataDir = dirPath;
        this.logger.debug(`User data dir: ${this.userDataDir}`);
        this.sessionName = sessionDirName;
        this.logger.debug(`Session name: ${this.sessionName}`);
        await this.extractRemoteSession();
        await this.removeSingletonFiles(dirPath);
        this.client.options.puppeteer = Object.assign(Object.assign({}, puppeteerOpts), { userDataDir: dirPath });
    }
    async removeSingletonFiles(dir) {
        const files = await fs.promises.readdir(dir);
        for (const file of files) {
            if (file.startsWith('Singleton')) {
                const filePath = path.join(dir, file);
                try {
                    await fs.promises.rm(filePath, {
                        maxRetries: 4,
                        recursive: true,
                        force: true,
                    });
                }
                catch (err) {
                    this.logger.error(err, `Error deleting: ${filePath}`);
                }
            }
        }
    }
    async syncData() {
    }
    async shutdownStore() {
        await this.drainRepositoryOperations();
        await this._closePoolOnce();
    }
    async drainRepositoryOperations() {
        var _a;
        const repo = (_a = this.store) === null || _a === void 0 ? void 0 : _a.repository;
        if (repo && typeof repo.drain === 'function') {
            try {
                await repo.drain();
            }
            catch (e) {
                this.logger.warn(`RemoteAuth.drain falhou: ${e.message}`);
            }
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    async _closePoolOnce() {
        var _a;
        if (this.pooledClosed || this.closingPoolPromise)
            return this.closingPoolPromise;
        if (!((_a = this.store) === null || _a === void 0 ? void 0 : _a.close))
            return;
        this.pooledClosed = true;
        this.closingPoolPromise = Promise.resolve().then(async () => {
            try {
                await this.store.close();
            }
            catch (err) {
                this.logger.warn(`RemoteAuth._closePoolOnce: store.close falhou (${err.message}) — pool nao bloqueia sessao`);
            }
        }).catch(() => { }).finally(() => { this.closingPoolPromise = null; });
        return this.closingPoolPromise;
    }
    async logout() {
        this.backupSyncRunner.stop();
        if (this.coordinator) {
            await this.coordinator.drain();
        }
        try {
            await this.disconnect();
        }
        finally {
            if (this.coordinator) {
                this.coordinator.beginClose();
                await this.coordinator.drain();
            }
            await this.shutdownStore();
        }
    }
    async destroy() {
        this.backupSyncRunner.stop();
        try {
            const FLUSH_TIMEOUT_MS = 10000;
            await Promise.race([
                this.ensureInitialBackup().catch(() => false),
                new Promise((r) => setTimeout(r, FLUSH_TIMEOUT_MS)),
            ]);
            await this.drainRepositoryOperations();
        }
        catch (e) {
            this.logger.warn(`RemoteAuth.destroy flush falhou: ${e.message}`);
        }
    }
    async disconnect() {
        await this.deleteRemoteSession();
        await this.deleteLocalSession();
    }
    async ensureInitialBackup() {
        if (this.initialBackupPromise) {
            return this.initialBackupPromise;
        }
        this.initialBackupPromise = (async () => {
            const MAX_ATTEMPTS = 3;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                this.initialBackupAttempt = attempt;
                try {
                    await this.storeRemoteSession();
                    const exists = await this.store.sessionExists({
                        session: this.sessionName,
                    });
                    if (exists) {
                        this.logger.info(`RemoteAuth: auth persistida confirmada (backup #${this.initialBackupAttempt})`);
                        return true;
                    }
                    this.logger.error(`RemoteAuth: backup concluido mas arquivo NAO existe no store (tentativa #${this.initialBackupAttempt})`);
                }
                catch (e) {
                    this.logger.error(`RemoteAuth: backup inicial falhou (tentativa #${this.initialBackupAttempt}): ${e.message}`);
                }
                if (attempt < MAX_ATTEMPTS) {
                    const backoff = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
                    await (0, promiseTimeout_1.sleep)(backoff);
                }
            }
            this.logger.error(`RemoteAuth: backup inicial nao confirmado apos ${MAX_ATTEMPTS} tentativas (runner 60s continuara)`);
            return false;
        })();
        return this.initialBackupPromise;
    }
    async afterAuthReady() {
        await this.ensureInitialBackup();
        this.client.emit(whatsapp_web_js_1.Events.REMOTE_SESSION_SAVED);
        this.backupSyncRunner.start(async () => {
            await this.storeRemoteSession();
        });
    }
    async storeRemoteSession() {
        const doBackup = async () => {
            if (this.coordinator && this.coordinator.isClosing())
                return;
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
                if ((e && e.message) !== 'SessionOpClosed')
                    this.logger.error(e, 'backup sync error');
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
    async deleteRemoteSession() {
        const sessionExists = await this.store.sessionExists({
            session: this.sessionName,
        });
        if (sessionExists)
            await this.store.delete({ session: this.sessionName });
    }
    async deleteLocalSession() {
        await this.removePathSilently(this.userDataDir);
    }
    async compressSession() {
        const skipSymlinks = async (src) => {
            try {
                const lstat = await fs.promises.lstat(src);
                return !lstat.isSymbolicLink();
            }
            catch (_a) {
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
    async removePathSilently(path) {
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
        }
        catch (err) {
            this.logger.error(err, `Error deleting: ${path}`);
        }
    }
}
exports.RemoteAuth = RemoteAuth;
//# sourceMappingURL=RemoteAuth.js.map
