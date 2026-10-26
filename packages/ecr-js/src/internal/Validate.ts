import { NetText } from './NetText.js';
import { ltrim, padLeft } from './text.js';

/**
 * Argument shaping shared by the Wi-Fi and Web Service messages, as the
 * Windows SDK does it.
 *
 * @internal
 */
export class Validate {
  /** Width the terminal stores and looks up receipt numbers by. */
  static readonly STAN_DIGITS = 6;

  /**
   * The terminal stores receipt numbers padded; an operator types "24". Every
   * character that is not a digit is dropped, as in the Windows SDK; "" when
   * no digit other than zero is left.
   */
  static paddedStan(stan: string): string {
    // `char.IsDigit`: any decimal digit, not only 0-9. Padded by UTF-16 length, as `PadLeft`.
    const digits = ltrim(String(stan ?? '').replace(/[^\p{Nd}]/gu, ''), '0');
    return digits === '' ? '' : padLeft(digits, Validate.STAN_DIGITS);
  }

  /** `string.IsNullOrWhiteSpace`. */
  static isBlank(text: string | null | undefined): boolean {
    return NetText.isBlank(text);
  }
}
