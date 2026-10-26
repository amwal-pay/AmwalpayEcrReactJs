import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EcrChannelTimeout, EcrIOException } from '../../src/channel/EcrChannel.js';
import { EcrFrames } from '../../src/channel/EcrFrames.js';
import { TcpEcrChannel } from '../../src/channel/TcpEcrChannel.js';
import { EcrTerminal } from '../../src/EcrTerminal.js';
import { ConnectionLost, Malformed, Timeout, Unreachable } from '../../src/failure/Failure.js';
import { Approved, Failed, Found, InquiryFailed } from '../../src/result/results.js';
import { BackgroundProcess } from '../support/BackgroundProcess.js';
import { TestKeys, useTempState } from '../support/keys.js';
import { Wire } from '../support/wire.js';

/**
 * The TCP channel against a real socket on the loopback interface: the one
 * place the operating system's TCP stack is on the other end. Includes the two
 * deliberate deviations from the Kotlin SDK the Windows SDK pins: a connect
 * failure is unreachable (nothing sent), a reset after sending is a lost
 * connection (outcome unknown).
 */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../support/scripted-tcp-server.mjs');
const stateDir = useTempState();

let record: string | null = null;
const servers: BackgroundProcess[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  record = null;
});

async function server(modes: string, answer: string | null = null): Promise<BackgroundProcess> {
  record = join(stateDir(), 'requests.log');
  const args = [`--modes=${modes}`, `--record=${record}`];
  if (answer !== null) args.push(`--answer=${Buffer.from(answer, 'utf8').toString('base64')}`);
  const bg = await BackgroundProcess.start(SCRIPT, args);
  servers.push(bg);
  return bg;
}

function rawRequests(): Buffer[] {
  if (record === null || !existsSync(record)) return [];
  return readFileSync(record, 'utf8').split('\n').filter((l) => l !== '').map((l) => Buffer.from(l, 'base64'));
}

