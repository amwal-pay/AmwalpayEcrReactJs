import { randomBytes } from 'node:crypto';
import { InvalidRequestException } from '../exception/InvalidRequestException.js';
import { NetText } from './NetText.js';

/**
 * The rules for a merchant reference: at most 32 characters of printable ASCII,
 * with space, `&` and `=` excluded. Surrounding space is trimmed.
 *
 * `&` and `=` are the separators of a signed message's input, so a reference
 * holding one could make two different messages hash alike. A space is
 * invisible in logs and on receipts, where it turns two references into one.
 *
 * @internal
 */
export class MerchantReference {
  static readonly MAX_LENGTH = 32;

  /**
   * The reference to put on the message: the caller's own, or a new one when
   * the caller gave none.
   *
   * @throws InvalidRequestException the reference is too long or carries characters the wire cannot represent
   */
  static resolve(supplied: string | null | undefined): string {
    const trimmed = NetText.trim(String(supplied ?? ''));
    if (trimmed === '') return MerchantReference.generate();
    const length = NetText.length(trimmed);
    if (length > MerchantReference.MAX_LENGTH) {
      throw new InvalidRequestException(`A merchant reference is at most ${MerchantReference.MAX_LENGTH} characters, was ${length}`);
    }
    // 0x21..0x7E is printable ASCII without the space.
    if (!/^[\x21-\x7E]+$/.test(trimmed) || /[&=]/.test(trimmed)) {
      throw new InvalidRequestException(
        `A merchant reference takes printable ASCII without spaces, '&' or '=': was "${trimmed}"`,
      );
    }
    return trimmed;
  }

  /** Same shape the Windows SDK generates: 12 uppercase hex characters. */
  static generate(): string {
    return randomBytes(6).toString('hex').toUpperCase();
  }
}
