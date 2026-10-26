import { describe, expect, it } from 'vitest';
import { InvalidArgumentException } from '../../src/exception/errors.js';
import { Json, JsonArray, JsonException, JsonNumber, JsonObject } from '../../src/json/Json.js';

/**
 * The reader keeps numbers as written and refuses anything ambiguous, because
 * the terminal signs the text it sends. Mirrors WireEncodingTests and
 * EcrMessageCodecTests in the Windows SDK.
 */
const utf8 = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);
const withBytes = (before: string, bytes: number[], after: string): Uint8Array =>
  Buffer.concat([Buffer.from(before, 'utf8'), Buffer.from(bytes), Buffer.from(after, 'utf8')]);

describe('Json', () => {
  it('reads a number back exactly as written', () => {
    const json = Json.parseObject('{"a":0.258,"b":1E3,"c":-0.0,"d":"7","e":961.10,"big":12345678901234567890}');
    expect(json.str('a')).toBe('0.258');
    expect(json.str('b')).toBe('1E3');
    expect(json.str('c')).toBe('-0.0');
    expect(json.str('d')).toBe('7');
    expect(json.str('e')).toBe('961.10');
    expect(json.str('big')).toBe('12345678901234567890');
    expect(json.get('e')).toBeInstanceOf(JsonNumber);
  });

  it('treats only the literals true and false as booleans', () => {
    const json = Json.parseObject('{"a":true,"b":false,"c":"true","d":"false","e":1,"f":"yes","g":null,"h":{}}');
    expect(json.flag('a')).toBe(true);
    expect(json.flag('b')).toBe(false);
    expect(json.flag('c')).toBe(true);
    expect(json.flag('d')).toBe(false);
    expect(json.flag('e')).toBe(false);
    expect(json.flag('f')).toBe(false);
    expect(json.flag('g')).toBe(false);
    expect(json.flag('h')).toBe(false);
    expect(json.flag('missing')).toBe(false);
    expect(json.strictBool('e')).toBeNull();
    expect(json.strictBool('missing')).toBeNull();
    expect(json.strictBool('b')).toBe(false);
  });

  it('reads a JSON null as absent, not as the word null', () => {
    const json = Json.parseObject('{"authCode":null,"rrn":"1"}');
    expect(json.str('authCode')).toBe('');
    expect(json.str('missing')).toBe('');
    expect(json.str('rrn')).toBe('1');
  });

  it('reads a nested value as its compact JSON', () => {
    const json = Json.parseObject('{"data":{"a":1},"list":[1,2]}');
    expect(json.str('data')).toBe('{"a":1}');
    expect(json.str('list')).toBe('[1,2]');
  });

  it('writes non-ASCII and markup as themselves', () => {
    const text = Json.write(new JsonObject({ terminalSerial: 'Café ☕ تمت', ecrId: "<till>&'+`/" }));
    expect(text).toBe('{"terminalSerial":"Café ☕ تمت","ecrId":"<till>&\'+`/"}');
    expect(text).not.toContain('\\u');
  });

  it('escapes quotes, backslashes and control characters, and round-trips them', () => {
    const original = 'say "hi" \\ done\n\tend';
    const text = Json.write(new JsonObject({ ecrId: original }));
    expect(text).toContain('\\"hi\\"');
    expect(text).toContain('\\n');
    expect(Json.parseObject(text).str('ecrId')).toBe(original);
  });

  it('reads escaped unicode as the text it spells', () => {
    const json = Json.parseObject('{"message":"caf\\u00e9 \\u062a\\u0645","emoji":"\\ud83d\\ude00"}');
    expect(json.str('message')).toBe('café تم');
    expect(json.str('emoji')).toBe('\u{1F600}');
  });

  it('keeps keys that look like numbers as text, in order', () => {
    const json = Json.parseObject('{"1":"a","0":"b"}');
    expect(json.keys()).toEqual(['1', '0']);
    expect(json.toJson()).toBe('{"1":"a","0":"b"}');
  });

  it('refuses floats when building a message', () => {
    expect(() => new JsonObject({ amount: 1.234 })).toThrow(InvalidArgumentException);
  });

  it('refuses text that is not well-formed when writing', () => {
    // A JavaScript string cannot hold invalid UTF-8 bytes; a lone surrogate is its counterpart.
    expect(() => Json.write(new JsonObject({ ecrId: 'x\uD800y' }))).toThrow(InvalidArgumentException);
  });

  it('indents a pretty print', () => {
    const text = Json.pretty(new JsonObject({ a: 1, b: new JsonObject({ c: true }), d: new JsonArray(), e: new JsonObject() }));
    expect(text).toBe('{\n  "a": 1,\n  "b": {\n    "c": true\n  },\n  "d": [],\n  "e": {}\n}');
  });

  it.each(['null', '[1,2]', '"text"', '42', '', '   '])('refuses valid JSON that is not an object: %j', (text) => {
    expect(() => Json.parseObject(text)).toThrow(JsonException);
  });

  it.each([
    ['top level', '{"a":1,"a":2}'],
    ['success twice', '{"success":false,"success":true,"responseCode":"00"}'],
    ['nested', '{"data":{"x":1,"x":2}}'],
    ['inside an array', '{"list":[{"x":1,"x":2}]}'],
  ])('refuses a repeated key anywhere, never last-wins: %s', (_name, text) => {
    expect(() => Json.parseObject(text)).toThrow(JsonException);
  });

  it.each<[string, string | Uint8Array]>([
    ['trailing comma', '{"a":1,}'],
    ['comment', '{"a":1 /* note */}'],
    ['single quotes', "{'a':1}"],
    ['leading zero', '{"a":01}'],
    ['bare word', '{"a":yes}'],
    ['NaN', '{"a":NaN}'],
    ['raw newline in string', '{"a":"x\ny"}'],
    ['invalid escape', '{"a":"\\x"}'],
    ['lone surrogate', '{"a":"\\ud800"}'],
    ['invalid utf-8', withBytes('{"a":"', [0xc3, 0x28], '"}')],
    ['byte order mark', withBytes('', [0xef, 0xbb, 0xbf], '{"a":1}')],
    ['byte order mark as text', '﻿{"a":1}'],
    ['trailing text', '{"a":1} x'],
    ['unterminated', '{"a":"x'],
    ['two objects', '{"a":1}{"b":2}'],
  ])('does not accept lenient JSON: %s', (_name, text) => {
    expect(() => Json.parseObject(text)).toThrow(JsonException);
  });

  it('refuses nesting deeper than the limit', () => {
    expect(() => Json.parseObject('{"a":'.repeat(70) + '1' + '}'.repeat(70))).toThrow(JsonException);
  });

  it('composes scalars sorted ordinally and skips the rest', () => {
    const json = Json.parseObject('{"a":"1","B":"2","_c":"3","Z":"4","n":null,"o":{"x":1},"l":[1],"t":true,"secureHash":"X"}');
    expect(Json.compose(json, 'secureHash')).toBe('B=2&Z=4&_c=3&a=1&t=true');
  });

  it('accepts bytes that are valid UTF-8', () => {
    expect(Json.parseObject(utf8(0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d)).str('a')).toBe('1');
  });
});
