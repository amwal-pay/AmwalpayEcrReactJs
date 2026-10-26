import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EcrConfig, type EcrConfigOptions } from '../../src/EcrConfig.js';
import type { EcrOpenedSession } from '../../src/EcrOpenedSession.js';
import { EcrSessions } from '../../src/EcrSessions.js';
import { ConnectionLost, Malformed, Timeout, Unauthenticated, Unresolved } from '../../src/failure/Failure.js';
import { LanLink } from '../../src/link/EcrLink.js';
import {
  Approved,
  CloseReceiptRefused,
  Declined,
  Failed,
  Found,
  InquiryFailed,
  NotFound,
  ReceiptClosed,
  ReceiptReady,
} from '../../src/result/results.js';
import { JournalEntry } from '../../src/safety/JournalEntry.js';
import { BackgroundProcess } from '../support/BackgroundProcess.js';
import { useTempState } from '../support/keys.js';

/**
 * The whole Wi-Fi path, from EcrSessions.open to a socket, against the signed
 * fake terminal in tools/: a separate program that verifies the till's
 * signature, refuses replayed nonces and signs its answers with its own code.
 */
const FAKE_POS = join(dirname(fileURLToPath(import.meta.url)), '../../../../tools/fake-pos-server.mjs');
// A placeholder, as in the Windows example's fake terminal instructions.
const KEY = '0123456789ABCDEF0123456789ABCDEF';
const stateDir = useTempState();

let terminal: BackgroundProcess | null = null;
afterEach(async () => {
  await terminal?.stop();
  terminal = null;
});

async function session(flags: string[] = [], config: EcrConfigOptions = {}): Promise<EcrOpenedSession> {
  terminal = await BackgroundProcess.start(FAKE_POS, ['--key', KEY, '--port', '0', ...flags]);
  const plan = EcrSessions.plan(
    new LanLink('127.0.0.1', terminal.port),
    new EcrConfig({ secureHashKey: KEY, stateDirectory: stateDir(), responseTimeout: 5, guardFinancialOperations: true, ...config }),
  );
  expect(plan.isReady(), plan.issues().join('\n')).toBe(true);
  return EcrSessions.open('SN-WIFI-0001', plan);
}

function as<T>(value: unknown, type: abstract new (...args: never[]) => T): T {
  expect(value, terminal?.output).toBeInstanceOf(type);
  return value as T;
}

