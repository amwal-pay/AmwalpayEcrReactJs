/**
 * Text helpers that behave like the PHP functions the rules were written with,
 * so a value the PHP SDK accepts is accepted here and one it refuses is refused.
 *
 * @internal
 */

/** PHP's default `trim()` set: space, tab, newline, carriage return, NUL, vertical tab. */
const TRIMMED = ' \t\n\r\0\x0B';

export function trim(text: string, characters: string = TRIMMED): string {
  let start = 0;
  let end = text.length;
  while (start < end && characters.includes(text[start]!)) start++;
  while (end > start && characters.includes(text[end - 1]!)) end--;
  return text.slice(start, end);
}

export function ltrim(text: string, characters: string = TRIMMED): string {
  let start = 0;
  while (start < text.length && characters.includes(text[start]!)) start++;
  return text.slice(start);
}

export function rtrim(text: string, characters: string = TRIMMED): string {
  let end = text.length;
  while (end > 0 && characters.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** Whether every character is an ASCII hex digit (PHP `ctype_xdigit`, false for ""). */
export function isHex(text: string): boolean {
  return /^[0-9A-Fa-f]+$/.test(text);
}

/** Byte length of `text` as UTF-8, which is what PHP's `strlen` counts. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** PHP `strcmp` on the UTF-8 bytes: ordinal, so "B" sorts before "a". */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Whether `text` has no lone surrogate, so it can be written as UTF-8. */
export function isWellFormed(text: string): boolean {
  const native = (text as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof native === 'function') return native.call(text);
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** Left-pads `text` with `pad` to `length` characters (PHP `str_pad(..., STR_PAD_LEFT)`). */
export function padLeft(text: string, length: number, pad = '0'): string {
  return text.length >= length ? text : pad.repeat(length - text.length) + text;
}
