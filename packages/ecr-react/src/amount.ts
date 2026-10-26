// POS-style amount entry: the port of Core's AmountEntry and the WPF AmountInput.
//
// The field always shows three decimals and typed digits shift in from the right, so
// 1 gives 0.001, 12 gives 0.012, 1234 gives 1.234. Backspace shifts them back out and
// the box reads 0.000 when empty. There is no decimal point to type. The keyed digits
// are the source of truth; everything shown is derived from them.

export const FRACTION_DIGITS = 3;

/** Digits only, no leading zeros, capped so the terminal's limit cannot be over-keyed. */
export function keyedDigits(text: string, maxDigits: number): string {
  const digits = String(text).replace(/[^0-9]/g, '').replace(/^0+/, '');
  return digits.length <= maxDigits ? digits : digits.slice(0, maxDigits);
}

/** Renders keyed digits as 0.000, shifting them in from the right. */
export function formatAmount(digits: string): string {
  const padded = (digits.length === 0 ? '0' : digits).padStart(FRACTION_DIGITS + 1, '0');
  const whole = padded.slice(0, -FRACTION_DIGITS).replace(/^0+/, '');
  return `${whole === '' ? '0' : whole}.${padded.slice(-FRACTION_DIGITS)}`;
}

/** Digits after one more key: the new digit shifts in from the right. */
export function appendDigit(digits: string, digit: string, maxDigits: number): string {
  return keyedDigits(digits + digit, maxDigits);
}

/** Digits after backspace: the last one shifts back out. */
export function backspaceDigit(digits: string): string {
  return digits.slice(0, -1);
}
