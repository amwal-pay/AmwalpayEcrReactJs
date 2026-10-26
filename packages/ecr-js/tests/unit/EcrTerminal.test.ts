import { describe, expect, it } from 'vitest';
import { EcrChannelTimeout, EcrIOException } from '../../src/channel/EcrChannel.js';
import type { EcrConfig, EcrConfigOptions } from '../../src/EcrConfig.js';
import { EcrReachability } from '../../src/EcrReachability.js';
import { EcrTerminal } from '../../src/EcrTerminal.js';
import { EcrTransactionType } from '../../src/EcrTransactionType.js';
import { InvalidArgumentException } from '../../src/exception/errors.js';
import { ConnectionLost, Malformed, Timeout, Unauthenticated, Unreachable } from '../../src/failure/Failure.js';
import { SecureHash } from '../../src/internal/SecureHash.js';
import { EcrLogger } from '../../src/log/EcrLogger.js';
import { NextStep } from '../../src/result/NextStep.js';
import { Approved, Declined, Failed, Found, InquiryFailed, NotFound, ReceiptFailed } from '../../src/result/results.js';
import { FakeChannel } from '../support/FakeChannel.js';
import { TestKeys, useTempState } from '../support/keys.js';
import { Wire } from '../support/wire.js';

/**
 * What the Wi-Fi terminal puts on the wire and what it will believe coming
 * back, against a scripted channel.
 */
const stateDir = useTempState();

const signed = (changes: EcrConfigOptions = {}): EcrConfig => TestKeys.lan(stateDir(), { autoInquireOnFailure: false, ...changes });
const unsigned = (changes: EcrConfigOptions = {}): EcrConfig => TestKeys.unsigned(stateDir(), changes);
const terminal = (channel: FakeChannel, config: EcrConfig | null = null, logger: EcrLogger | null = null): EcrTerminal =>
  new EcrTerminal(channel, 'TW1', config ?? unsigned(), { logger });
const recovering = (channel: FakeChannel, autoInquire = true): EcrTerminal =>
  terminal(channel, TestKeys.unsigned(stateDir(), { autoInquireOnFailure: autoInquire }));

function as<T>(value: unknown, type: abstract new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(type);
  return value as T;
}

function collect(): { lines: string[]; logger: EcrLogger } {
  const lines: string[] = [];
  return { lines, logger: EcrLogger.from((l) => lines.push(l)) };
}

const throwing = (error: Error) => (): never => {
  throw error;
};

describe('requests', () => {
  it('sends an unsigned sale message when no key is configured', async () => {
    const channel = FakeChannel.always('{"responseCode":"00","approved":true}');
    await terminal(channel).sale('1.234', 'ORD-1');

    expect(channel.requests).toHaveLength(1);
    const sent = Wire.obj(channel.requests[0]!);
    expect(sent.str('version')).toBe('1');
    expect(sent.str('messageType')).toBe('SALE');
    expect(sent.str('merchantReference')).toBe('ORD-1');
    expect(sent.str('terminalSerial')).toBe('TW1');
    expect(sent.str('currencyCode')).toBe('512');
    expect(sent.str('ecrId')).toBe('ECR01');
    expect(sent.str('amount')).toBe('000000001234');
    expect(sent.has('secureHash')).toBe(false);
    expect(sent.has('nonce')).toBe(false);
  });

  it('names the original of a void by padded receipt number and its terminal', async () => {
    const channel = FakeChannel.always('{"responseCode":"00","approved":true}');
    await terminal(channel).void('24', { originalTerminalId: '30001', merchantReference: 'VOID-1' });

    const sent = Wire.obj(channel.requests[0]!);
    expect(sent.str('messageType')).toBe('VOID');
    expect(sent.str('stan')).toBe('000024');
    expect(sent.str('originalTerminalId')).toBe('30001');
    expect(sent.str('merchantReference')).toBe('VOID-1');
    expect(sent.has('amount')).toBe(false);
  });

  it('carries the amount, the original and its date on a refund', async () => {
    const channel = FakeChannel.always('{"responseCode":"00","approved":true}');
    await terminal(channel).refund('0.5', '24', '20260806');

    const sent = Wire.obj(channel.requests[0]!);
    expect(sent.str('messageType')).toBe('REFUND');
    expect(sent.str('amount')).toBe('000000000500');
    expect(sent.str('stan')).toBe('000024');
    expect(sent.str('originalTransactionDate')).toBe('20260806');
  });

  it('names the original and its date on an inquiry and a receipt', async () => {
    const channel = FakeChannel.always('{"success":true,"data":null}');
    const t = terminal(channel);
    await t.inquire('24', '20260806');
    await t.receipt('24', '20260806');

    const inquiry = Wire.obj(channel.requests[0]!);
    const receipt = Wire.obj(channel.requests[1]!);
    expect(inquiry.str('messageType')).toBe('INQUIRY');
    expect(receipt.str('messageType')).toBe('RECEIPT');
    for (const sent of [inquiry, receipt]) {
      expect(sent.str('stan')).toBe('000024');
      expect(sent.str('originalTransactionDate')).toBe('20260806');
      expect(sent.has('amount')).toBe(false);
    }
  });

  it('hands the configured response timeout to the channel', async () => {
    const channel = FakeChannel.always('{"responseCode":"00","approved":true}');
    await terminal(channel, unsigned({ responseTimeout: 45 })).sale('1');
    expect(channel.timeouts).toEqual([45]);
  });

  it('writes a currency with two decimals in cents', async () => {
    const channel = FakeChannel.always('{"responseCode":"00","approved":true}');
    await terminal(channel, unsigned({ currencyCode: '840', minorUnitDigits: 2 })).sale('1.23');
    const sent = Wire.obj(channel.requests[0]!);
    expect(sent.str('amount')).toBe('000000000123');
    expect(sent.str('currencyCode')).toBe('840');
  });

  it('sends non-ASCII fields as raw UTF-8, still verifiable', async () => {
    const channel = FakeChannel.always(null);
    await new EcrTerminal(channel, 'Café ☕', signed({ ecrId: 'Tïll <&> "1"' })).sale('1', 'ORD-1');

    expect(channel.requests[0]).toContain('"terminalSerial":"Café ☕"');
    expect(channel.requests[0]).not.toContain('\\u');
    const parsed = Wire.obj(channel.requests[0]!);
    expect(parsed.str('ecrId')).toBe('Tïll <&> "1"');
    expect(SecureHash.verify(parsed, TestKeys.WIFI)).toBe(true);
  });
});

