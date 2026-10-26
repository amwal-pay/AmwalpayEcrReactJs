import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { InvalidArgumentException } from '../exception/errors.js';
import { Json, type JsonObject } from '../json/Json.js';
import { isHex } from './text.js';

/**
 * Message authentication for the Wi-Fi ECR link.
 *
 * A shared secret proves that a request came from a till that holds the key
 * and that nothing on the network altered it. Without it any device on the
 * shop Wi-Fi could open the terminal's port and issue a refund.
 *
 * Construction, identical to the POS and the Windows SDK: take every top-level
 * string, number or boolean except `secureHash`, sort by key byte for byte, join
 * as `key=value&key=value`, HMAC-SHA256 under the hex-decoded key, uppercase hex.
 *
 * @internal
 */
export class SecureHash {
  /** Field carrying the signature. Never part of what is signed. */
  static readonly FIELD = 'secureHash';

  /** Log label for the Wi-Fi signing key (distinct from Web Service). */
  static readonly KEY_LABEL = 'Wi-Fi/CABLE secure hash key';

  private static readonly NONCE_BYTES = 16;

  /** The exact text both sides agree to sign. */
  static compose(json: JsonObject): string {
    return Json.compose(json, SecureHash.FIELD);
  }

  /** HMAC-SHA256 of `message` under the hex-decoded `key`, as uppercase hex. */
  static sign(message: string, key: string, name = 'The ECR secret'): string {
    return createHmac('sha256', SecureHash.decodeKey(key, name)).update(message, 'utf8').digest('hex').toUpperCase();
  }

  /** Whether `json` carries a `secureHash` that matches `key`. */
  static verify(json: JsonObject, key: string): boolean {
    const presented = json.str(SecureHash.FIELD);
    if (presented === '') return false;
    // Constant time, case-insensitive hex: the terminal may write either case.
    return SecureHash.equals(SecureHash.sign(SecureHash.compose(json), key), presented.toUpperCase());
  }

  /** A fresh 128-bit nonce, as uppercase hex. */
  static newNonce(): string {
    return randomBytes(SecureHash.NONCE_BYTES).toString('hex').toUpperCase();
  }

  /**
   * The key as bytes. Hex, matching the POS convention: a 32-character key is
   * 16 bytes, not 32. A key that is not hex is refused rather than read as
   * text, because the two sides would then disagree about the bytes and every
   * message would fail to verify with nothing to show why.
   */
  static decodeKey(key: string, name = 'The ECR secret'): Buffer {
    if (typeof key !== 'string' || key.length < 2 || key.length % 2 !== 0 || !isHex(key)) {
      throw new InvalidArgumentException(`${name} must be an even-length hex string`);
    }
    return Buffer.from(key, 'hex');
  }

  /** PHP's `hash_equals`: constant time for equal lengths, false otherwise. */
  static equals(known: string, presented: string): boolean {
    const a = Buffer.from(known, 'utf8');
    const b = Buffer.from(presented, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
