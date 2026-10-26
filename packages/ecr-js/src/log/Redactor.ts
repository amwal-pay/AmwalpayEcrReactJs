/**
 * Masks what must never reach a log, applied to every line the SDK writes.
 *
 * The terminal only ever sends masked card numbers, and the SDK never logs its
 * signing secret. This is the second line of defence, for the day a terminal,
 * a Hub or a caller's own text carries something it should not:
 *
 * - a run of 13 to 19 digits that passes the Luhn check is masked to its first
 *   six and last four digits;
 * - the values of fields named like a PIN, CVV, track data, token, password or
 *   secret are replaced with `***`.
 */
export class Redactor {
  private static readonly SENSITIVE_FIELDS = 'pin|pinBlock|pinblock|cvv|cvv2|cvc|cvc2|track1|track2|track2Data|trackData|'
    + 'token|accessToken|refreshToken|password|secret|secretKey|secureHashKey|apiKey|key';

  private static readonly FIELD_PATTERN = new RegExp(
    '"(' + Redactor.SENSITIVE_FIELDS + ')"(\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?[0-9][0-9.eE+-]*)',
    'gi',
  );

  static line(line: string): string {
    const masked = line.replace(Redactor.FIELD_PATTERN, (_m, name: string, colon: string) => `"${name}"${colon}"***"`);
    return masked.replace(/(?<![0-9])[0-9]{13,19}(?![0-9])/g, (digits) => (Redactor.luhn(digits) ? Redactor.mask(digits) : digits));
  }

  /** `5431731234565785` becomes `543173******5785`. */
  static mask(pan: string): string {
    return pan.slice(0, 6) + '*'.repeat(pan.length - 10) + pan.slice(-4);
  }

  static luhn(digits: string): boolean {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }
}
