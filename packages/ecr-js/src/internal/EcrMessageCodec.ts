import { EcrIOException } from '../channel/EcrChannel.js';
import { EcrFrames } from '../channel/EcrFrames.js';
import { Json, JsonException, type JsonObject } from '../json/Json.js';
import type { EcrMessage } from './EcrMessage.js';
import { NetText } from './NetText.js';

/**
 * The Wi-Fi wire format: a 2-byte big-endian length, then UTF-8 JSON. The
 * terminal has one file that matches this; the two change together.
 *
 * @internal
 */
export class EcrMessageCodec {
  /** Frames a message ready to write to the socket. */
  static encode(message: EcrMessage): Buffer {
    const body = Json.write(message.json);
    if (Buffer.byteLength(body, 'utf8') > EcrFrames.MAX_BODY_BYTES) {
      throw new EcrIOException(`Request exceeds ${EcrFrames.MAX_BODY_BYTES} bytes`);
    }
    return EcrFrames.wrap(body);
  }

  /**
   * One answer body, as the object it claims to be. Rejects null, arrays, bare
   * values, repeated keys and lenient JSON.
   *
   * @throws EcrIOException "not valid JSON", read as a malformed answer
   */
  static parse(body: Uint8Array | string): JsonObject {
    // As `Encoding.UTF8.GetString`: an invalid byte becomes U+FFFD, not a refusal.
    const payload = NetText.scrubUtf8(body);
    try {
      return Json.parseObject(payload);
    } catch (error) {
      if (error instanceof JsonException) {
        throw new EcrIOException('Terminal returned a message that is not valid JSON: ' + payload, { cause: error });
      }
      throw error;
    }
  }
}
