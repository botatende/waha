import { sleep } from '@nestjs/terminus/dist/utils';
import { PsqlFileRepository } from '@waha/core/storage/psql/PsqlFileRepository';
import { SessionOpCoordinator } from '@waha/core/storage/psql/SessionOpCoordinator';
import Knex from 'knex';
import { Logger } from 'pino';
import { Store } from 'whatsapp-web.js';

interface Options {
  session: string;
  path?: string;
}

class WebjsFileRepository extends PsqlFileRepository {
  get tableName() {
    return 'files';
  }
}

export class WebJSPsqlAuth implements Store {
  repository: PsqlFileRepository;

  constructor(
    private knex: Knex.Knex,
    private logger: Logger,
    private coordinator?: SessionOpCoordinator,
  ) {
    this.repository = new WebjsFileRepository(knex, logger, coordinator);
    this.coordinator = coordinator;
  }

  // Drena as operações pendentes do repositório (usado num logout real antes
  // de destruir o pool, garantindo que o COPY não esteja pendente).
  async drain(): Promise<void> {
    if (this.coordinator) { await this.coordinator.drain(); return; }
    await this.repository.drain();
  }

  async sessionExists(options: Options): Promise<boolean> {
    this.logger.info('Checking if session exists...');
    const filename = this.getAuthFileName(options);
    const exists = await this.repository.exists(filename);
    this.logger.info(`Session exists: ${exists}`);
    return exists;
  }

  async delete(options: Options): Promise<any> {
    this.logger.debug('Deleting session...');
    const filename = this.getAuthFileName(options);
    await this.repository.delete(filename);
    this.logger.debug('Session deleted.');
  }

  async save(options: Options): Promise<any> {
    this.logger.debug('Saving session...');
    const filename = this.getAuthFileName(options);
    await this.repository.saveFromFile(filename, filename);
    this.logger.debug('Session saved.');
  }

  async extract(options: Options) {
    this.logger.debug('Extracting existing session...');
    const filename = this.getAuthFileName(options);
    const found = await this.repository.fetchToFile(filename, options.path);
    if (!found) {
      this.logger.warn('Session does not exist.');
      return;
    }

    // Wait a second before giving the zip file to next phase
    await sleep(1_000);
    this.logger.info('Session has been extracted.');
  }

  async init() {
    await this.repository.init();
  }

  private getAuthFileName(options: Options): string {
    return `${options.session}.zip`;
  }

  async close() {
    try {
      await this.knex.destroy();
    } catch (err) {
      // "aborted" ocorre quando o pool tem operações pendentes (teardown
      // durante reconnect/logout com backup-sync em voo). Destruir o pool não
      // deve derrubar a sessão: engole e força a liberação dos handles.
      this.logger.warn(
        `WebJSPsqlAuth.close: knex destroy aborted (${(err as Error).message}) — forcing teardown`,
      );
      try {
        await this.knex.destroy();
      } catch (_second) {
        /* ignore */
      }
      try {
        const pool = (this.knex.client as any).pool;
        if (pool && pool.numUsed) {
          const used = pool.numUsed();
          for (let i = 0; i < (used || 0) && pool.destroy; i++) {
            try {
              pool.destroy();
            } catch (_p) {
              /* ignore */
            }
          }
        }
      } catch (_poolErr) {
        /* ignore */
      }
    }
  }
}
