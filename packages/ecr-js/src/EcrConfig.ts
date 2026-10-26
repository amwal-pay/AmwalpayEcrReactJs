import { EcrEnvironment } from './EcrEnvironment.js';
import { InvalidArgumentException, LogicException } from './exception/errors.js';
import { isHex } from './internal/text.js';

/** The settings {@link EcrConfig} is built from. Every one is optional. */
export interface EcrConfigOptions {
  /** Identifies this cash register to the terminal and on its records. Default `ECR01`. */
  ecrId?: string;
  /** ISO 4217 numeric code: `512` for OMR (the default). */
  currencyCode?: string;
  /** Decimal places the currency has (0 to 4): 3 for OMR (the default), 2 for USD. */
  minorUnitDigits?: number;
  /** The terminal's ECR listener port. Default 9100. */
  port?: number;
  /** Seconds to wait for the terminal to accept a connection. Default 10. */
  connectTimeout?: number;
  /** Seconds to wait for the result once the request is sent. Default 120. */
  responseTimeout?: number;
  /** Seconds a reachability probe waits. Default 3. */
  probeTimeout?: number;
  /** The signing secret, as hex. Wi-Fi and Web Service use different secrets. Empty: unsigned. */
  secureHashKey?: string | null;
  /** Backend merchant ID, for Web Service. */
  merchantId?: string;
  /** Backend terminal ID, for Web Service. */
  terminalId?: string;
  /** Hub deployment for Web Service. Default SIT. */
  environment?: EcrEnvironment;
  /** Follow a lost Wi-Fi answer with one inquiry by merchant reference. Default true. */
  autoInquireOnFailure?: boolean;
  /**
   * Opt in to one money-moving call per terminal at a time, unique references,
   * and no new money movement while an earlier outcome is unknown. Off by
   * default, as the Windows SDK has no such guard. See {@link FinancialGuard}.
   */
  guardFinancialOperations?: boolean;
  /**
   * Where the guard keeps its locks and journal. Null: the system temp folder.
   * Use a durable, private folder in production.
   */
  stateDirectory?: string | null;
  /** CA bundle (PEM file) for the Web Service TLS check, added to Node's own trust store. */
  caBundlePath?: string | null;
  /**
   * IANA time zone for `transactionDateTime`, e.g. `Asia/Muscat`. Null: the
   * machine's local time, as the Windows SDK (`DateTime.Now`). Set it only to override the machine.
   */
  timezone?: string | null;
}

type Settings = Required<Omit<EcrConfigOptions, 'secureHashKey'>> & { secureHashKey: string };

const NAMES: ReadonlyArray<keyof EcrConfigOptions> = [
  'ecrId', 'currencyCode', 'minorUnitDigits', 'port', 'connectTimeout', 'responseTimeout', 'probeTimeout',
  'secureHashKey', 'merchantId', 'terminalId', 'environment', 'autoInquireOnFailure', 'guardFinancialOperations',
  'stateDirectory', 'caBundlePath', 'timezone',
];

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * How this ECR identifies itself and how it talks to a terminal.
 *
 * Immutable. Invalid values are refused the moment the config is built, so a
 * key with a stray space fails at start-up rather than on the shop floor as a
 * decline the cashier cannot explain.
 *
 * ```ts
 * const config = new EcrConfig({ ecrId: 'TILL-01', secureHashKey: wifiKey });
 * const stricter = config.with({ responseTimeout: 60 });
 * ```
 *
 * Timeouts are seconds. The defaults describe an Omani deployment (OMR, three
 * decimals) on the standard port.
 */
export class EcrConfig {
  /** The port Amwal POS terminals listen on for ECR requests. */
  static readonly DEFAULT_PORT = 9100;

  /** Wi-Fi wait for the terminal's answer: card present plus PIN. */
  static readonly DEFAULT_RESPONSE_TIMEOUT = 120;

  static readonly DEFAULT_CONNECT_TIMEOUT = 10;

  /**
   * HTTP read timeout for Web Service calls, which {@link EcrSessions.plan}
   * gives a Web Service link when the caller left the Wi-Fi default (120 s).
   * Longer than the Wi-Fi wait: the Hub's wait includes card present plus PIN.
   * With the default connect timeout the HTTP deadline is 140 s.
   */
  static readonly WEB_SERVICE_RESPONSE_TIMEOUT = 130;

  /** 64 bits is the shortest key worth calling a secret. */
  private static readonly MIN_SECRET_LENGTH = 16;

  readonly ecrId: string;
  readonly currencyCode: string;
  readonly minorUnitDigits: number;
  readonly port: number;
  readonly connectTimeout: number;
  readonly responseTimeout: number;
  readonly probeTimeout: number;
  readonly merchantId: string;
  readonly terminalId: string;
  readonly environment: EcrEnvironment;
  readonly autoInquireOnFailure: boolean;
  readonly guardFinancialOperations: boolean;
  readonly stateDirectory: string | null;
  readonly caBundlePath: string | null;
  readonly timezone: string | null;

  // A private field: not enumerable, not copied by spread or structuredClone, not shown by console.log.
  readonly #secureHashKey: string;

