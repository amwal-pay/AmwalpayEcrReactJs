import { OverflowException } from './exception/errors.js';
import { InvalidRequestException } from './exception/InvalidRequestException.js';
import { ltrim, padLeft, rtrim, trim } from './internal/text.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * Money, in exact decimal text: the JavaScript stand-in for the Windows SDK's
 * `decimal`. Amounts enter as strings (`"1.234"`), integers (`5`, `5n`) or
 * fractional numbers (`1.234`, read through their shortest exact form), and are
 * rounded half away from zero to the currency's decimal places, then sent as
 * minor units: `"1.234"` OMR travels as `000000001234`.
 *
 * As in the Windows SDK, the amount itself is not judged: zero and negative
 * amounts are sent as they are, and the terminal or the Hub answers them.
 */
export class Amount {
  private constructor(readonly decimal: string) {}

  /** An amount in major units, e.g. `Amount.of('1.234')`. */
  static of(amount: string | number | bigint | Amount): Amount {
    if (amount instanceof Amount) return amount;
    if (typeof amount === 'bigint') return new Amount(amount.toString());
    let text: string;
    if (typeof amount === 'number') {
      if (!Number.isFinite(amount)) throw new InvalidRequestException('An amount must be a finite number');
      // The shortest text that reads back as the same number: 1.005 stays 1.005.
      text = String(amount);
    } else if (typeof amount === 'string') {
      text = amount;
    } else {
      throw new InvalidRequestException('An amount is a decimal in major units, such as "1.234"');
    }
    const plain = Amount.plain(trim(text));
    if (plain === null) throw new InvalidRequestException(`An amount is a decimal in major units, such as "1.234": was "${text}"`);
    return new Amount(plain);
  }

  /** An amount already in minor units: `Amount.fromMinorUnits(1234, 3)` is 1.234. */
  static fromMinorUnits(minorUnits: number | bigint, digits: number): Amount {
    if (typeof minorUnits === 'number' && !Number.isSafeInteger(minorUnits)) {
      throw new InvalidRequestException(`Minor units are a whole number (was ${minorUnits})`);
    }
    return new Amount(Amount.majorUnits(String(minorUnits), digits));
  }

  /**
   * Minor units for a currency with `digits` decimal places, rounded half away
   * from zero, as the Web Service carries them (a 64-bit integer).
   *
   * @throws OverflowException the amount does not fit 64 bits, as .NET's `checked` cast
   */
  toMinorUnits(digits: number): bigint {
    const value = BigInt(this.minorUnitsText(digits));
    if (value < INT64_MIN || value > INT64_MAX) throw new OverflowException('Arithmetic operation resulted in an overflow.');
    return value;
  }

  /**
   * Minor units padded to 12 characters, as the Wi-Fi message carries them
   * (ISO 8583 field 4). Like the Windows SDK, longer or negative values are
   * padded as text and not refused.
   */
  toWire(digits: number): string {
    return padLeft(this.minorUnitsText(digits), 12);
  }

  /** The amount rounded to `digits` places, e.g. `1.234`. */
  format(digits: number): string {
    return Amount.majorUnits(this.minorUnitsText(digits), digits);
  }

  /**
   * `Math.Round(amount, digits, MidpointRounding.AwayFromZero) * 10^digits`,
   * truncated and written as an integer: `-1234`, `0`, `1234567890123`.
   */
  minorUnitsText(digits: number): string {
    const negative = this.decimal.startsWith('-');
    const [whole = '', fraction = ''] = ltrim(this.decimal, '-').split('.', 2) as [string?, string?];
    const kept = fraction.slice(0, digits).padEnd(digits, '0');
    const roundUp = fraction.length > digits && fraction[digits]! >= '5';

    let text = ltrim(whole + kept, '0');
    if (roundUp) text = Amount.increment(text === '' ? '0' : text);
    if (text === '') return '0';
    return negative ? '-' + text : text;
  }

  toString(): string {
    return this.decimal;
  }

  toJSON(): string {
    return this.decimal;
  }

  /**
   * Minor units off the wire, read as major units: `000000000365` is `0.365`
   * with three decimals. Text that is not an integer is returned as it is: a
   * terminal that sends `1.234` is already reporting major units.
   */
  static majorUnits(minorUnits: string, digits: number): string {
    if (minorUnits === '') return '';
    const m = /^([+-]?)([0-9]+)$/.exec(minorUnits);
    if (m === null) return minorUnits;
    const negative = m[1] === '-';
    let text = ltrim(m[2]!, '0');
    const isZero = text === '';
    text = isZero ? '0' : text;
    if (digits > 0) {
      text = padLeft(text, digits + 1);
      text = text.slice(0, -digits) + '.' + text.slice(-digits);
    }
    return negative && !isZero ? '-' + text : text;
  }

  /** `[-]digits[.digits]`, without a leading `+` or exponent, or null when `text` is not a number. */
  private static plain(text: string): string | null {
    const m = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]{1,4}))?$/.exec(text);
    if (m === null || (m[2] ?? '') + (m[3] ?? '') === '') return null;
    let whole = m[2]!;
    let fraction = m[3] ?? '';
    const exponent = Number(m[4] ?? 0);
    if (exponent > 0) {
      whole += fraction.slice(0, exponent).padEnd(exponent, '0');
      fraction = fraction.slice(exponent);
    } else if (exponent < 0) {
      whole = padLeft(whole, -exponent);
      fraction = whole.slice(exponent) + fraction;
      whole = whole.slice(0, exponent);
    }
    whole = ltrim(whole, '0');
    fraction = rtrim(fraction, '0');
    const result = (whole === '' ? '0' : whole) + (fraction === '' ? '' : '.' + fraction);
    return m[1] === '-' && result !== '0' ? '-' + result : result;
  }

  /** Adds one to a string of decimal digits. */
  private static increment(digits: string): string {
    const chars = digits.split('');
    let i = chars.length - 1;
    while (i >= 0 && chars[i] === '9') {
      chars[i] = '0';
      i--;
    }
    if (i < 0) return '1' + chars.join('');
    chars[i] = String(Number(chars[i]) + 1);
    return chars.join('');
  }
}
