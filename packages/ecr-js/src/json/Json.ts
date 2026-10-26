import { InvalidArgumentException } from '../exception/errors.js';
import { compareBytes, isWellFormed } from '../internal/text.js';

/** The text is not the single, strict JSON value it was expected to be. */
export class JsonException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonException';
  }
}

/**
 * A JSON number kept exactly as it was written.
 *
 * `JSON.parse` turns `961.10` into `961.1` and `1E3` into `1000`. A signature is
 * computed over the number's text, so a reader that re-spells numbers would fail
 * to verify an answer the terminal signed correctly. The text is kept, and only
 * ever compared or copied as text.
 */
export class JsonNumber {
  constructor(readonly raw: string) {}

  toString(): string {
    return this.raw;
  }
}

/**
 * A value inside a {@link JsonObject} or {@link JsonArray}. Integers the SDK sets
 * itself may be `number` (a safe integer) or `bigint`; numbers read off the wire
 * are always {@link JsonNumber}. Never a float: money must not pass through one.
 */
export type JsonValue = string | boolean | null | number | bigint | JsonNumber | JsonObject | JsonArray;

function checked(value: unknown): JsonValue {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint'
    || value instanceof JsonNumber || value instanceof JsonObject || value instanceof JsonArray
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    // A float has no exact text; money must never pass through one.
    throw new InvalidArgumentException('JSON values must not be floats; use JsonNumber or a string');
  }
  throw new InvalidArgumentException('Unsupported JSON value of type ' + (value === undefined ? 'undefined' : typeof value));
}

/**
 * A JSON array. Kept apart from {@link JsonObject} so the two can never be
 * confused the way two plain JavaScript values can.
 */
export class JsonArray implements Iterable<JsonValue> {
  readonly #items: JsonValue[];

  constructor(items: readonly unknown[] = []) {
    this.#items = items.map(checked);
  }

