import { describe, expect, it } from 'vitest';
import { Amount } from '../../src/Amount.js';
import { EcrIOException } from '../../src/channel/EcrChannel.js';
import { EcrFrames } from '../../src/channel/EcrFrames.js';
import { EcrConfig } from '../../src/EcrConfig.js';
import { EcrTransactionType } from '../../src/EcrTransactionType.js';
import { EcrMessage } from '../../src/internal/EcrMessage.js';
import { EcrMessageCodec } from '../../src/internal/EcrMessageCodec.js';

/** The framing is a contract with the terminal, which has its own copy: these pin the bytes. */
const bytes = (...values: number[]): Buffer => Buffer.from(values);

describe('EcrFrames', () => {
  it('puts a big-endian length in front of the body', () => {
    expect(EcrFrames.wrap(bytes(1, 2, 3))).toEqual(bytes(0, 3, 1, 2, 3));
    expect(EcrFrames.wrap('')).toEqual(bytes(0, 0));
  });

  it.each([
    [255, 0x00, 0xff],
    [256, 0x01, 0x00],
    [300, 0x01, 0x2c],
    [65535, 0xff, 0xff],
  ])('uses both header bytes at the boundary %i', (length, high, low) => {
    const packet = EcrFrames.wrap(Buffer.alloc(length));
    expect(packet.length).toBe(length + 2);
    expect(packet[0]).toBe(high);
    expect(packet[1]).toBe(low);
    expect(EcrFrames.bodyLength(packet)).toBe(length);
  });

  it('refuses a body too long for the header rather than truncating it', () => {
    expect(() => EcrFrames.wrap('x'.repeat(EcrFrames.MAX_BODY_BYTES + 1))).toThrow(EcrIOException);
    expect(() => EcrFrames.wrap('x'.repeat(EcrFrames.MAX_BODY_BYTES + 1))).toThrow('does not fit a frame');
  });

  it('reads the body length as unsigned', () => {
    expect(EcrFrames.bodyLength(bytes(0x80, 0x00))).toBe(32768);
    expect(EcrFrames.bodyLength(bytes(0xff, 0xff))).toBe(65535);
  });

  it('reads exactly one message and leaves the rest', () => {
    const data = Buffer.from('\x00\x02AB\x00\x01C', 'latin1');
    const cursor = { offset: 0 };
    expect(EcrFrames.readBodyFrom(data, cursor).toString()).toBe('AB');
    expect(cursor.offset).toBe(4);
    expect(EcrFrames.readBodyFrom(data, cursor).toString()).toBe('C');
  });

  it('counts bytes, not characters', () => {
    const packet = EcrFrames.wrap('é€');
    expect(packet[1]).toBe(5);
    expect(EcrFrames.readBodyFrom(packet).toString('utf8')).toBe('é€');
  });

  it('reads a stream that ends early as a closed connection', () => {
    const cases: Array<[Buffer, string]> = [
      [bytes(0), 'response header'],
      [bytes(), 'response header'],
      [Buffer.from('\x00\x08AB', 'latin1'), 'response body'],
    ];
    for (const [data, what] of cases) {
      expect(() => EcrFrames.readBodyFrom(data)).toThrow('closed the connection while sending the ' + what);
    }
  });

  it('reads a zero-length header as an empty message', () => {
    expect(() => EcrFrames.readBodyFrom(bytes(0, 0))).toThrow('empty message');
  });

  it('round-trips an encoded message, and a large one uses the high byte', () => {
    const big = EcrMessage.build(EcrTransactionType.Sale, new EcrConfig({ ecrId: 'E'.repeat(400) }), 'TW1', { amount: Amount.of('1.234') });
    const packet = EcrMessageCodec.encode(big);
    expect(packet[0]).not.toBe(0);
    const decoded = EcrMessageCodec.parse(EcrFrames.readBodyFrom(packet));
    expect(decoded.str('ecrId')).toBe('E'.repeat(400));
    expect(decoded.str('amount')).toBe('000000001234');
  });

  it('refuses a request over the frame limit', () => {
    const huge = EcrMessage.build(EcrTransactionType.Sale, new EcrConfig({ ecrId: 'E'.repeat(EcrFrames.MAX_BODY_BYTES) }), 'TW1', { amount: Amount.of('1') });
    expect(() => EcrMessageCodec.encode(huge)).toThrow(EcrIOException);
  });

  it('reports an unreadable answer as not valid JSON', () => {
    const bodies: Array<string | Uint8Array> = ['not json', 'null', '[1,2]', '"text"', '42', '', '{"a":1,"a":2}', bytes(0xff, 0xfe)];
    for (const body of bodies) {
      expect(() => EcrMessageCodec.parse(body), String(body)).toThrow('not valid JSON');
    }
  });

  it('keeps unknown fields', () => {
    expect(EcrMessageCodec.parse('{"responseCode":"00","somethingNew":"x"}').str('somethingNew')).toBe('x');
  });
});
