import { EcrConfig } from './EcrConfig.js';
import { EcrOpenedSession } from './EcrOpenedSession.js';
import { EcrSessionPlan } from './EcrSessionPlan.js';
import { EcrTerminal } from './EcrTerminal.js';
import { EcrWebServiceTerminal } from './EcrWebServiceTerminal.js';
import { InvalidArgumentException } from './exception/errors.js';
import { MerchantReference } from './internal/MerchantReference.js';
import { trim } from './internal/text.js';
import { Validate } from './internal/Validate.js';
import { type EcrLink, LanLink, WebServiceLink } from './link/EcrLink.js';
import { EcrLogger } from './log/EcrLogger.js';
import type { FinancialGuard } from './safety/FinancialGuard.js';
import type { HttpTransport } from './webservice/http/HttpTransport.js';

/** Optional collaborators for {@link EcrSessions.open}. */
export interface OpenOptions {
  /** Where diagnostics go. Default: {@link EcrLogger.none}. */
  logger?: EcrLogger | null;
  /** Web Service only: how the HTTPS post is made. Default: Node's `https`. */
  httpTransport?: HttpTransport | null;
  /**
   * The payment-safety guard. Default: file-based, from the config. Pass one
   * built on a shared journal and lock when several servers drive the same terminal.
   */
  guard?: FinancialGuard | null;
}

/**
 * The way in: validate a link and its credentials into a plan, then open one
 * session for it.
 *
 * ```ts
 * const plan = EcrSessions.plan(new LanLink('192.168.1.50'), new EcrConfig({ secureHashKey: wifiKey }));
 * if (!plan.isReady()) throw new Error(plan.issues().join('\n'));
 * const session = EcrSessions.open('SN-WIFI-0001', plan);
 * ```
 */
export class EcrSessions {
  /**
   * Validates `link` and `config` without opening a connection. Returns the
   * issues rather than throwing, so a settings screen can show what is missing;
   * it throws only for a link class it does not know.
   *
   * @param rawSecureHashKey The key as the operator typed it; checked and trimmed here.
   *        Defaults to the config's key.
   */
  static plan(link: EcrLink, config: EcrConfig, rawSecureHashKey: string | null = null): EcrSessionPlan {
    const issues: string[] = [];

    const key = trim(rawSecureHashKey ?? config.secureHashKey);
    const keyValid = EcrConfig.isValidSecureHashKey(key);
    if (key !== '' && !keyValid) issues.push('Secure hash key must be an even-length hex string of at least 16 characters');
    let resolved = config.with({ secureHashKey: key !== '' && keyValid ? key : '' });

    if (link instanceof LanLink) {
      if (Validate.isBlank(link.host)) issues.push('IP address is required for Wi-Fi ECR');
      if (!Number.isInteger(link.port) || link.port < 1 || link.port > 65535) {
        issues.push(`Port must be between 1 and 65535 (default ${EcrConfig.DEFAULT_PORT})`);
      } else {
        // The link's port wins: it is what the terminal shows on its screen.
        resolved = resolved.with({ port: link.port });
      }
    } else if (link instanceof WebServiceLink) {
      const merchantId = String(link.merchantId ?? '');
      const terminalId = String(link.terminalId ?? '');
      if (Validate.isBlank(merchantId)) issues.push('Merchant ID is required for Web Service');
      if (Validate.isBlank(terminalId)) issues.push('Terminal ID is required for Web Service');
      if (!Validate.isBlank(merchantId) && EcrWebServiceTerminal.id(merchantId) === null) issues.push('Merchant ID must be numeric');
      if (!Validate.isBlank(terminalId) && EcrWebServiceTerminal.id(terminalId) === null) issues.push('Terminal ID must be numeric');
      // Web Service HTTP read timeout: 130 s unless the caller already
      // overrode the Wi-Fi default (120 s).
      const responseTimeout = resolved.responseTimeout === EcrConfig.DEFAULT_RESPONSE_TIMEOUT
        ? EcrConfig.WEB_SERVICE_RESPONSE_TIMEOUT
        : resolved.responseTimeout;
      resolved = resolved.with({ merchantId, terminalId, responseTimeout });
    } else {
      throw new InvalidArgumentException('Unsupported ECR link: ' + (link as object)?.constructor?.name);
    }

    if (resolved.secureHashKey === '') issues.push(`${EcrSessionPlan.keyLabelFor(link)} is not configured`);

    return new EcrSessionPlan(link, resolved, [...new Set(issues)]);
  }

  /**
   * Opens the transport `plan` describes. One dispatch for Wi-Fi and Web
   * Service, so sale, inquiry and recovery cannot diverge on which client
   * they build.
   *
   * @param terminalSerial The terminal's serial number, as registered.
   * @throws InvalidArgumentException the plan has issues
   */
  static open(terminalSerial: string, plan: EcrSessionPlan, options: OpenOptions = {}): EcrOpenedSession {
    if (!plan.isReady()) {
      throw new InvalidArgumentException('Cannot open a session with unresolved issues: ' + plan.issues().join(', '));
    }
    const logger = options.logger ?? EcrLogger.none();
    if (plan.usesLan()) {
      return new EcrOpenedSession(plan, EcrSessions.lanTerminal(terminalSerial, plan, { logger, guard: options.guard ?? null }), null);
    }
    if (plan.usesWebService()) {
      return new EcrOpenedSession(plan, null, EcrSessions.webServiceTerminal(terminalSerial, plan, {
        logger,
        httpTransport: options.httpTransport ?? null,
        guard: options.guard ?? null,
      }));
    }
    throw new InvalidArgumentException('Unsupported ECR link: ' + plan.link.constructor.name);
  }

  static lanTerminal(terminalSerial: string, plan: EcrSessionPlan, options: Omit<OpenOptions, 'httpTransport'> = {}): EcrTerminal {
    if (!(plan.link instanceof LanLink)) throw new InvalidArgumentException('The plan is not for Wi-Fi ECR');
    return new EcrTerminal(plan.link.host, terminalSerial, plan.config, {
      logger: options.logger ?? null,
      guard: options.guard ?? null,
    });
  }

  static webServiceTerminal(terminalSerial: string, plan: EcrSessionPlan, options: OpenOptions = {}): EcrWebServiceTerminal {
    if (!plan.usesWebService()) throw new InvalidArgumentException('The plan is not for Web Service ECR');
    return new EcrWebServiceTerminal(terminalSerial, plan.config, {
      logger: options.logger ?? null,
      http: options.httpTransport ?? null,
      guard: options.guard ?? null,
    });
  }

  /**
   * A fresh merchant reference in the SDK's own shape (12 uppercase hex
   * characters). Make it, save it with the order, then send it.
   */
  static newMerchantReference(): string {
    return MerchantReference.generate();
  }
}
