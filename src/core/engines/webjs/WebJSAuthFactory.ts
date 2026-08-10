import { DataStore } from '@waha/core/abc/DataStore';
import { LocalAuth } from '@waha/core/engines/webjs/LocalAuth';
import { LocalStore } from '@waha/core/storage/LocalStore';
import { RemoteAuth, Zipper } from '@waha/core/engines/webjs/RemoteAuth';
import { StreamZipper } from '@waha/core/engines/webjs/StreamZipper';
import { WebJSMongoAuth } from '@waha/core/engines/webjs/WebJSMongoAuth';
import { ZipUnzipZipper } from '@waha/core/engines/webjs/ZipUnzipZipper';
import { MongoStore } from '@waha/core/storage/mongo/MongoStore';
import { PsqlStore } from '@waha/core/storage/psql/PsqlStore';
import { LoggerBuilder } from '@waha/utils/logging';
import { Logger } from 'pino';
import { AuthStrategy } from 'whatsapp-web.js';

import { WebJSPsqlAuth } from './WebJSPsqlAuth';
import { SessionOpCoordinator } from '@waha/core/storage/psql/SessionOpCoordinator';

export class WebJSAuthFactory {
  async buildAuth(
    store: DataStore,
    name: string,
    loggerBuilder: LoggerBuilder,
  ): Promise<AuthStrategy> {
    if (store instanceof MongoStore)
      return this.buildMongoAuth(store, name, loggerBuilder);
    if (store instanceof PsqlStore)
      return await this.buildPsql(store, name, loggerBuilder);
    if (store instanceof LocalStore)
      return this.buildLocalAuth(store, name, loggerBuilder);
    throw new Error(`Unsupported store type '${store.constructor.name}'`);
  }

  buildLocalAuth(
    store: LocalStore,
    name: string,
    loggerBuilder: LoggerBuilder,
  ) {
    const logger = loggerBuilder.child({ name: LocalAuth.name });
    return new LocalAuth({
      clientId: name,
      dataPath: store.getSessionDirectory(name),
      logger: logger,
      rmMaxRetries: undefined,
    });
  }

  async buildPsql(
    store: PsqlStore,
    name: string,
    loggerBuilder: LoggerBuilder,
  ) {
    const logger = loggerBuilder.child({ name: WebJSPsqlAuth.name });
    const knex = store.buildSessionKnex(name, 'Session/Auth');
    // Coordenador de operações POR SESSÃO, compartilhado entre o store e a auth,
    // para serializar todas as ops do knex e evitar a saturação do pool.
    const coordinator = new SessionOpCoordinator(logger);
    const authStore = new WebJSPsqlAuth(knex, logger, coordinator);
    await authStore.init();
    const zipper = this.getAvailableZipper(logger);
    return new RemoteAuth({
      backupSyncIntervalMs: 60 * 1000,
      clientId: name,
      dataPath: null,
      logger: loggerBuilder.child({ name: RemoteAuth.name }),
      store: authStore,
      coordinator: coordinator,
      zipper: zipper,
    });
  }

  private buildMongoAuth(
    store: MongoStore,
    name: string,
    loggerBuilder: LoggerBuilder,
  ) {
    const logger = loggerBuilder.child({ name: WebJSMongoAuth.name });
    const authStore = new WebJSMongoAuth(name, store, logger);
    const zipper = this.getAvailableZipper(logger);
    return new RemoteAuth({
      backupSyncIntervalMs: 60 * 1000,
      clientId: name,
      dataPath: null,
      logger: loggerBuilder.child({ name: RemoteAuth.name }),
      store: authStore,
      zipper: zipper,
    });
  }

  private getAvailableZipper(logger: Logger): Zipper {
    if (process.env.WAHA_ZIPPER == 'ZIPUNZIP') {
      logger.debug('Using ZipUnzipZipper');
      return new ZipUnzipZipper();
    }
    logger.debug('Using StreamZipper');
    return new StreamZipper();
  }
}