describe('refused before anything is sent', () => {
  it('refuses bad arguments before anything is sent', async () => {
    const channel = FakeChannel.always('{}');
    const t = terminal(channel);
    const calls: Array<() => Promise<unknown>> = [
      () => t.sale('1', 'has space'),
      () => t.sale('1', 'X'.repeat(33)),
      () => t.sale('abc'),
      () => t.void(''),
      () => t.void('  '),
      () => t.inquire(' ', '20260806'),
      () => t.inquireByReference(' '),
      () => t.receipt('', '20260806'),
      () => t.run(EcrTransactionType.Inquiry),
      () => t.run(EcrTransactionType.Receipt),
      () => t.run(EcrTransactionType.CloseReceipt),
      () => t.run(EcrTransactionType.Sale),
      () => t.run(EcrTransactionType.Refund, { amount: '1' }),
      () => new EcrTerminal(channel, 'TW\uD800', unsigned()).sale('1'),
    ];
    for (const [i, call] of calls.entries()) {
      await expect(call(), `call ${i}`).rejects.toThrow(InvalidArgumentException);
    }
    expect(channel.requests).toEqual([]);
    expect(await t.guard().unresolved(t.terminalKey()), 'nothing pending after refusals').toEqual([]);
  });

  it('sends what the Windows SDK sends as given', async () => {
    const calls: Array<(t: EcrTerminal) => Promise<unknown>> = [
      (t) => t.sale('0'),
      (t) => t.sale('-1.000'),
      (t) => t.void('12a'),
      (t) => t.refund('1', '24', ''),
      (t) => t.refund('1', '24', '2026-08-06'),
    ];
    for (const [i, call] of calls.entries()) {
      const channel = FakeChannel.always('{"success":true,"responseCode":"00"}');
      await call(terminal(channel, TestKeys.unsigned(`${stateDir()}/${i}`)));
      expect(channel.requests, `call ${i} was not sent`).toHaveLength(1);
    }
  });
});

