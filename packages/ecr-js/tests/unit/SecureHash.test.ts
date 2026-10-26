import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Amount } from '../../src/Amount.js';
import { EcrConfig } from '../../src/EcrConfig.js';
import { EcrTransactionType } from '../../src/EcrTransactionType.js';
import { InvalidArgumentException } from '../../src/exception/errors.js';
import { EcrMessage } from '../../src/internal/EcrMessage.js';
import { SecureHash } from '../../src/internal/SecureHash.js';
import { JsonArray, JsonObject } from '../../src/json/Json.js';
import { TestKeys } from '../support/keys.js';
import { Wire } from '../support/wire.js';

/**
 * The Wi-Fi signing contract with the terminal. Known answers are the Windows
 * SDK's, computed with Python's hmac and from RFC 4231, so a bug here cannot
 * also be in the oracle.
 */
const hmac = (text: string, key: Buffer | string): string => createHmac('sha256', key).update(text, 'utf8').digest('hex').toUpperCase();

function signed(body: JsonObject, key: string): JsonObject {
  return body.set('secureHash', SecureHash.sign(SecureHash.compose(body), key));
}

function build(config: EcrConfig): EcrMessage {
  return EcrMessage.build(EcrTransactionType.Sale, config, 'TW1', { amount: Amount.of('1.234') });
}

