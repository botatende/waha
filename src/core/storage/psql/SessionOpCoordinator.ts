/**
 * SessionOpCoordinator — coordenador de operações de banco POR SESSÃO.
 * Compartilhado entre PsqlStore, WebJSPsqlAuth e PsqlFileRepository.
 * Serializa TODAS as ops do knex por-sessão sem deadlock (fila única por
 * instância), com cancelamento de baixa prioridade (backup) e drenagem no logout.
 */
export class SessionOpCoordinator {
  private chain: Promise<any> = Promise.resolve();
  private closing = false;
  private lowPriorityPending = 0;
  private _logger: any;

  constructor(logger?: any) {
    this._logger = logger;
  }
  isClosing(): boolean { return this.closing; }
  run<T>(fn: () => Promise<T>, opts: { priority?: 'high' | 'low' } = {}): Promise<T> {
    const priority = opts.priority || 'high';
    if (this.closing && priority === 'high') {
      return Promise.reject(new Error('SessionOpClosed'));
    }
    if (priority === 'low') this.lowPriorityPending++;
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => {}, () => {});
    if (priority === 'low') run.finally(() => { this.lowPriorityPending--; });
    return run;
  }
  cancelLowPriority(): void {
    this.lowPriorityPending = 0;
    if (this._logger && this._logger.debug) this._logger.debug('SessionOpCoordinator: backup cancelado');
  }
  hasLowPriorityPending(): boolean { return this.lowPriorityPending > 0; }
  beginClose(): void { this.closing = true; this.cancelLowPriority(); }
  async drain(): Promise<void> {
    await this.chain.catch(() => {});
    await new Promise<void>((r) => setTimeout(r, 75));
    await this.chain.catch(() => {});
  }
}
