import { InvalidArgumentException } from '../exception/errors.js';
import { EcrIOException } from './EcrChannel.js';

/**
 * The wire framing: a 2-byte big-endian length followed by that many bytes of
 * UTF-8 JSON. A TCP stream carries no message boundaries, so the header is what
 * says where one message ends.
 */
export class EcrFrames {
  static readonly HEADER_BYTES = 2;

  /** The header is two bytes, so nothing longer can be described. */
  static readonly MAX_BODY_BYTES = 0xffff;

  /**
   * Puts a length header in front of `body` (text is written as UTF-8).
   *
   * @throws EcrIOException when the body does not fit a frame
   */
  static wrap(body: Uint8Array | string): Buffer {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    if (bytes.length > EcrFrames.MAX_BODY_BYTES) {
      throw new EcrIOException(`Message of ${bytes.length} bytes does not fit a frame`);
    }
    const header = Buffer.alloc(EcrFrames.HEADER_BYTES);
    header.writeUInt16BE(bytes.length, 0);
    return Buffer.concat([header, bytes]);
  }

  /** The body length a 2-byte header announces. */
  static bodyLength(header: Uint8Array): number {
    if (header.length < EcrFrames.HEADER_BYTES) throw new InvalidArgumentException('A frame header is two bytes');
    return (header[0]! << 8) | header[1]!;
  }

  /**
   * Reads exactly one message body from a byte source.
   *
   * @param readExactly returns exactly `count` bytes or throws
   * @throws EcrIOException
   */
  static async readBody(readExactly: (count: number, what: string) => Promise<Uint8Array> | Uint8Array): Promise<Buffer> {
    const length = EcrFrames.bodyLength(await readExactly(EcrFrames.HEADER_BYTES, 'response header'));
    if (length <= 0) throw new EcrIOException('Terminal returned an empty message');
    return Buffer.from(await readExactly(length, 'response body'));
  }

  /** The error for a stream that ended part way through `what`. */
  static closed(what: string): EcrIOException {
    return new EcrIOException(`Terminal closed the connection while sending the ${what}`);
  }

  /**
   * Reads one framed body from bytes already in memory, starting at
   * `cursor.offset`, which is moved past it. For channels that already hold the bytes.
   *
   * @throws EcrIOException
   */
  static readBodyFrom(bytes: Uint8Array, cursor: { offset: number } = { offset: 0 }): Buffer {
    const take = (count: number, what: string): Buffer => {
      if (bytes.length - cursor.offset < count) throw EcrFrames.closed(what);
      const chunk = Buffer.from(bytes.subarray(cursor.offset, cursor.offset + count));
      cursor.offset += count;
      return chunk;
    };
    const length = EcrFrames.bodyLength(take(EcrFrames.HEADER_BYTES, 'response header'));
    if (length <= 0) throw new EcrIOException('Terminal returned an empty message');
    return take(length, 'response body');
  }
}
