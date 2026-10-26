import { InvalidArgumentException } from '../exception/errors.js';
import { Redactor } from './Redactor.js';

/** Anything with a `debug(message, context)` method: pino, winston, bunyan, `console`. */
export interface DebugLogger {
  debug(message: string, context?: Record<string, unknown>): unknown;
}

/**
 * Where the SDK writes its diagnostics. Off until a logger is passed.
 *
 * Lines carry request and response payloads: masked card number, amount,
 * reference. The signing secret is never written; card numbers and sensitive
 * fields are masked by {@link Redactor} before a line reaches the logger. Treat
 * the lines as transaction records.
 *
 * ```ts
 * const logger = EcrLogger.from((line) => console.log(line));
 * ```
 */
export abstract class EcrLogger {
  protected abstract write(line: string): void;

  /** Writes one diagnostic line, redacted. */
  debug(message: string): void {
    this.write(Redactor.line(message));
  }

  /** Discards everything. The default. */
  static none(): EcrLogger {
    return new NullEcrLogger();
  }

  /** Wraps a function that takes one line. An error thrown by it escapes the SDK call. */
  static from(sink: (line: string) => unknown): EcrLogger {
    return new CallableEcrLogger(sink);
  }

  /** Wraps a logger object with a `debug` method (pino, winston, `console`), the PSR-3 adapter's counterpart. */
  static adapt(logger: DebugLogger): EcrLogger {
    return new LoggerAdapter(logger);
  }
}

/** Discards every line. */
export class NullEcrLogger extends EcrLogger {
  protected write(_line: string): void {}
}

/** Hands each redacted line to a function. */
export class CallableEcrLogger extends EcrLogger {
  constructor(private readonly sink: (line: string) => unknown) {
    super();
  }

  protected write(line: string): void {
    this.sink(line);
  }
}

/**
 * Sends each redacted line to a logger object at debug level, with the context
 * `{ channel: 'amwalpay-ecr' }`, without making any logging library a dependency.
 */
export class LoggerAdapter extends EcrLogger {
  constructor(private readonly logger: DebugLogger) {
    super();
    if (logger === null || typeof logger !== 'object' || typeof (logger as DebugLogger).debug !== 'function') {
      throw new InvalidArgumentException('The logger must have a debug(message, context) method');
    }
  }

  protected write(line: string): void {
    this.logger.debug(line, { channel: 'amwalpay-ecr' });
  }
}