const text = (body: Uint8Array): string => Buffer.from(body).toString('utf8');

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe('TcpEcrChannel', () => {
  it('frames a request on the wire and returns the answer body', async () => {
    const s = await server('answer', '{"responseCode":"00"}');
    const body = await new TcpEcrChannel('127.0.0.1', s.port).exchange('{"messageType":"SALE"}', 10);

    expect(text(body)).toBe('{"responseCode":"00"}');
    const raw = rawRequests()[0]!;
    expect([...raw.subarray(0, 2)]).toEqual([0x00, 0x16]);
    expect(raw.subarray(2).toString()).toBe('{"messageType":"SALE"}');
  });

  it('round-trips long and non-ASCII messages both ways', async () => {
    const answer = '{"message":"تمت الموافقة — café €","pad":"' + 'y'.repeat(700) + '"}';
    const s = await server('answer', answer);
    const request = '{"pad":"' + 'x'.repeat(400) + '","t":"Café ☕"}';

    expect(text(await new TcpEcrChannel('127.0.0.1', s.port).exchange(request, 10))).toBe(answer);
    expect(rawRequests()[0]!.subarray(2).toString('utf8')).toBe(request);
  });

  it('assembles an answer arriving in pieces', async () => {
    const s = await server('pieces', '{"responseCode":"00","approved":true}');
    expect(text(await new TcpEcrChannel('127.0.0.1', s.port).exchange('{}', 10))).toBe('{"responseCode":"00","approved":true}');
  });

  it('uses a connection of its own for each exchange', async () => {
    const s = await server('answer');
    const channel = new TcpEcrChannel('127.0.0.1', s.port);
    await channel.exchange('{"n":1}', 10);
    await channel.exchange('{"n":2}', 10);
    expect(rawRequests().map((r) => r.subarray(2).toString())).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('refuses a request too large for a frame before connecting', async () => {
    const s = await server('answer');
    const error = await rejection(new TcpEcrChannel('127.0.0.1', s.port).exchange('x'.repeat(EcrFrames.MAX_BODY_BYTES + 1), 10));
    expect(error).toBeInstanceOf(EcrIOException);
    expect(error.message).toContain('does not fit a frame');
    expect(error.message).not.toContain('closed the connection');
    expect(rawRequests()).toEqual([]);
  });

  it('reads an answer that never comes as a channel timeout within its budget', async () => {
    const s = await server('stall');
    const started = performance.now();
    const error = await rejection(new TcpEcrChannel('127.0.0.1', s.port).exchange('{}', 0.4));
    const elapsed = (performance.now() - started) / 1000;
    expect(error).toBeInstanceOf(EcrChannelTimeout);
    expect(error.message).toContain('did not answer in time');
    expect(elapsed, 'gave up early').toBeGreaterThanOrEqual(0.35);
    expect(elapsed, 'gave up late').toBeLessThan(5);
  });

  it('keeps the answer budget separate from the connect budget', async () => {
    const s = await server('slow');
    expect((await new TcpEcrChannel('127.0.0.1', s.port, 0.2).exchange('{}', 10)).length).toBeGreaterThan(0);
  });

  it('reads a refused connection as an I/O error, not a timeout', async () => {
    const channel = new TcpEcrChannel('127.0.0.1', await BackgroundProcess.freePort(), 3);
    const error = await rejection(channel.exchange('{}', 10));
    expect(error).toBeInstanceOf(EcrIOException);
    expect(error).not.toBeInstanceOf(EcrChannelTimeout);
    expect(error.message.trim()).not.toBe('');
    expect(await channel.probe(2), 'a refused probe says why').not.toBeNull();
  });

  it('reads a connect to an unroutable address as unreachable, within its budget', async () => {
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): never routable.
    const started = performance.now();
    const t = new EcrTerminal(new TcpEcrChannel('192.0.2.1', 9100, 0.3), 'TW1', TestKeys.unsigned(stateDir(), { autoInquireOnFailure: true }));
    const failed = await t.sale('1.234', 'ORD-1');

    expect(failed).toBeInstanceOf(Failed);
    const f = failed as Failed;
    expect(f.failure).toBeInstanceOf(Unreachable);
    expect(f.failure.outcomeUnknown()).toBe(false);
    expect(f.recovered, 'nothing was sent, so nothing is asked twice').toBeNull();
    expect((performance.now() - started) / 1000).toBeLessThan(5);

    const inquiry = await new EcrTerminal(new TcpEcrChannel('192.0.2.1', 9100, 0.3), 'TW1', TestKeys.unsigned(stateDir())).inquireByReference('ORD-1');
    expect(inquiry).toBeInstanceOf(InquiryFailed);
    expect((inquiry as InquiryFailed).failure, 'a connect timeout is never a response timeout').not.toBeInstanceOf(Timeout);
  });

  it('reads a server that closes before or during the answer as a closed connection', async () => {
    const drop = await server('drop');
    const dropped = await rejection(new TcpEcrChannel('127.0.0.1', drop.port).exchange('{}', 10));
    expect(dropped.message).toContain('closed the connection');
    expect(dropped.message).toContain('response header');
    await drop.stop();

    const truncated = await server('truncated');
    const cut = await rejection(new TcpEcrChannel('127.0.0.1', truncated.port).exchange('{}', 10));
    expect(cut.message).toContain('response body');
  });

  it('reads a zero-length answer as an empty message', async () => {
    const s = await server('zero');
    expect((await rejection(new TcpEcrChannel('127.0.0.1', s.port).exchange('{}', 10))).message).toContain('empty message');
  });

  it('reads a reset after the request as a lost connection, not an address problem', async () => {
    const s = await server('reset');
    const error = await rejection(new TcpEcrChannel('127.0.0.1', s.port).exchange('{}', 10));
    expect(error).not.toBeInstanceOf(EcrChannelTimeout);
    expect(error.message.startsWith('Terminal closed the connection')).toBe(true);
  });

  it('recovers a reset over real TCP by inquiry, and reads garbage as malformed', async () => {
    const s = await server('reset,answer', Wire.FOUND);
    const t = new EcrTerminal('127.0.0.1', 'TW1', TestKeys.unsigned(stateDir(), { port: s.port, autoInquireOnFailure: true }));
    const failed = (await t.sale('1.234', 'ORD-77')) as Failed;

    expect(failed).toBeInstanceOf(Failed);
    expect(failed.failure).toBeInstanceOf(ConnectionLost);
    expect(failed.failure.message.startsWith('Terminal closed the connection')).toBe(true);
    expect(failed.recovered).toBeInstanceOf(Found);
    expect(failed.settled()).toBe(true);
    const requests = rawRequests();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.toString()).toContain('"messageType":"SALE"');
    expect(requests[1]!.toString()).toContain('"originalMerchantReference":"ORD-77"');
    await s.stop();

    const garbage = await server('answer', 'this is not json');
    const malformed = (await new EcrTerminal('127.0.0.1', 'TW1', TestKeys.unsigned(stateDir() + '/g', { port: garbage.port })).sale('1', 'ORD-1')) as Failed;
    expect(malformed).toBeInstanceOf(Failed);
    expect(malformed.failure).toBeInstanceOf(Malformed);
  });

  it('sends nothing on a probe, and round-trips a sale', async () => {
    const s = await server('answer', '{"success":true,"responseCode":"00","message":"Approved","data":{"merchantReference":"ORD-1","amount":"1.234","rrn":"1","authCode":"2"}}');
    const t = new EcrTerminal('127.0.0.1', 'TW1', TestKeys.unsigned(stateDir(), { port: s.port }));

    expect(await t.isReachable()).toBe(true);
    const approved = await t.sale('1.234', 'ORD-1');
    expect(approved).toBeInstanceOf(Approved);
    expect((approved as Approved).amount).toBe('1.234');
    expect(rawRequests(), 'the probe sent nothing').toHaveLength(1);
  });

  it('describes its endpoint', () => {
    const channel = new TcpEcrChannel('10.0.0.5', 9200);
    expect(channel.host()).toBe('10.0.0.5');
    expect(channel.port()).toBe(9200);
    expect(channel.endpoint()).toBe('10.0.0.5:9200');
    expect(new TcpEcrChannel('10.0.0.5').port()).toBe(9100);
    // As the Windows SDK: an empty host is not refused here; connecting fails instead.
    expect(new TcpEcrChannel('').host()).toBe('');
  });
});