describe.skipIf(!existsSync(FAKE_POS))('the signed fake terminal', () => {
  it('approves a sale, then answers inquiry, receipt, void, refund and close receipt', async () => {
    const s = await session();

    expect((await s.probeReachability())?.reachable).toBe(true);
    const sale = as(await s.sale('1.234', 'ORDER-1001-1'), Approved);
    expect(sale.amount).toBe('1.234');
    expect(sale.maskedPan).toBe('483312******1234');
    expect(sale.merchantReference).toBe('ORDER-1001-1');

    const found = as(await s.inquireByReference('ORDER-1001-1'), Found);
    const stan = found.transaction.stan;
    expect(stan).toBe('000024');
    expect(found.transaction.canVoid).toBe(true);

    expect(await s.inquire(stan, found.transaction.day())).toBeInstanceOf(Found);
    const receipt = as(await s.receipt(stan, found.transaction.day()), ReceiptReady);
    expect(receipt.url).toContain('stan=000024');

    expect(await s.closeReceipt()).toBeInstanceOf(ReceiptClosed);
    expect(await s.void(stan, { merchantReference: 'ORDER-1001-V1' })).toBeInstanceOf(Approved);
    expect(await s.refund('0.500', stan, found.transaction.day(), { merchantReference: 'ORDER-1001-R1' })).toBeInstanceOf(Approved);
    expect(await s.pendingOutcomes()).toEqual([]);
  });

  it('reads a decline as a decline, and spends the reference', async () => {
    const s = await session(['--decline', '51']);
    const declined = as(await s.sale('1.000', 'ORD-D1'), Declined);
    expect(declined.responseCode).toBe('51');
    expect(declined.reason).toBe('Declined by the issuer (51)');
    expect((await s.guard().entry(s.terminalKey(), 'ORD-D1'))?.state).toBe(JournalEntry.DECLINED);
  });

  it('reports what a partial approval took and what was asked', async () => {
    const approved = as(await (await session(['--partial'])).sale('961.100', 'ORD-P1'), Approved);
    expect(approved.partialApproval).toBe(true);
    expect(approved.amount).toBe('480.550');
    expect(approved.requestedAmount).toBe('961.100');
  });

  it('reads a busy terminal as a refusal, with nothing moved', async () => {
    const result = as(await (await session(['--busy'])).sale('1.000', 'ORD-B1'), Declined);
    expect(result.responseCode).toBe('BUSY');
    expect(result.reason).toBe('Terminal busy');
  });

  it('recovers a lost answer by the automatic inquiry', async () => {
    const s = await session(['--drop-sale']);
    const failed = as(await s.sale('2.500', 'ORD-L1'), Failed);
    expect(failed.failure).toBeInstanceOf(ConnectionLost);
    expect(failed.settled()).toBe(true);
    expect(as(failed.recovered, Found).transaction.amount).toBe('2.500');
    expect(await s.pendingOutcomes(), 'settled').toEqual([]);
  });

  it('blocks the terminal until reconciled when it cannot explain a lost answer', async () => {
    const s = await session(['--drop-sale', '--drop-first-inquiry']);
    const failed = as(await s.sale('2.500', 'ORD-L2'), Failed);
    expect(failed.failure.outcomeUnknown()).toBe(true);
    expect(failed.recovered).toBeInstanceOf(InquiryFailed);
    expect(failed.settled()).toBe(false);

    const blocked = as(await s.sale('1.000', 'ORD-L3'), Failed);
    expect(blocked.failure).toBeInstanceOf(Unresolved);

    const reconciled = await s.reconcile();
    expect(reconciled.get('ORD-L2')).toBeInstanceOf(Found);
    expect(await s.pendingOutcomes()).toEqual([]);
  });

  it('reads a terminal that never answers as a timeout, then recovers it', async () => {
    const s = await session(['--stall-sale', '--stall-seconds', '2'], { responseTimeout: 1.5 });
    const failed = as(await s.sale('1.234', 'ORD-T1'), Failed);
    expect(failed.failure).toBeInstanceOf(Timeout);
    expect(failed.failure.message).toContain('did not answer within 2s');
    expect(failed.settled(), 'the follow-up found it once the terminal was free').toBe(true);
  });

  it('reads a reset after the sale as a lost connection', async () => {
    const failed = as(await (await session(['--reset-sale'])).sale('1.234', 'ORD-R1'), Failed);
    expect(failed.failure).toBeInstanceOf(ConnectionLost);
    expect(failed.settled()).toBe(true);
  });

  it('reads an unreadable answer as malformed, and inquires about it', async () => {
    const failed = as(await (await session(['--garbage-sale'])).sale('1.234', 'ORD-G1'), Failed);
    expect(failed.failure).toBeInstanceOf(Malformed);
    expect(failed.settled()).toBe(true);
  });

  it('does not believe an answer signed with another key', async () => {
    const failed = as(await (await session(['--wrong-key-sale'])).sale('1.234', 'ORD-K1'), Failed);
    expect(failed.failure).toBeInstanceOf(Unauthenticated);
    expect(failed.settled(), 'the properly signed follow-up found it').toBe(true);
  });

  it('is refused by the terminal when the till has the wrong key', async () => {
    terminal = await BackgroundProcess.start(FAKE_POS, ['--key', KEY, '--port', '0']);
    const plan = EcrSessions.plan(new LanLink('127.0.0.1', terminal.port), new EcrConfig({ secureHashKey: 'd'.repeat(32), stateDirectory: stateDir() }));
    const result = await EcrSessions.open('P1', plan).sale('1.000', 'ORD-W1');
    // The terminal answers, signed with its key, which this till cannot verify.
    expect(as(result, Failed).failure).toBeInstanceOf(Unauthenticated);
  });

  it('reads an answer in a newer format as the Windows SDK reads it', async () => {
    const result = await (await session(['--answer-version', '2'], { autoInquireOnFailure: false })).sale('1.234', 'ORD-V1');
    expect(result).not.toBeInstanceOf(Failed);
  });

  it('is refused close receipt by old firmware, and reads not-found as not found', async () => {
    const s = await session(['--no-close-receipt', '--not-found']);
    expect(await s.closeReceipt()).toBeInstanceOf(CloseReceiptRefused);
    expect(await s.inquireByReference('NEVER-SENT')).toBeInstanceOf(NotFound);
  });
});
