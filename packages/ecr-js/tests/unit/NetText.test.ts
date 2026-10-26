import { describe, expect, it } from 'vitest';
import { EcrIOException } from '../../src/channel/EcrChannel.js';
import { EcrEnvironment } from '../../src/EcrEnvironment.js';
import { EcrMessageCodec } from '../../src/internal/EcrMessageCodec.js';
import { NetText } from '../../src/internal/NetText.js';
import { ResponseEnvelope } from '../../src/internal/ResponseEnvelope.js';
import { Json } from '../../src/json/Json.js';

/** The places where .NET's string rules decide what the Windows SDK does. */
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe('NetText', () => {
  it('trims as string.Trim(): Unicode white space, but not NUL', () => {
    expect(NetText.trim(' \f A B \n')).toBe('A B');
    expect(NetText.trim(' A\0')).toBe('A\0');
    expect(NetText.trim('﻿A')).toBe('﻿A');
    expect(NetText.trim('\u0085A')).toBe('A');
    expect(NetText.isBlank('　\t')).toBe(true);
    expect(NetText.isBlank('\0')).toBe(false);
  });

  it('counts length in UTF-16 code units', () => {
    expect(NetText.length('abc')).toBe(3);
    expect(NetText.length('é')).toBe(1);
    expect(NetText.length('\u{1F600}')).toBe(2);
  });

  it('turns invalid UTF-8 in an answer into the replacement character', () => {
    expect(NetText.scrubUtf8(bytes(0x61, 0xff, 0x62))).toBe('a�b');
    expect(NetText.scrubUtf8(bytes(0xe2, 0x82)), 'a truncated sequence is one replacement').toBe('�');
    expect(NetText.scrubUtf8(bytes(0xc0, 0xaf))).toBe('��');

    const answer = EcrMessageCodec.parse(Buffer.concat([Buffer.from('{"success":true,"responseCode":"00","message":"'), Buffer.from([0xff]), Buffer.from('"}')]));
    expect(answer.str('message')).toBe('�');
  });

  it('quotes an unreadable answer in full', () => {
    const body = 'x'.repeat(300);
    expect(() => EcrMessageCodec.parse(Buffer.from(body))).toThrow(EcrIOException);
    expect(() => EcrMessageCodec.parse(Buffer.from(body))).toThrow('Terminal returned a message that is not valid JSON: ' + body);
  });

  it('trims environment names and error lists as .NET does', () => {
    expect(EcrEnvironment.fromName(' prod')).toBe(EcrEnvironment.PROD);
    expect(ResponseEnvelope.errorList(Json.parseObject('{"errorList":[" "," Card declined "]}'))).toEqual(['Card declined']);
  });
});