describe('failures the channel can report', () => {
  it('reads a timeout as a timeout, not a decline', async () => {
    const channel = new FakeChannel(throwing(new EcrChannelTimeout('no answer')));
    const failed = as(await terminal(channel, unsigned({ responseTimeout: 90 })).sale('1'), Failed);
    expect(failed.failure).toBeInstanceOf(Timeout);
    expect(failed.failure.message).toContain('1m 30s');
    expect(failed.failure.message).toContain('inquire before retrying');
    expect(failed.failure.outcomeUnknown()).toBe(true);
    expect(failed.nextStep()).toBe(NextStep.InquireByMerchantReference);
  });

  it.each<[number, string]>([[0, '0s'], [30, '30s'], [59, '59s'], [60, '1m'], [90, '1m 30s'], [120, '2m'], [160, '2m 40s']])(
    'formats %is for operators as %s',
    (seconds, expected) => {
      expect(EcrTerminal.formatDuration(seconds)).toBe(expected);
    },
  );

  it.each([
    ['html', '<html>gateway error</html>'],
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"approved"'],
    ['success twice', '{"success":false,"success":true,"responseCode":"00"}'],
    ['data twice', '{"success":true,"data":{"amount":"1"},"data":null}'],
    ['amount twice', '{"success":true,"data":{"amount":"1","amount":"999"}}'],
  ])('reads an unreadable answer (%s) as malformed and unknown, never a decline', async (_name, body) => {
    const failed = as(await terminal(FakeChannel.always(body)).sale('1'), Failed);
    expect(failed.failure).toBeInstanceOf(Malformed);
    expect(failed.failure.outcomeUnknown()).toBe(true);
  });

  it('reads an empty message as malformed and a closed connection as lost', async () => {
    const empty = as(await terminal(new FakeChannel(throwing(new EcrIOException('Terminal returned an empty message')))).sale('1'), Failed);
    const lost = as(await terminal(FakeChannel.always(null), TestKeys.unsigned(stateDir() + '/lost')).sale('1'), Failed);
    expect(empty.failure).toBeInstanceOf(Malformed);
    expect(lost.failure).toBeInstanceOf(ConnectionLost);
  });

  it('reads a connect failure as unreachable, not an unknown outcome', async () => {
    const channel = new FakeChannel(throwing(new EcrIOException('Connection timed out after 3000 ms')));
    const failed = as(await terminal(channel, TestKeys.unsigned(stateDir(), { autoInquireOnFailure: true })).sale('1.234', 'ORD-1'), Failed);
    expect(failed.failure).toBeInstanceOf(Unreachable);
    expect(failed.failure.message).toContain('Connection timed out after 3000 ms');
    expect(failed.failure.message).toContain('(fake:9100)');
    expect(failed.failure.outcomeUnknown()).toBe(false);
    expect(failed.recovered, 'nothing was sent, so nothing is asked').toBeNull();
    expect(channel.requests).toHaveLength(1);
  });

  it('reports the same failures for inquiries and receipts', async () => {
    const t = terminal(FakeChannel.always(null));
    const inquiry = as(await t.inquire('24', '20260806'), InquiryFailed);
    expect(inquiry.failure).toBeInstanceOf(ConnectionLost);
    expect(await t.inquireByReference('ORD-1')).toBeInstanceOf(InquiryFailed);
    expect(await t.receipt('24', '20260806')).toBeInstanceOf(ReceiptFailed);
  });

  it('reads an answer whatever version it declares', async () => {
    const approved = await terminal(FakeChannel.always('{"version":2,"success":true,"responseCode":"00","message":"Approved"}')).sale('1');
    expect(approved).toBeInstanceOf(Approved);
  });
});

describe('reachability', () => {
  it('reports why not, and where', async () => {
    const channel = FakeChannel.always(null);
    channel.probeError = 'Connection refused';
    const t = terminal(channel);
    const reachability = await t.probeReachability();

    expect(reachability.reachable).toBe(false);
    expect(reachability.error).toBe('Connection refused');
    expect(reachability.host).toBe('fake');
    expect(reachability.port).toBe(9100);
    expect(reachability.endpoint).toBe('fake:9100');
    expect(await t.isReachable()).toBe(false);
    channel.probeError = null;
    expect(await t.isReachable()).toBe(true);
    expect(new EcrReachability(true, 'USB cable', 0).endpoint).toBe('USB cable');
  });
});

