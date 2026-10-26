import type { EcrLogger } from '../log/EcrLogger.js';

/**
 * Signing and verification lines for Wi-Fi, in the Windows SDK's wording, so
 * an operator can confirm the Wi-Fi key (not the Web Service key) is in use.
 * The secret appears only as "configured" or "not configured".
 *
 * @internal
 */
export class LanLog {
  private static readonly PREFIX = '[Wi-Fi/CABLE]';

  static signing(logger: EcrLogger, keyLabel: string, keyConfigured: boolean, payload: string, hash: string, nonce: string): void {
    const p = LanLog.PREFIX;
    logger.debug(`${p} sign: HMAC-SHA256(sorted key=value payload, Hex.parse(secret)) → uppercase hex`);
    logger.debug(`${p} signing key (${keyLabel}): ${LanLog.fingerprint(keyConfigured)}`);
    logger.debug(`${p} payload to sign (excl. secureHash): ${payload}`);
    if (nonce !== '') logger.debug(`${p} nonce: ${nonce}`);
    logger.debug(`${p} secureHash: ${hash}`);
  }

  static verifyResponse(logger: EcrLogger, keyLabel: string, keyConfigured: boolean, payload: string, hash: string, verified: boolean): void {
    const p = LanLog.PREFIX;
    logger.debug(`${p} verify: HMAC-SHA256(sorted key=value payload, Hex.parse(secret)) → uppercase hex`);
    logger.debug(`${p} verify key (${keyLabel}): ${LanLog.fingerprint(keyConfigured)}`);
    logger.debug(`${p} payload to verify (excl. secureHash): ${payload}`);
    logger.debug(`${p} secureHash: ${hash}`);
    logger.debug(verified ? `${p} ✓ response signature valid` : `${p} ✗ response signature invalid`);
  }

  static fingerprint(configured: boolean): string {
    return configured ? 'configured' : 'not configured';
  }
}
