/**
 * POS-style amount entry, as the merchant app and the Windows samples do it:
 * the field shows three decimals and keyed digits shift in from the right, so
 * 1 gives 0.001 and 1234 gives 1.234. The keyed digits are mills.
 * Also holds the amount bounds of the POS purchase form.
 */
export class AmountEntry {
  /** POS: minAmount = 10 / 1000. */
  static MIN_MILLS = 10;

  /** POS: amountLimit / 1000. Change it to match the limit configured for your terminals. */
  static MAX_MILLS = 100_000_000;

  static FRACTION_DIGITS = 3;

  /** Digits the field accepts: enough to key the maximum and no more. */
  static maxDigits() {
    return String(AmountEntry.MAX_MILLS).length;
  }

  /** ASCII digits only, no leading zeros, capped. */
  static keyedDigits(text) {
    const digits = String(text ?? '').replace(/[^0-9]/g, '').replace(/^0+/, '');
    return digits.slice(0, AmountEntry.maxDigits());
  }

  static mills(digits) {
    return digits === '' ? 0 : Number(digits);
  }

  /** Keyed digits as 0.000. */
  static format(digits) {
    const padded = (digits === '' ? '0' : digits).padStart(AmountEntry.FRACTION_DIGITS + 1, '0');
    const whole = padded.slice(0, -AmountEntry.FRACTION_DIGITS).replace(/^0+/, '');
    return `${whole === '' ? '0' : whole}.${padded.slice(-AmountEntry.FRACTION_DIGITS)}`;
  }

  static formatMills(mills) {
    return AmountEntry.format(String(mills));
  }
}
