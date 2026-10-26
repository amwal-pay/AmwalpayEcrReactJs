/**
 * .NET's string rules, for the few places where JavaScript's own would answer
 * differently from the Windows SDK: `string.Trim()`,
 * `string.IsNullOrWhiteSpace`, `string.Length` (UTF-16 code units) and
 * `Encoding.UTF8.GetString` (each invalid sequence becomes U+FFFD).
 *
 * @internal
 */
export class NetText {
  /** `char.IsWhiteSpace`: the Unicode white space .NET trims. Not JavaScript's set, which adds U+FEFF and drops U+0085. */
  private static readonly WHITE = '\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';

  private static readonly EDGES = new RegExp(`^[${NetText.WHITE}]+|[${NetText.WHITE}]+$`, 'gu');

  /** `string.Trim()`. */
  static trim(text: string): string {
    return String(text ?? '').replace(NetText.EDGES, '');
  }

  /** `string.IsNullOrWhiteSpace`. */
  static isBlank(text: string | null | undefined): boolean {
    return NetText.trim(text ?? '') === '';
  }

  /** `string.Length`: UTF-16 code units, so a character outside the BMP counts two (as JavaScript's own `length`). */
  static length(text: string): number {
    return text.length;
  }

  /** `Encoding.UTF8.GetString`: each maximal invalid subsequence becomes U+FFFD, and a BOM is kept. */
  static scrubUtf8(bytes: Uint8Array | string): string {
    return typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  }
}