  items(): JsonValue[] {
    return [...this.#items];
  }

  count(): number {
    return this.#items.length;
  }

  get length(): number {
    return this.#items.length;
  }

  [Symbol.iterator](): Iterator<JsonValue> {
    return this.#items[Symbol.iterator]();
  }

  /** A deep copy. */
  clone(): JsonArray {
    return new JsonArray(this.#items.map(cloneValue));
  }
}

function cloneValue(value: JsonValue): JsonValue {
  return value instanceof JsonObject || value instanceof JsonArray ? value.clone() : value;
}

/**
 * A JSON object that keeps its keys in order and its values exactly as they
 * arrived.
 *
 * Everything here reads a value the way the terminal's own code reads it: any
 * scalar as text, JSON `null` as absent.
 */
export class JsonObject implements Iterable<[string, JsonValue]> {
  readonly #values = new Map<string, JsonValue>();

  constructor(values: Record<string, unknown> | Iterable<[string, unknown]> = {}) {
    const entries = Symbol.iterator in Object(values)
      ? (values as Iterable<[string, unknown]>)
      : Object.entries(values as Record<string, unknown>);
    for (const [key, value] of entries) this.set(String(key), value);
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  /** The value, or null when absent. */
  get(key: string): JsonValue {
    return this.#values.has(key) ? this.#values.get(key)! : null;
  }

  /** Replaces the value in place, or appends a new key at the end. */
  set(key: string, value: unknown): this {
    this.#values.set(key, checked(value));
    return this;
  }

  remove(key: string): this {
    this.#values.delete(key);
    return this;
  }

  keys(): string[] {
    return [...this.#values.keys()];
  }

  count(): number {
    return this.#values.size;
  }

  [Symbol.iterator](): Iterator<[string, JsonValue]> {
    return this.#values.entries();
  }

  /**
   * Reads a field as text, whatever JSON type it arrived as. A field sent as
   * JSON `null`, or not sent, reads as "" rather than as the word "null". A
   * nested object or array reads as its compact JSON.
   */
  str(key: string): string {
    const value = this.get(key);
    return value === null ? '' : Json.content(value);
  }

  /** The field when it is an object, otherwise null. */
  obj(key: string): JsonObject | null {
    const value = this.get(key);
    return value instanceof JsonObject ? value : null;
  }

  /** The field when it is an array, otherwise null. */
  arr(key: string): JsonArray | null {
    const value = this.get(key);
    return value instanceof JsonArray ? value : null;
  }

  /** A boolean field: only `true`/`false` (or their text) count, anything else is false. */
  flag(key: string): boolean {
    return this.strictBool(key) ?? false;
  }

  /** The field as a strict boolean, or null when absent or not `true`/`false`. */
  strictBool(key: string): boolean | null {
    const value = this.get(key);
    if (value === null || value instanceof JsonObject || value instanceof JsonArray) return null;
    const text = Json.content(value);
    return text === 'true' ? true : text === 'false' ? false : null;
  }

  /** Compact JSON text of this object. */
  toJson(): string {
    return Json.write(this);
  }

  /** A deep copy (PHP's `clone`). */
  clone(): JsonObject {
    const copy = new JsonObject();
    for (const [key, value] of this.#values) copy.set(key, cloneValue(value));
    return copy;
  }
}

/**
 * The one JSON reader and writer the SDK uses on the wire.
 *
 * Strict on purpose. The terminal signs the text it sends, so the reader keeps
 * numbers as written ({@link JsonNumber}) and refuses anything a lenient parser
 * would quietly "fix": a repeated key (two readings of one message is how a
 * decline gets read as an approval), trailing commas, comments, single quotes,
 * invalid UTF-8, lone surrogates, and trailing text; {@link Json.parseObject}
 * also refuses anything that is not one object.
 */
export class Json {
  /** Same limit as System.Text.Json, which the Windows SDK parses with. */
  static readonly MAX_DEPTH = 64;

  private pos = 0;
  private readonly length: number;

  private constructor(private readonly text: string) {
    this.length = text.length;
  }

  /**
   * Parses text that must be exactly one JSON object.
   *
   * @throws JsonException when it is anything else, or not valid JSON
   */
  static parseObject(text: string | Uint8Array): JsonObject {
    const value = Json.parse(text);
    if (!(value instanceof JsonObject)) throw new JsonException('The text is not a JSON object');
    return value;
  }

  /**
   * Parses any single JSON value. Bytes are read as strict UTF-8: an invalid
   * sequence is refused, not replaced.
   *
   * @throws JsonException
   */
  static parse(input: string | Uint8Array): JsonValue {
    const text = typeof input === 'string' ? input : Json.decode(input);
    if (text === '' || !isWellFormed(text)) {
      throw new JsonException(text === '' ? 'The text is empty' : 'The text is not valid UTF-8');
    }
    if (text.charCodeAt(0) === 0xfeff) throw new JsonException('The text starts with a byte order mark');
    const parser = new Json(text);
    parser.skipWhitespace();
    const value = parser.readValue(0);
    parser.skipWhitespace();
    if (parser.pos !== parser.length) throw parser.error('Unexpected text after the JSON value');
    return value;
  }

  /** Compact JSON text, with non-ASCII, `<`, `>`, `&` and `/` written as themselves. */
  static write(value: JsonValue): string {
    return Json.encode(value, null, 0);
  }

  /** Indented JSON text, for logs. */
  static pretty(value: JsonValue): string {
    return Json.encode(value, '  ', 0);
  }

  /**
   * The text of a value: a string unquoted, a number or boolean as written,
   * an object or array as compact JSON.
   */
  static content(value: JsonValue): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (value instanceof JsonNumber) return value.raw;
    if (value === null) return 'null';
    return Json.write(value);
  }

  /** Whether a value counts toward a signature: a string, number or boolean. */
  static isScalar(value: JsonValue): boolean {
    return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number'
      || typeof value === 'bigint' || value instanceof JsonNumber;
  }

  /**
   * The scalar entries of `json` whose key is not `excluded`, sorted by key
   * byte for byte, as `key=value&key=value`. Nulls, objects and arrays are left
   * out: two JSON libraries cannot be relied on to write them identically.
   */
  static compose(json: JsonObject, excluded: string): string {
    const pairs: Array<[string, string]> = [];
    for (const [key, value] of json) {
      if (key === excluded || !Json.isScalar(value)) continue;
      pairs.push([key, Json.content(value)]);
    }
    // Ordinal, like the terminal: "B" sorts before "a".
    pairs.sort((a, b) => compareBytes(a[0], b[0]));
    return pairs.map(([key, value]) => `${key}=${value}`).join('&');
  }

  // ── writing ───────────────────────────────────────────────────────

  private static encode(value: JsonValue, indent: string | null, level: number): string {
    if (value instanceof JsonObject) {
      if (value.count() === 0) return '{}';
      const parts: string[] = [];
      for (const [key, item] of value) {
        parts.push(Json.encodeString(key) + (indent === null ? ':' : ': ') + Json.encode(item, indent, level + 1));
      }
      return Json.wrap('{', '}', parts, indent, level);
    }
    if (value instanceof JsonArray) {
      if (value.count() === 0) return '[]';
      const parts: string[] = [];
      for (const item of value) parts.push(Json.encode(item, indent, level + 1));
      return Json.wrap('[', ']', parts, indent, level);
    }
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (value instanceof JsonNumber) return value.raw;
    if (typeof value === 'string') return Json.encodeString(value);
    throw new InvalidArgumentException('Unsupported JSON value of type ' + typeof value);
  }

  private static wrap(open: string, close: string, parts: string[], indent: string | null, level: number): string {
    if (indent === null) return open + parts.join(',') + close;
    const inner = indent.repeat(level + 1);
    return open + '\n' + inner + parts.join(',\n' + inner) + '\n' + indent.repeat(level) + close;
  }

  /**
   * A string as PHP's `json_encode(JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)`
   * writes it, byte for byte: the escapes the terminal's own reader and the other
   * SDKs agree on.
   */
  private static encodeString(text: string): string {
    if (!isWellFormed(text)) throw new InvalidArgumentException('A text field is not valid UTF-8 and cannot be sent');
    let out = '"';
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      switch (c) {
        case 0x22: out += '\\"'; break;
        case 0x5c: out += '\\\\'; break;
        case 0x08: out += '\\b'; break;
        case 0x0c: out += '\\f'; break;
        case 0x0a: out += '\\n'; break;
        case 0x0d: out += '\\r'; break;
        case 0x09: out += '\\t'; break;
        case 0x2028: out += '\\u2028'; break;
        case 0x2029: out += '\\u2029'; break;
        default:
          out += c < 0x20 ? '\\u' + c.toString(16).padStart(4, '0') : text[i];
      }
    }
    return out + '"';
  }

  // ── reading ───────────────────────────────────────────────────────

  private static decode(bytes: Uint8Array): string {
    try {
      // ignoreBOM keeps a byte order mark in the text, so it can be refused below.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new JsonException('The text is not valid UTF-8');
    }
  }

  private readValue(depth: number): JsonValue {
    if (this.pos >= this.length) throw this.error('Unexpected end of text');
    const c = this.text[this.pos]!;
    switch (c) {
      case '{': return this.readObject(depth + 1);
      case '[': return this.readArray(depth + 1);
      case '"': return this.readString();
      case 't': return this.readLiteral('true', true);
      case 'f': return this.readLiteral('false', false);
      case 'n': return this.readLiteral('null', null);
      default:
        if (c === '-' || (c >= '0' && c <= '9')) return this.readNumber();
        throw this.error(`Unexpected character '${c}'`);
    }
  }

  private readObject(depth: number): JsonObject {
    if (depth > Json.MAX_DEPTH) throw this.error('The JSON is nested too deeply');
    this.pos++; // {
    const object = new JsonObject();
    this.skipWhitespace();
    if (this.peek() === '}') {
      this.pos++;
      return object;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') throw this.error('Expected a property name in double quotes');
      const key = this.readString();
      if (object.has(key)) throw this.error(`The property '${key}' appears more than once`);
      this.skipWhitespace();
      if (this.peek() !== ':') throw this.error("Expected ':' after a property name");
      this.pos++;
      this.skipWhitespace();
      object.set(key, this.readValue(depth));
      this.skipWhitespace();
      const next = this.peek();
      this.pos++;
      if (next === '}') return object;
      if (next !== ',') throw this.error("Expected ',' or '}' in an object");
    }
  }

  private readArray(depth: number): JsonArray {
    if (depth > Json.MAX_DEPTH) throw this.error('The JSON is nested too deeply');
    this.pos++; // [
    const items: JsonValue[] = [];
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.pos++;
      return new JsonArray();
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.readValue(depth));
      this.skipWhitespace();
      const next = this.peek();
      this.pos++;
      if (next === ']') return new JsonArray(items);
      if (next !== ',') throw this.error("Expected ',' or ']' in an array");
    }
  }

  private readString(): string {
    this.pos++; // opening quote
    let out = '';
    for (;;) {
      // Copy the run up to the next quote, backslash or control character.
      let end = this.pos;
      while (end < this.length) {
        const code = this.text.charCodeAt(end);
        if (code === 0x22 || code === 0x5c || code < 0x20) break;
        end++;
      }
      out += this.text.slice(this.pos, end);
      this.pos = end;
      if (this.pos >= this.length) throw this.error('Unterminated string');
      const c = this.text[this.pos];
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c !== '\\') throw this.error('A control character must be escaped inside a string');
      this.pos++;
      const escape = this.peek();
      this.pos++;
      switch (escape) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': out += this.readUnicodeEscape(); break;
        default: throw this.error('Invalid escape sequence in a string');
      }
    }
  }

  private readUnicodeEscape(): string {
    const code = this.readHex4();
    if (code >= 0xd800 && code <= 0xdbff) {
      if (this.text.slice(this.pos, this.pos + 2) !== '\\u') {
        throw this.error('A high surrogate must be followed by a low surrogate');
      }
      this.pos += 2;
      const low = this.readHex4();
      if (low < 0xdc00 || low > 0xdfff) throw this.error('A high surrogate must be followed by a low surrogate');
      return String.fromCharCode(code, low);
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw this.error('A low surrogate without a high surrogate');
    return String.fromCharCode(code);
  }

  private readHex4(): number {
    const hex = this.text.slice(this.pos, this.pos + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw this.error('Invalid \\u escape');
    this.pos += 4;
    return parseInt(hex, 16);
  }

  private readNumber(): JsonNumber {
    const pattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    pattern.lastIndex = this.pos;
    const match = pattern.exec(this.text);
    if (match === null) throw this.error('Invalid number');
    this.pos += match[0].length;
    const next = this.peek();
    if (next !== null && ((next >= '0' && next <= '9') || next === '.' || next === 'e' || next === 'E')) {
      throw this.error('Invalid number');
    }
    return new JsonNumber(match[0]);
  }

  private readLiteral<T extends JsonValue>(word: string, value: T): T {
    if (this.text.slice(this.pos, this.pos + word.length) !== word) throw this.error('Invalid literal');
    this.pos += word.length;
    return value;
  }

  private skipWhitespace(): void {
    while (this.pos < this.length) {
      const c = this.text[this.pos];
      if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') break;
      this.pos++;
    }
  }

  private peek(): string | null {
    return this.pos < this.length ? this.text[this.pos]! : null;
  }

  private error(message: string): JsonException {
    return new JsonException(`${message} at offset ${this.pos}`);
  }
}
