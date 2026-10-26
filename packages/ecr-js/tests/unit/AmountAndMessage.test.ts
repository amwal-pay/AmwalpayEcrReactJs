import { describe, expect, it } from 'vitest';
import { Amount } from '../../src/Amount.js';
import { EcrConfig } from '../../src/EcrConfig.js';
import { EcrSdk } from '../../src/EcrSdk.js';
import { EcrTransactionType } from '../../src/EcrTransactionType.js';
import { OverflowException } from '../../src/exception/errors.js';
import { InvalidRequestException } from '../../src/exception/InvalidRequestException.js';
import { EcrMessage, formatTimestamp } from '../../src/internal/EcrMessage.js';
import { MerchantReference } from '../../src/internal/MerchantReference.js';
import { Validate } from '../../src/internal/Validate.js';

/** Amounts, references, receipt numbers and dates: what goes on the wire, and what is refused before it. */
function build(
  type: EcrTransactionType,
  o: { amount?: string; stan?: string; originalTerminalId?: string; originalDate?: string; originalReference?: string; merchantReference?: string } = {},
): EcrMessage {
  return EcrMessage.build(type, new EcrConfig(), 'TW1', { ...o, amount: o.amount === undefined ? null : Amount.of(o.amount) });
}

describe('Amount', () => {
  it.each<[string, number, string]>([
    ['1.234', 3, '000000001234'],
    ['0.001', 3, '000000000001'],
    ['961.100', 3, '000000961100'],
    ['961.1', 3, '000000961100'],
    ['1.23', 2, '000000000123'],
    ['1.2345', 3, '000000001235'], // half away from zero
    ['1.2344', 3, '000000001234'],
    ['1.005', 2, '000000000101'], // exact decimal: a float would give 100
    ['1234.5', 0, '000000001235'],
    ['0.0005', 3, '000000000001'],
    ['9.9995', 3, '000000010000'],
    ['  5  ', 3, '000000005000'],
    ['.5', 3, '000000000500'],
    ['999999999.999', 3, '999999999999'],
  ])('sends %j with %i digits as %s', (amount, digits, wire) => {
    expect(Amount.of(amount).toWire(digits)).toBe(wire);
  });

  it('reads whole numbers as major units', () => {
    expect(Amount.of(5).toMinorUnits(3)).toBe(5000n);
    expect(Amount.of(5n).toMinorUnits(3)).toBe(5000n);
    expect(Amount.fromMinorUnits(1234, 3).decimal).toBe('1.234');
    expect(Amount.of('1.23').format(3)).toBe('1.230');
  });

  it.each<[string, string | number | bigint, number, string]>([
    ['zero', '0', 3, '000000000000'],
    ['zero int', 0, 3, '000000000000'],
    ['negative', '-1.000', 3, '0000000-1000'],
    ['negative int', -5, 3, '0000000-5000'],
    ['negative bigint', -5n, 3, '0000000-5000'],
    ['rounds to nothing', '0.0004', 3, '000000000000'],
    ['exponent', '1e3', 3, '000001000000'],
    ['more than 12 digits', '1000000000.000', 3, '1000000000000'],
    ['fractional number', 1.234, 3, '000000001234'],
    ['fractional number half away from zero', 1.005, 2, '000000000101'],
  ])('sends what the Windows SDK sends, without judging it: %s', (_name, amount, digits, wire) => {
    expect(Amount.of(amount).toWire(digits)).toBe(wire);
  });

  it.each<[string, string | number]>([
    ['thousands separator', '1,000.000'],
    ['comma decimal', '1,5'],
    ['currency sign', 'OMR 1.000'],
    ['empty', ''],
    ['NaN', 'NaN'],
    ['NaN number', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses text that is not a number: %s', (_name, amount) => {
    expect(() => Amount.of(amount)).toThrow(InvalidRequestException);
  });

  it("reads the Web Service amount as a 64-bit integer, as the Windows SDK's checked cast", () => {
    expect(Amount.of('-1').toMinorUnits(3)).toBe(-1000n);
    expect(() => Amount.of('99999999999999999999').toMinorUnits(3)).toThrow(OverflowException);
  });

  it.each<[string, number, string]>([
    ['000000000365', 3, '0.365'],
    ['000000961100', 3, '961.100'],
    ['000000000123', 2, '1.23'],
    ['000000000123', 0, '123'],
    ['000000000000', 3, '0.000'],
    ['', 3, ''],
    ['1.234', 3, '1.234'], // already major units: not shifted again
    ['5', 3, '0.005'],
    ['-500', 2, '-5.00'],
    ['-5', 3, '-0.005'],
    ['99999999999999999999', 3, '99999999999999999.999'],
  ])('reads minor units %j as major units keeping every digit', (minor, digits, major) => {
    expect(Amount.majorUnits(minor, digits)).toBe(major);
  });
});

describe('EcrMessage', () => {
  it('carries an amount and no original on a sale', () => {
    const json = build(EcrTransactionType.Sale, { amount: '1.234' }).json;
    expect(json.str('messageType')).toBe('SALE');
    expect(json.str('amount')).toBe('000000001234');
    expect(json.str('version')).toBe('1');
    expect(json.str('transactionDateTime')).toMatch(/^[0-9]{14}$/);
    for (const absent of ['stan', 'originalTerminalId', 'originalTransactionDate', 'originalMerchantReference', 'nonce', 'secureHash']) {
      expect(json.has(absent), `${absent} must be left out, not sent empty`).toBe(false);
    }
  });

  it('carries the original but no amount on a void', () => {
    const json = build(EcrTransactionType.Void, { stan: '000024', originalTerminalId: '30001' }).json;
    expect(json.str('messageType')).toBe('VOID');
    expect(json.str('stan')).toBe('000024');
    expect(json.str('originalTerminalId')).toBe('30001');
    expect(json.has('amount'), 'a void takes the original amount').toBe(false);
  });

  it('carries amount, original and date on a refund', () => {
    const json = build(EcrTransactionType.Refund, { amount: '0.500', stan: '000024', originalDate: '20260806' }).json;
    expect(json.str('amount')).toBe('000000000500');
    expect(json.str('stan')).toBe('000024');
    expect(json.str('originalTransactionDate')).toBe('20260806');
  });

  it('lets only a read-only operation name its original by reference', () => {
    const inquiry = build(EcrTransactionType.Inquiry, { originalReference: 'ORD-88231', merchantReference: 'LOOKUP-1' });
    const voided = build(EcrTransactionType.Void, { stan: '000024', originalReference: 'ORD-88231' });
    expect(inquiry.json.str('originalMerchantReference')).toBe('ORD-88231');
    expect(inquiry.merchantReference).toBe('LOOKUP-1');
    expect(voided.json.has('originalMerchantReference')).toBe(false);
  });

  it('carries the config identity, currency and time zone', () => {
    const message = EcrMessage.build(
      EcrTransactionType.Sale,
      new EcrConfig({ ecrId: 'TILL-7', currencyCode: '840', minorUnitDigits: 2, timezone: 'Asia/Muscat' }),
      'TW9',
      { amount: Amount.of('1.23') },
    );
    expect(message.json.str('ecrId')).toBe('TILL-7');
    expect(message.json.str('currencyCode')).toBe('840');
    expect(message.json.str('terminalSerial')).toBe('TW9');
    expect(message.json.str('amount')).toBe('000000000123');
    const muscat = formatTimestamp(new Date(), 'Asia/Muscat');
    expect(message.json.str('transactionDateTime').startsWith(muscat.slice(0, 8))).toBe(true);
  });

  it("stamps the machine's local time unless a zone is set", () => {
    const message = EcrMessage.build(EcrTransactionType.Sale, new EcrConfig(), 'TW9', { amount: Amount.of('1.23') });
    const local = formatTimestamp(new Date(), EcrSdk.localTimeZone());
    expect(EcrSdk.localTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(message.json.str('transactionDateTime').slice(0, 10)).toBe(local.slice(0, 10));
  });

  it('formats a timestamp in the given zone', () => {
    expect(formatTimestamp(new Date(Date.UTC(2026, 9, 25, 20, 30, 5)), 'Asia/Muscat')).toBe('20261026003005');
    expect(formatTimestamp(new Date(Date.UTC(2026, 9, 25, 0, 0, 0)), 'UTC')).toBe('20261025000000');
  });
});

describe('MerchantReference and Validate', () => {
  it("uses the caller's own reference, trimmed, or a fresh one", () => {
    expect(MerchantReference.resolve('ORDER-2026-0817-001')).toBe('ORDER-2026-0817-001');
    expect(MerchantReference.resolve('  ORDER-1  ')).toBe('ORDER-1');
    // string.Trim(): Unicode white space goes, NUL stays and is refused.
    expect(MerchantReference.resolve('\u00A0ORDER-1\f')).toBe('ORDER-1');
    expect(MerchantReference.resolve('   ')).toMatch(/^[0-9A-F]{12}$/);
    expect(MerchantReference.resolve('')).not.toBe(MerchantReference.resolve(''));
    expect(MerchantReference.resolve('X'.repeat(32))).toBe('X'.repeat(32));
  });

  it.each([
    ['too long', 'X'.repeat(33)],
    ['ampersand', 'ORDER&1'],
    ['equals', 'ORDER=1'],
    ['space', 'ORDER 1'],
    ['newline', 'ORDER\n1'],
    ['non-ascii', 'ORDERé1'],
    ['control', 'ORDER\x011'],
    ['trailing NUL', 'ORDER-1\0'],
  ])('refuses a reference the wire cannot carry: %s', (_name, reference) => {
    expect(() => MerchantReference.resolve(reference)).toThrow(InvalidRequestException);
  });

  it.each([
    ['short', '24', '000024'],
    ['padded', ' 000024 ', '000024'],
    ['six digits', '123456', '123456'],
    ['stray characters are dropped', 'A-24', '000024'],
    ['longer than six', '1234567', '1234567'],
    ['no digits', 'abc', ''],
    ['only zeros', '0000', ''],
    ['arabic-indic digits', '\u0662\u0664', '0000\u0662\u0664'],
  ])('pads receipt numbers like the Windows SDK: %s', (_name, stan, padded) => {
    expect(Validate.paddedStan(stan)).toBe(padded);
  });

  it('sends optional fields as given when not blank', () => {
    const json = build(EcrTransactionType.Refund, { amount: '1', stan: 'abc', originalTerminalId: ' T1 ', originalDate: '2026-08-06' }).json;

    // A receipt number with no digits still goes, empty, as in the Windows SDK.
    expect(json.str('stan')).toBe('');
    expect(json.str('originalTerminalId')).toBe(' T1 ');
    expect(json.str('originalTransactionDate')).toBe('2026-08-06');
    expect(build(EcrTransactionType.Refund, { amount: '1', stan: '24', originalDate: ' \u00A0' }).json.has('originalTransactionDate')).toBe(false);
  });

  it('has the transaction type flags of the Windows SDK', () => {
    const t = EcrTransactionType;
    expect(t.menuOptions()).toEqual([t.Sale, t.Void, t.Refund, t.Inquiry]);
    expect(t.CloseReceipt.messageType()).toBe('CLOSE_RECEIPT');
    expect(t.Refund.requiresAmount()).toBe(true);
    expect(t.Void.requiresAmount()).toBe(false);
    expect(t.Receipt.requiresOriginalStan()).toBe(true);
    expect(t.Void.requiresOriginalDate()).toBe(false);
    expect(t.Inquiry.movesMoney()).toBe(false);
    expect(t.CloseReceipt.allowsOtherTerminal()).toBe(false);
  });
});