describe('SecureHash', () => {
  it('signs fields in sorted order', () => {
    const json = new JsonObject({ messageType: 'SALE', amount: '000000001234', version: 1 });
    expect(SecureHash.compose(json)).toBe('amount=000000001234&messageType=SALE&version=1');
  });

  it('is not changed by insertion order', () => {
    expect(SecureHash.compose(new JsonObject({ b: '2', a: '1' }))).toBe(SecureHash.compose(new JsonObject({ a: '1', b: '2' })));
  });

  it('sorts ordinally, not culture-aware', () => {
    expect(SecureHash.compose(new JsonObject({ a: '1', B: '2', _c: '3', Z: '4' }))).toBe('B=2&Z=4&_c=3&a=1');
  });

  it('never signs the signature field', () => {
    expect(SecureHash.compose(new JsonObject({ amount: '1' }))).toBe(SecureHash.compose(new JsonObject({ amount: '1', secureHash: 'WHATEVER' })));
  });

  it('leaves out nested data, nulls and arrays', () => {
    const json = new JsonObject({
      amount: '1',
      data: new JsonObject({ transactionId: 'x' }),
      list: new JsonArray(['a', 'b']),
      missing: null,
    });
    expect(SecureHash.compose(json)).toBe('amount=1');
  });

  it('signs booleans and numbers as written', () => {
    expect(SecureHash.compose(new JsonObject({ success: true, responseCode: '00' }))).toBe('responseCode=00&success=true');
    expect(SecureHash.compose(Wire.obj('{"version":1,"terminalId":30001,"amount":961.1,"authorizeAmount":50.0,"big":12345678901234567890}')))
      .toBe('amount=961.1&authorizeAmount=50.0&big=12345678901234567890&terminalId=30001&version=1');
  });

  it('has the known answer for a signed sale under the Wi-Fi key', () => {
    const payload = 'amount=000000001234&messageType=SALE&version=1';
    expect(SecureHash.sign(payload, TestKeys.WIFI)).toBe('9425F9125C871197E5D0A6B88E4F9E6E29D1E0E49C96AA3D88A5E34D6FB9D45A');
    expect(SecureHash.sign(payload, TestKeys.WIFI_OTHER)).toBe('0DBE81E20B691AF85CE3A70E4047D6B10DC40514674E59876DF8200745AEA220');
  });

  it('has the known answer for a signed response envelope', () => {
    const envelope = new JsonObject({
      success: true,
      responseCode: '00',
      message: 'Approved',
      nonce: '82D83D6C05C1FBFA6AE72AE7C644D614',
      data: new JsonObject({ merchantReference: 'EA5C14BDB0A2' }),
      errorList: new JsonArray(),
    });
    const payload = SecureHash.compose(envelope);
    expect(payload).toBe('message=Approved&nonce=82D83D6C05C1FBFA6AE72AE7C644D614&responseCode=00&success=true');
    expect(SecureHash.sign(payload, TestKeys.WIFI)).toBe('0E060F03F6A461735CB6C9A82AF3D3AD1EAB983359C2B7ED3D58E0AE76C15A41');
  });

  it('passes the RFC 4231 cases', () => {
    expect(SecureHash.sign('Hi There', '0b'.repeat(20))).toBe('B0344C61D8DB38535CA8AFCEAF0BF12B881DC200C9833DA726E9376C2E32CFF7');
    expect(SecureHash.sign('what do ya want for nothing?', '4a656665')).toBe('5BDCC146BF60754E6A042426089575C75A003F089D2739839DEC58B964EC3843');
  });

  it('decodes the key from hex rather than using it as text', () => {
    const asHex = SecureHash.sign('a=1', TestKeys.WIFI);
    expect(asHex).toBe(hmac('a=1', Buffer.alloc(16, 0xaa)));
    expect(asHex).not.toBe(hmac('a=1', TestKeys.WIFI));
  });

  it('refuses a key that is not hex', () => {
    for (const key of ['not-hex!!', 'abc', '']) {
      expect(() => SecureHash.sign('a=1', key), key).toThrow(InvalidArgumentException);
    }
  });

  it('verifies', () => {
    const s = signed(new JsonObject({ amount: '000000001234' }), TestKeys.WIFI);
    const tampered = new JsonObject({ amount: '000000009999', secureHash: s.str('secureHash') });
    const lower = new JsonObject({ amount: '000000001234', secureHash: s.str('secureHash').toLowerCase() });
    const truncated = new JsonObject({ amount: '000000001234', secureHash: s.str('secureHash').slice(0, 62) });

    expect(SecureHash.verify(s, TestKeys.WIFI)).toBe(true);
    expect(SecureHash.verify(s, TestKeys.WIFI_OTHER)).toBe(false);
    expect(SecureHash.verify(tampered, TestKeys.WIFI)).toBe(false);
    expect(SecureHash.verify(lower, TestKeys.WIFI), 'hex case does not matter').toBe(true);
    expect(SecureHash.verify(truncated, TestKeys.WIFI)).toBe(false);
    expect(SecureHash.verify(new JsonObject({ amount: '1' }), TestKeys.WIFI), 'unsigned never verifies').toBe(false);
  });

  it('survives a wire round trip, but nested data is not covered', () => {
    const answer = signed(Wire.approval('82D83D6C05C1FBFA6AE72AE7C644D614'), TestKeys.WIFI);
    const reparsed = Wire.obj(answer.toJson());
    const altered = answer.clone();
    altered.obj('data')?.set('amount', '999.999');

    expect(SecureHash.verify(reparsed, TestKeys.WIFI)).toBe(true);
    // Documented limitation of the agreed format: `data` is not signed.
    expect(SecureHash.verify(altered, TestKeys.WIFI)).toBe(true);
  });

  it('verifies a signature over escaped unicode against the decoded text', () => {
    const signature = SecureHash.sign('message=café&nonce=N1', TestKeys.WIFI);
    const wire = '{"message":"caf\\u00e9","nonce":"N1","secureHash":"' + signature + '"}';
    expect(SecureHash.verify(Wire.obj(wire), TestKeys.WIFI)).toBe(true);
    expect(SecureHash.verify(Wire.obj('{"message":"café","nonce":"N1","secureHash":"' + signature + '"}'), TestKeys.WIFI)).toBe(true);
  });

  it('makes nonces of 128 bits of uppercase hex that do not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(SecureHash.newNonce());
    expect(seen.size).toBe(500);
    expect(SecureHash.newNonce()).toMatch(/^[0-9A-F]{32}$/);
  });

  it('sends a message unsigned without a key, and signed with a nonce with one', () => {
    const unsigned = build(new EcrConfig()).json;
    const s = build(new EcrConfig({ secureHashKey: TestKeys.WIFI }));

    expect(unsigned.has('secureHash')).toBe(false);
    expect(unsigned.has('nonce'), 'a nonce without a signature could just be changed').toBe(false);
    expect(s.json.str('nonce')).toHaveLength(32);
    expect(s.nonce()).toBe(s.json.str('nonce'));
    expect(SecureHash.verify(s.json, TestKeys.WIFI)).toBe(true);
  });

  it('signs a message reproducibly from the wire text alone', () => {
    const wire = build(new EcrConfig({ secureHashKey: TestKeys.WIFI })).json.toJson();
    const parsed = JSON.parse(wire) as Record<string, unknown>;
    const hash = parsed['secureHash'];
    delete parsed['secureHash'];
    const pairs = Object.keys(parsed).sort().map((k) => `${k}=${String(parsed[k])}`);
    expect(hash).toBe(hmac(pairs.join('&'), Buffer.alloc(16, 0xaa)));
  });

  it('signs two identical sales differently, and tampering breaks them', () => {
    const config = new EcrConfig({ secureHashKey: TestKeys.WIFI });
    const first = build(config).json;
    const second = build(config).json;
    const tampered = first.clone().set('amount', '000000999999');

    expect(first.str('secureHash')).not.toBe(second.str('secureHash'));
    expect(SecureHash.verify(tampered, TestKeys.WIFI)).toBe(false);
  });
});
