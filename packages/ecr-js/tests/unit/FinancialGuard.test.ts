import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EcrIOException } from '../../src/channel/EcrChannel.js';
import { EcrConfig } from '../../src/EcrConfig.js';
import { EcrTerminal } from '../../src/EcrTerminal.js';
import { EcrWebServiceTerminal } from '../../src/EcrWebServiceTerminal.js';
import { DuplicateMerchantReferenceException } from '../../src/exception/DuplicateMerchantReferenceException.js';
import { InvalidArgumentException, RuntimeException } from '../../src/exception/errors.js';
import { Busy, Unresolved } from '../../src/failure/Failure.js';
import { Approved, Declined, type EcrResult, Failed, Found, NotFound } from '../../src/result/results.js';
import { FileTerminalLock } from '../../src/safety/FileTerminalLock.js';
import { FileTransactionJournal } from '../../src/safety/FileTransactionJournal.js';
import { FinancialGuard } from '../../src/safety/FinancialGuard.js';
import { JournalEntry, utcNow } from '../../src/safety/JournalEntry.js';
import { HttpResponse, HttpTransportException } from '../../src/webservice/http/HttpTransport.js';
import { FakeChannel } from '../support/FakeChannel.js';
import { FakeHttpTransport } from '../support/FakeHttpTransport.js';
import { TestKeys, useTempState } from '../support/keys.js';
import { Wire } from '../support/wire.js';

/**
 * The payment-safety rules the SDK enforces across requests and processes:
 * one financial transaction per terminal, a reference used once, and no new
 * money movement while an outcome is unknown.
 */
const APPROVED = '{"success":true,"responseCode":"00","message":"Approved","data":{"amount":"1.000"}}';
const DECLINED = '{"success":false,"responseCode":"51","message":"Declined"}';
const NOT_FOUND = '{"success":false,"responseCode":"25","message":"Transaction not found","data":null}';

const stateDir = useTempState();

const terminal = (channel: FakeChannel, autoInquire = false): EcrTerminal =>
  new EcrTerminal(channel, 'TW1', TestKeys.unsigned(stateDir(), { autoInquireOnFailure: autoInquire }));

function as<T>(value: unknown, type: abstract new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(type);
  return value as T;
}

const references = (entries: JournalEntry[]): string[] => entries.map((e) => e.reference);

