import { EcrExampleSettings } from '../core/EcrExampleSettings.js';
import { LogBuffer } from '../core/LogBuffer.js';
import { SecretProtector } from '../core/SecretProtector.js';
import { TerminalRepository } from '../core/TerminalRepository.js';
import { TransactionEngine } from '../core/TransactionEngine.js';
import { TransactionRegistry } from './TransactionRegistry.js';

/**
 * The composition root: stores, the log buffer the SDK writes to, the engine
 * and the registry. Built once per server process.
 */
export class EcrApp {
  constructor(paths, { clock = null } = {}) {
    paths.ensure();
    this.paths = paths;
    this.log = new LogBuffer(paths.log());
    this.terminals = new TerminalRepository(paths.terminals());
    this.settings = new EcrExampleSettings(paths.settings(), new SecretProtector(paths.keys()));
    this.engine = new TransactionEngine(this.terminals, this.settings, this.log, paths.sdkState());
    this.registry = new TransactionRegistry(paths.runs(), this.engine, { clock, log: this.log });
  }
}