  constructor(options: EcrConfigOptions = {}) {
    const s = EcrConfig.settings(options);
    if (!Number.isInteger(s.minorUnitDigits) || s.minorUnitDigits < 0 || s.minorUnitDigits > 4) {
      throw new InvalidArgumentException('minorUnitDigits must be between 0 and 4');
    }
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
      throw new InvalidArgumentException('port must be between 1 and 65535');
    }
    for (const name of ['connectTimeout', 'responseTimeout', 'probeTimeout'] as const) {
      const seconds = s[name];
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
        throw new InvalidArgumentException(`${name} must be a positive number of seconds`);
      }
    }
    if (!(s.environment instanceof EcrEnvironment)) {
      throw new InvalidArgumentException('environment must be EcrEnvironment.SIT, UAT or PROD');
    }
    if (s.timezone !== null && !EcrConfig.isTimeZone(s.timezone)) {
      throw new InvalidArgumentException('timezone must be a time zone identifier such as Asia/Muscat');
    }
    const key = s.secureHashKey;
    if (key !== '' && !EcrConfig.isValidSecret(key)) {
      throw new InvalidArgumentException(
        'secureHashKey must be an even-length hex string of at least 16 characters, or empty to send unsigned messages',
      );
    }

    this.ecrId = String(s.ecrId);
    this.currencyCode = String(s.currencyCode);
    this.minorUnitDigits = s.minorUnitDigits;
    this.port = s.port;
    this.connectTimeout = s.connectTimeout;
    this.responseTimeout = s.responseTimeout;
    this.probeTimeout = s.probeTimeout;
    this.#secureHashKey = key;
    this.merchantId = String(s.merchantId);
    this.terminalId = String(s.terminalId);
    this.environment = s.environment;
    this.autoInquireOnFailure = Boolean(s.autoInquireOnFailure);
    this.guardFinancialOperations = Boolean(s.guardFinancialOperations);
    this.stateDirectory = s.stateDirectory;
    this.caBundlePath = s.caBundlePath;
    this.timezone = s.timezone;
    Object.freeze(this);
  }

  /** The signing secret, as hex, or "" when messages are not signed. */
  get secureHashKey(): string {
    return this.#secureHashKey;
  }

  /**
   * A copy with some values changed. Validated like the constructor.
   *
   * ```ts
   * config.with({ responseTimeout: 60, ecrId: 'TILL-02' })
   * ```
   */
  with(changes: EcrConfigOptions): EcrConfig {
    for (const name of Object.keys(changes)) {
      if (!(NAMES as readonly string[]).includes(name)) {
        throw new InvalidArgumentException('EcrConfig has no setting named ' + name);
      }
    }
    return new EcrConfig({ ...this.arguments(), ...changes });
  }

  /** Whether this till signs what it sends. */
  signsMessages(): boolean {
    return this.#secureHashKey !== '';
  }

  /** Whether `key` is acceptable for {@link secureHashKey}: empty, or even-length hex of at least 16 characters. */
  static isValidSecureHashKey(key: string | null | undefined): boolean {
    return key === null || key === undefined || key === '' || EcrConfig.isValidSecret(key);
  }

  /** @internal */
  static isValidSecret(key: string): boolean {
    return typeof key === 'string' && key.length >= EcrConfig.MIN_SECRET_LENGTH && key.length % 2 === 0 && isHex(key);
  }

  /** Never prints the secret. */
  toString(): string {
    return `EcrConfig(ecrId=${this.ecrId}, port=${this.port}, environment=${this.environment.value}, `
      + `merchantId=${this.merchantId}, terminalId=${this.terminalId}, `
      + `secureHashKey=${this.#secureHashKey === '' ? 'empty' : '<redacted>'})`;
  }

  /** What `console.log` and `util.inspect` show: everything but the secret. */
  [INSPECT](): Record<string, unknown> {
    const info: Record<string, unknown> = { ...this.arguments(), environment: this.environment.value };
    info['secureHashKey'] = this.#secureHashKey === '' ? 'empty' : '<redacted>';
    return info;
  }

  /** A config holds a signing secret; it is not written to sessions, caches or queues. */
  toJSON(): never {
    throw new LogicException('EcrConfig holds a signing secret and cannot be serialized');
  }

  private arguments(): EcrConfigOptions {
    return {
      ecrId: this.ecrId,
      currencyCode: this.currencyCode,
      minorUnitDigits: this.minorUnitDigits,
      port: this.port,
      connectTimeout: this.connectTimeout,
      responseTimeout: this.responseTimeout,
      probeTimeout: this.probeTimeout,
      secureHashKey: this.#secureHashKey,
      merchantId: this.merchantId,
      terminalId: this.terminalId,
      environment: this.environment,
      autoInquireOnFailure: this.autoInquireOnFailure,
      guardFinancialOperations: this.guardFinancialOperations,
      stateDirectory: this.stateDirectory,
      caBundlePath: this.caBundlePath,
      timezone: this.timezone,
    };
  }

  private static settings(o: EcrConfigOptions): Settings {
    return {
      ecrId: o.ecrId ?? 'ECR01',
      currencyCode: o.currencyCode ?? '512',
      minorUnitDigits: o.minorUnitDigits ?? 3,
      port: o.port ?? EcrConfig.DEFAULT_PORT,
      connectTimeout: o.connectTimeout ?? EcrConfig.DEFAULT_CONNECT_TIMEOUT,
      responseTimeout: o.responseTimeout ?? EcrConfig.DEFAULT_RESPONSE_TIMEOUT,
      probeTimeout: o.probeTimeout ?? 3,
      secureHashKey: o.secureHashKey ?? '',
      merchantId: o.merchantId ?? '',
      terminalId: o.terminalId ?? '',
      environment: o.environment ?? EcrEnvironment.SIT,
      autoInquireOnFailure: o.autoInquireOnFailure ?? true,
      guardFinancialOperations: o.guardFinancialOperations ?? false,
      stateDirectory: o.stateDirectory ?? null,
      caBundlePath: o.caBundlePath ?? null,
      timezone: o.timezone ?? null,
    };
  }

  /** An IANA zone name (`Asia/Muscat`, `UTC`), not an offset. */
  private static isTimeZone(zone: unknown): boolean {
    if (typeof zone !== 'string' || !/[A-Za-z]/.test(zone)) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }
}
