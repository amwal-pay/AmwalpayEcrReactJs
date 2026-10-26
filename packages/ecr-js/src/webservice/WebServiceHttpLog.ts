import type { EcrEnvironment } from '../EcrEnvironment.js';
import { LanLog } from '../internal/LanLog.js';
import { Json } from '../json/Json.js';
import type { EcrLogger } from '../log/EcrLogger.js';
import type { WebServiceOperation } from './WebServiceOperation.js';
import { WebServiceSecureHash } from './WebServiceSecureHash.js';

/**
 * Request and response lines for Web Service calls, in the Windows SDK's
 * wording. The secret appears only as "configured".
 *
 * @internal
 */
export class WebServiceHttpLog {
  private static readonly PREFIX = '[Web Service]';

  static request(logger: EcrLogger, operation: WebServiceOperation, url: string, environment: EcrEnvironment, payload: string): void {
    const p = WebServiceHttpLog.PREFIX;
    logger.debug(`${p} ========== REQUEST ==========`);
    logger.debug(`${p} ${operation.label().toUpperCase()} POST ${url} (env=${environment.value})`);
    WebServiceHttpLog.payload(logger, 'REQUEST PAYLOAD', payload);
  }

  static signing(logger: EcrLogger, payloadToSign: string, hash: string): void {
    const p = WebServiceHttpLog.PREFIX;
    logger.debug(`${p} calcHash: HMAC-SHA256(sorted key=value payload, Hex.parse(secret)) → uppercase hex`);
    logger.debug(`${p} signing key (${WebServiceSecureHash.KEY_LABEL}): ${LanLog.fingerprint(true)}`);
    logger.debug(`${p} payload to sign (excl. secureHashValue): ${payloadToSign}`);
    logger.debug(`${p} secureHashValue: ${hash}`);
  }

  static response(logger: EcrLogger, operation: WebServiceOperation, status: number, elapsedMs: number, body: string): void {
    const p = WebServiceHttpLog.PREFIX;
    logger.debug(`${p} ========== RESPONSE ==========`);
    logger.debug(`${p} ${operation.label().toUpperCase()} HTTP ${status} (${elapsedMs}ms)`);
    WebServiceHttpLog.payload(logger, 'RESPONSE PAYLOAD', body);
  }

  static error(logger: EcrLogger, operation: WebServiceOperation, message: string, elapsedMs: number | null = null): void {
    const timing = elapsedMs === null ? '' : ` (${elapsedMs}ms)`;
    logger.debug(`${WebServiceHttpLog.PREFIX} ✗ ${operation.label().toUpperCase()}${timing} — ${message}`);
  }

  static operation(logger: EcrLogger, messageType: string, reference: string, terminalSerial: string, merchantId: bigint, terminalId: bigint): void {
    logger.debug(
      `${WebServiceHttpLog.PREFIX} sending ${messageType} ref=${reference} terminal=${terminalSerial} merchantId=${merchantId} terminalId=${terminalId}`,
    );
  }

  private static payload(logger: EcrLogger, label: string, raw: string): void {
    let body = raw.trim() === '' ? '<empty>' : raw;
    if (body !== '<empty>') {
      try {
        body = Json.pretty(Json.parse(body));
      } catch {
        // Logged as it came.
      }
    }
    logger.debug(`${WebServiceHttpLog.PREFIX} ${label}:`);
    for (const line of body.split(/\r\n|\n/)) logger.debug(`${WebServiceHttpLog.PREFIX}   ${line}`);
  }
}