describe('trust', () => {
  it('believes a signed answer to this request', async () => {
    const channel = new FakeChannel((r) => Wire.signed(Wire.approval(Wire.nonceOf(r)), TestKeys.WIFI));
    const approved = as(await terminal(channel, signed()).sale('1.234', 'ORD-1'), Approved);
    expect(approved.amount).toBe('1.234');
    expect(approved.rrn).toBe('622908275947');
    const sent = Wire.obj(channel.requests[0]!);
    expect(sent.str('nonce')).toHaveLength(32);
    expect(SecureHash.verify(sent, TestKeys.WIFI)).toBe(true);
  });

  it.each<[string, (r: string) => string, string]>([
    ['unsigned', (r) => Wire.approval(Wire.nonceOf(r)).toJson(), "not signed with this terminal's key"],
    ['another key', (r) => Wire.signed(Wire.approval(Wire.nonceOf(r)), TestKeys.WIFI_OTHER), 'not signed'],
    ['altered after signing', (r) => Wire.signed(Wire.approval(Wire.nonceOf(r)), TestKeys.WIFI).replace('"success":true', '"success":false'), 'not signed'],
    ['replayed from an earlier request', () => Wire.signed(Wire.approval('00000000000000000000000000000001'), TestKeys.WIFI), 'belongs to a different request'],
    ['no nonce', () => Wire.signed(Wire.approval('').remove('nonce'), TestKeys.WIFI), 'belongs to a different request'],
  ])('rejects an answer that cannot be shown to come from the terminal as unknown: %s', async (_name, answer, why) => {
    const failed = as(await terminal(new FakeChannel(answer), signed()).sale('1.234', 'ORD-1'), Failed);
    expect(failed.failure).toBeInstanceOf(Unauthenticated);
    expect(failed.failure.message).toContain(why);
    expect(failed.failure.outcomeUnknown(), 'the terminal may well have taken the payment').toBe(true);
  });

  it('accepts an unsigned answer on an unsigned till and ignores any nonce', async () => {
    expect(await terminal(FakeChannel.always(Wire.approval('SOMETHING-ELSE').toJson())).sale('1.234', 'ORD-1')).toBeInstanceOf(Approved);
  });

  it('authenticates inquiries and receipts too', async () => {
    const t = terminal(FakeChannel.always(Wire.foundEnvelope('x').toJson()), signed());
    const inquiry = as(await t.inquire('24', '20260806'), InquiryFailed);
    const receipt = as(await t.receipt('24', '20260806'), ReceiptFailed);
    expect(inquiry.failure).toBeInstanceOf(Unauthenticated);
    expect(receipt.failure).toBeInstanceOf(Unauthenticated);
    const believed = terminal(new FakeChannel((r) => Wire.signed(Wire.foundEnvelope(Wire.nonceOf(r)), TestKeys.WIFI)), signed());
    expect(await believed.inquire('24', '20260806')).toBeInstanceOf(Found);
  });
});

