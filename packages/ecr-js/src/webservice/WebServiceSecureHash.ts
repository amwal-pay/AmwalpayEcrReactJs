import { InvalidArgumentException } from '../exception/errors.js';
import { SecureHash } from '../internal/SecureHash.js';
import { Json, type JsonObject } from '../json/Json.js';

/**
 * Web Service request signing: the platform's `calcHash(obj, secret)`.
 *
 * `obj` is not the raw JSON body. It is the sorted `key=value&key=value` text
 * of every top-level scalar except `secureHashValue`, the same rules as Wi-Fi,
 * HMAC-SHA256 under the hex-decoded secret, uppercase hex:
 *
 * ```js
 * function calcHash(obj, secret) {
 *   const crypted = CryptoJS.HmacSHA256(obj, CryptoJS.enc.Hex.parse(secret))
 *   return CryptoJS.enc.Hex.stringify(crypted).toUpperCase();
 * }
 * ```
 */
export class WebServiceSecureHash {
  /** Field added to signed Web Service request bodies. */
  static readonly FIELD = 'secureHashValue';

  /** Log label for the Web Service signing key (distinct from Wi-Fi). */
  static readonly KEY_LABEL = 'Web Service secure hash key';

  /** `calcHash`: HMAC-SHA256 under the hex-decoded secret as uppercase hex, or "" on any error. */
  static calcHash(message: string, secret: string): string {
    if (secret === '') return '';
    try {
      return SecureHash.sign(message, secret, 'The Web Service secret');
    } catch (error) {
      if (error instanceof InvalidArgumentException) return '';
      throw error;
    }
  }

  /** The sorted `key=value&...` signing text, excluding `secureHashValue`. */
  static compose(json: JsonObject): string {
    return Json.compose(json, WebServiceSecureHash.FIELD);
  }

  static sign(body: JsonObject, secret: string): string {
    return WebServiceSecureHash.calcHash(WebServiceSecureHash.compose(body), secret);
  }

  /**
   * A copy of `body` with `secureHashValue` set. The input is left alone; an
   * earlier hash is replaced. An empty secret returns the body unchanged.
   *
   * @throws InvalidArgumentException the secret cannot sign: never sends an unsigned body by mistake
   */
  static withHash(body: JsonObject, secret: string): JsonObject {
    if (secret === '') return body;
    const hash = WebServiceSecureHash.calcHash(WebServiceSecureHash.compose(body), secret);
    if (hash === '') {
      throw new InvalidArgumentException('Web Service secureHashValue could not be computed — check the secure hash key');
    }
    const signed = body.clone();
    signed.remove(WebServiceSecureHash.FIELD);
    signed.set(WebServiceSecureHash.FIELD, hash);
    return signed;
  }
}