describe('FinancialGuard', () => {
  it('does not send an approved or declined reference again', async () => {
    const t = terminal(new FakeChannel((_r, n) => (n === 0 ? APPROVED : DECLINED)));

    expect(await t.sale('1', 'ORD-1')).toBeInstanceOf(Approved);
    const error = await t.sale('1', 'ORD-1').catch((e: unknown) => e);
    const duplicate = as(error, DuplicateMerchantReferenceException);
    expect(duplicate.previous.state).toBe(JournalEntry.APPROVED);
    expect(duplicate.message).toContain('A new attempt needs a new reference');
    expect(await t.sale('1', 'ORD-2')).toBeInstanceOf(Declined);
    await expect(t.void('24', { merchantReference: 'ORD-2' })).rejects.toThrow(DuplicateMerchantReferenceException);
  });

  it('blocks new money movement while an outcome is unknown, until an inquiry settles it', async () => {
    // The sale's answer is lost; the till asks later and learns it was approved.
    const channel = new FakeChannel((_r, n) => (n === 0 ? null : n === 1 ? Wire.FOUND : APPROVED));
    const t = terminal(channel);
    const key = t.terminalKey();

    expect(await t.sale('1.234', 'ORD-1')).toBeInstanceOf(Failed);
    expect(references(await t.guard().unresolved(key))).toEqual(['ORD-1']);

    const blocked = as(await t.sale('5', 'ORD-2'), Failed);
    expect(blocked.failure).toBeInstanceOf(Unresolved);
    expect(blocked.failure.outcomeUnknown(), 'nothing was sent').toBe(false);
    expect(blocked.failure.message).toContain('ORD-1');
    expect(channel.requests, 'the blocked sale never left').toHaveLength(1);

    const resent = await t.sale('1.234', 'ORD-1').catch((e: unknown) => e);
    expect(as(resent, DuplicateMerchantReferenceException).message).toContain('inquire by this reference, never resend');

    expect(await t.inquireByReference('ORD-1')).toBeInstanceOf(Found);
    expect(await t.guard().unresolved(key)).toEqual([]);
    expect((await t.guard().entry(key, 'ORD-1'))?.state).toBe(JournalEntry.APPROVED);
    expect(await t.sale('5', 'ORD-2')).toBeInstanceOf(Approved);
  });

  it('does not let not-found settle an unknown outcome, but an operator can', async () => {
    const t = terminal(new FakeChannel((_r, n) => (n === 0 ? null : n === 1 ? NOT_FOUND : APPROVED)));
    const key = t.terminalKey();

    await t.sale('1', 'ORD-1');
    expect(await t.inquireByReference('ORD-1')).toBeInstanceOf(NotFound);
    expect(await t.guard().unresolved(key)).toHaveLength(1);
    expect((await t.guard().entry(key, 'ORD-1'))?.note ?? '').toContain('does not prove nothing was charged');

    const resolved = await t.guard().markResolved(key, 'ORD-1', 'Checked the terminal batch report: not charged');
    expect(resolved.state).toBe(JournalEntry.RESOLVED);
    expect(await t.sale('1', 'ORD-2')).toBeInstanceOf(Approved);
  });

  it('settles the journal at once when the automatic inquiry finds the sale', async () => {
    const t = terminal(new FakeChannel((_r, n) => (n === 0 ? null : Wire.FOUND)), true);
    const failed = as(await t.sale('1.234', 'ORD-1'), Failed);

    expect(failed.settled()).toBe(true);
    expect(await t.guard().unresolved(t.terminalKey())).toEqual([]);
    const entry = await t.guard().entry(t.terminalKey(), 'ORD-1');
    expect(entry?.state).toBe(JournalEntry.APPROVED);
    expect(entry?.failure).toContain('connection_lost');
  });

  it('keeps a found status other than approved or declined unresolved', async () => {
    const voided = '{"success":true,"data":{"stan":"1","status":"Voided","amount":"1.000"}}';
    const t = terminal(new FakeChannel((_r, n) => (n === 0 ? null : voided)), true);
    await t.sale('1', 'ORD-1');
    expect(await t.guard().unresolved(t.terminalKey())).toHaveLength(1);
  });

  it('leaves the reference free and nothing pending when nothing was sent', async () => {
    const t = terminal(new FakeChannel((_r, n) => {
      if (n === 0) throw new EcrIOException('Connection refused');
      return APPROVED;
    }));
    const unreachable = as(await t.sale('1', 'ORD-1'), Failed);
    expect(unreachable.failure.outcomeUnknown()).toBe(false);
    expect(await t.guard().unresolved(t.terminalKey())).toEqual([]);
    expect(await t.sale('1', 'ORD-1'), 'the reference was never used').toBeInstanceOf(Approved);
  });

  it('refuses a second financial transaction while one runs as busy, and does not send it', async () => {
    let second: EcrResult | undefined;
    let inner: EcrTerminal | null = null;
    const channel = new FakeChannel(async (_r, n) => {
      if (n === 0) {
        // While this sale is out, another request (another process, in production) tries the same terminal.
        second = await inner!.sale('2', 'ORD-2');
        const inquiry = await inner!.inquire('24', '20260806');
        expect(inquiry, 'inquiries are never blocked').not.toBeNull();
      }
      return n === 0 ? APPROVED : NOT_FOUND;
    });
    const t = terminal(channel);
    inner = new EcrTerminal(channel, 'TW1', TestKeys.unsigned(stateDir(), { autoInquireOnFailure: false }));

    expect(await t.sale('1', 'ORD-1')).toBeInstanceOf(Approved);
    const busy = as(second, Failed);
    expect(busy.failure).toBeInstanceOf(Busy);
    expect(busy.failure.outcomeUnknown()).toBe(false);
    expect(channel.requests.map((r) => Wire.obj(r).str('merchantReference'))).not.toContain('ORD-2');
    expect(await t.guard().entry(t.terminalKey(), 'ORD-2'), 'a busy refusal leaves no trace').toBeNull();
  });

  it('leaves a pending entry that blocks when the process dies mid-wait', async () => {
    const t = terminal(new FakeChannel(() => {
      throw new Error('fatal error: the process is being stopped');
    }));
    await expect(t.sale('1', 'ORD-1')).rejects.toThrow('fatal error');

    const open = await t.guard().unresolved(t.terminalKey());
    expect(open).toHaveLength(1);
    expect(open[0]!.state).toBe(JournalEntry.PENDING);
    expect(open[0]!.amountMinorUnits).toBe('1000');
    expect(open[0]!.currencyCode).toBe('512');
  });

  it('is shared by terminal, not by object', async () => {
    await new EcrTerminal(FakeChannel.always(null), 'TW1', TestKeys.unsigned(stateDir(), { autoInquireOnFailure: false })).sale('1', 'ORD-1');
    const later = new EcrTerminal(FakeChannel.always(APPROVED), 'TW1', TestKeys.unsigned(stateDir(), { autoInquireOnFailure: false }));
    expect(as(await later.sale('1', 'ORD-2'), Failed).failure).toBeInstanceOf(Unresolved);
  });

  it('guards Web Service the same way', async () => {
    const http = new FakeHttpTransport((_url, _body, n) => {
      if (n === 0) throw new HttpTransportException('timed out', true);
      return new HttpResponse(200, '{"success":true,"responseCode":"00","data":{"status":"Declined","stan":"000009","amount":"1.000"}}');
    });
    const ws = new EcrWebServiceTerminal('TW1', TestKeys.webService(stateDir()), { http });

    expect(await ws.sale('1', 'WS-1')).toBeInstanceOf(Failed);
    expect(as(await ws.sale('1', 'WS-2'), Failed).failure).toBeInstanceOf(Unresolved);
    expect(http.posts).toHaveLength(1);

    expect(await ws.inquireByReference('WS-1')).toBeInstanceOf(Found);
    expect((await ws.guard().entry(ws.terminalKey(), 'WS-1'))?.state).toBe(JournalEntry.DECLINED);
  });

  it('can be turned off for tills that enforce the rules themselves', async () => {
    const t = new EcrTerminal(FakeChannel.always(null), 'TW1', new EcrConfig({ guardFinancialOperations: false, autoInquireOnFailure: false, stateDirectory: stateDir() }));
    await t.sale('1', 'ORD-1');
    expect(await t.sale('1', 'ORD-1')).toBeInstanceOf(Failed);
    expect(await t.guard().unresolved(t.terminalKey())).toEqual([]);
  });

  it('keeps references that look like numbers, and fails closed when the journal is corrupt', () => {
    const journal = new FileTransactionJournal(stateDir());
    journal.put('k', new JournalEntry('0', 'Sale', JournalEntry.UNKNOWN, '1000', '512', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z'));
    journal.put('k', new JournalEntry('1', 'Sale', JournalEntry.APPROVED, '1000', '512', '2026-10-25T00:00:01Z', utcNow()));

    expect(journal.find('k', '0')?.reference).toBe('0');
    expect(references(journal.unresolved('k'))).toEqual(['0']);

    for (const file of readdirSync(stateDir()).filter((f) => /^journal-.*\.json$/.test(f))) {
      writeFileSync(join(stateDir(), file), '{corrupt');
    }
    expect(() => journal.find('k', '0')).toThrow(RuntimeException);
  });

  it('prunes old settled entries but keeps unresolved ones', () => {
    const journal = new FileTransactionJournal(stateDir(), 1);
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
    journal.put('k', new JournalEntry('OLD-OK', 'Sale', JournalEntry.APPROVED, '1', '512', old, old));
    journal.put('k', new JournalEntry('OLD-UNKNOWN', 'Sale', JournalEntry.UNKNOWN, '1', '512', old, old));
    journal.put('k', new JournalEntry('NEW', 'Sale', JournalEntry.APPROVED, '1', '512', old, utcNow()));

    expect(journal.find('k', 'OLD-OK')).toBeNull();
    expect(journal.find('k', 'OLD-UNKNOWN')).not.toBeNull();
    expect(journal.find('k', 'NEW')).not.toBeNull();
  });

  it('has an exclusive, releasable lock', () => {
    const lock = new FileTerminalLock(stateDir());
    const release = lock.tryAcquire('terminal-a');
    expect(release).not.toBeNull();
    expect(lock.tryAcquire('terminal-a'), 'held').toBeNull();
    const other = lock.tryAcquire('terminal-b');
    expect(other, 'another terminal is independent').not.toBeNull();
    release!();
    release!(); // safe to call twice
    const again = lock.tryAcquire('terminal-a');
    expect(again).not.toBeNull();
    again!();
    other!();
  });

  it('needs a known reference and a note to mark resolved', async () => {
    const guard = FinancialGuard.fromConfig(new EcrConfig({ stateDirectory: stateDir(), guardFinancialOperations: true }));
    await expect(guard.markResolved('k', 'NOPE', 'note')).rejects.toThrow(InvalidArgumentException);
  });
});