describe('recovery: the automatic inquiry after a lost answer', () => {
  it('follows a sale whose answer never arrives with one inquiry by its reference', async () => {
    const channel = new FakeChannel((_r, n) => (n === 0 ? null : Wire.FOUND));
    const failed = as(await recovering(channel).sale('1.234', 'ORD-88231'), Failed);

    expect(failed.failure).toBeInstanceOf(ConnectionLost);
    expect(failed.settled(), 'but the outcome is no longer unknown').toBe(true);
    expect(as(failed.recovered, Found).transaction.status).toBe('Approved');
    expect(channel.requests).toHaveLength(2);
    expect(channel.requests[0]).toContain('"messageType":"SALE"');
    expect(channel.requests[1]).toContain('"messageType":"INQUIRY"');
    expect(channel.requests[1]).toContain('"originalMerchantReference":"ORD-88231"');
    expect(channel.requests[1], 'the follow-up is an inquiry, never a second sale').not.toContain('"amount"');
  });

  it('follows up a timeout and an unauthenticated answer too', async () => {
    const timeout = new FakeChannel((_r, n) => {
      if (n === 0) throw new EcrChannelTimeout('no answer');
      return Wire.FOUND;
    });
    const failed = as(await recovering(timeout).sale('1.234', 'ORD-1'), Failed);
    expect(failed.failure).toBeInstanceOf(Timeout);
    expect(failed.settled()).toBe(true);

    const unauthenticated = new FakeChannel((r, n) => (n === 0
      ? Wire.approval(Wire.nonceOf(r)).toJson()
      : Wire.signed(Wire.foundEnvelope(Wire.nonceOf(r)), TestKeys.WIFI)));
    const rejected = as(await new EcrTerminal(unauthenticated, 'TW1', TestKeys.lan(stateDir())).sale('1.234', 'ORD-2'), Failed);
    expect(rejected.failure).toBeInstanceOf(Unauthenticated);
    expect(rejected.settled()).toBe(true);
  });

  it('gives a void and a refund the same follow-up', async () => {
    const voidChannel = new FakeChannel((_r, n) => (n === 0 ? null : Wire.FOUND));
    const refundChannel = new FakeChannel((_r, n) => (n === 0 ? null : Wire.FOUND));
    const voided = as(await recovering(voidChannel).void('24', { merchantReference: 'VOID-1' }), Failed);
    const refunded = as(await new EcrTerminal(refundChannel, 'TW2', TestKeys.unsigned(stateDir(), { autoInquireOnFailure: true }))
      .refund('0.5', '24', '20260806', { merchantReference: 'REF-1' }), Failed);
    expect(voided.settled()).toBe(true);
    expect(refunded.settled()).toBe(true);
    expect(voidChannel.requests[1]).toContain('"originalMerchantReference":"VOID-1"');
    expect(refundChannel.requests[1]).toContain('"originalMerchantReference":"REF-1"');
  });

  it('leaves the outcome unknown when there is no record or the follow-up fails', async () => {
    const notFound = as(await recovering(new FakeChannel((_r, n) => (n === 0 ? null : '{"responseCode":"25","responseMessage":"Not found","approved":false}'))).sale('1.234', 'ORD-1'), Failed);
    expect(notFound.recovered).toBeInstanceOf(NotFound);
    expect(notFound.settled(), 'still unknown, and still not a decline').toBe(false);

    const gone = FakeChannel.always(null);
    const stillUnknown = as(await new EcrTerminal(gone, 'TW1', TestKeys.unsigned(stateDir() + '/b', { autoInquireOnFailure: true })).sale('1.234', 'ORD-2'), Failed);
    expect(stillUnknown.recovered).toBeInstanceOf(InquiryFailed);
    expect(stillUnknown.settled()).toBe(false);
    expect(gone.requests).toHaveLength(2);

    const boom = new FakeChannel((_r, n) => {
      if (n === 0) return null;
      throw new Error('boom');
    });
    const escaped = as(await new EcrTerminal(boom, 'TW1', TestKeys.unsigned(stateDir() + '/c', { autoInquireOnFailure: true })).sale('1.234', 'ORD-3'), Failed);
    expect(escaped.recovered, 'an unexpected error in the follow-up does not escape').toBeNull();
  });

  it('can be turned off, and never follows up an approval or a decline', async () => {
    const off = new FakeChannel((_r, n) => (n === 0 ? null : Wire.FOUND));
    const failed = as(await recovering(off, false).sale('1.234', 'ORD-1'), Failed);
    expect(failed.recovered).toBeNull();
    expect(off.requests).toHaveLength(1);
    expect(failed.nextStep(), 'always inquire, never retry').toBe(NextStep.InquireByMerchantReference);

    const approved = FakeChannel.always('{"responseCode":"00","responseMessage":"Approved","approved":true,"amount":"000000001234"}');
    expect(await new EcrTerminal(approved, 'A', TestKeys.unsigned(stateDir() + '/a', { autoInquireOnFailure: true })).sale('1.234')).toBeInstanceOf(Approved);
    expect(approved.requests).toHaveLength(1);

    const declined = FakeChannel.always('{"responseCode":"51","responseMessage":"DECLINED","approved":false}');
    expect(await new EcrTerminal(declined, 'D', TestKeys.unsigned(stateDir() + '/d', { autoInquireOnFailure: true })).sale('1.234')).toBeInstanceOf(Declined);
    expect(declined.requests).toHaveLength(1);
  });
});

describe('diagnostics', () => {
  it('never lets the secret reach the log', async () => {
    const { lines, logger } = collect();
    const channel = new FakeChannel((r) => Wire.signed(Wire.approval(Wire.nonceOf(r)), TestKeys.WIFI));
    await terminal(channel, signed(), logger).sale('1.234', 'ORD-1');

    const log = lines.join('\n');
    expect(log).not.toBe('');
    expect(log.toLowerCase()).not.toContain(TestKeys.WIFI.toLowerCase());
    expect(log).toContain('Sending SALE ORD-1 to fake:9100');
    expect(log).toContain('response signature valid');
    expect(log).toContain('signing key (Wi-Fi/CABLE secure hash key): configured');
  });

  it('logs a rejected answer as rejected', async () => {
    const { lines, logger } = collect();
    await terminal(FakeChannel.always(Wire.approval('x').toJson()), signed(), logger).sale('1', 'ORD-1');
    expect(lines.some((l) => l.startsWith('Rejected the answer:'))).toBe(true);
  });

  it('masks an unmasked card number in an answer in the log', async () => {
    const { lines, logger } = collect();
    const answer = '{"success":true,"responseCode":"00","data":{"cardNumber":"4111111111111111","pin":"1234","cvv":"123"}}';
    await terminal(FakeChannel.always(answer), null, logger).sale('1', 'ORD-1');

    const log = lines.join('\n');
    expect(log).not.toContain('4111111111111111');
    expect(log).toContain('411111******1111');
    expect(log).not.toContain('"pin":"1234"');
    expect(log).not.toContain('"cvv":"123"');
  });
});
