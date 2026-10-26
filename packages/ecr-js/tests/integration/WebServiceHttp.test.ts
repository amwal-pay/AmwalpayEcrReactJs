import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EcrConfig, type EcrConfigOptions } from '../../src/EcrConfig.js';
import { EcrEnvironment } from '../../src/EcrEnvironment.js';
import type { EcrOpenedSession } from '../../src/EcrOpenedSession.js';
import { EcrSessions } from '../../src/EcrSessions.js';
import { Timeout, Unresolved } from '../../src/failure/Failure.js';
import { Json } from '../../src/json/Json.js';
import { WebServiceLink } from '../../src/link/EcrLink.js';
import { Approved, Declined, Failed, Found, NotFound, ReceiptClosed } from '../../src/result/results.js';
import { NodeHttpTransport } from '../../src/webservice/http/NodeHttpTransport.js';
import { WebServiceSecureHash } from '../../src/webservice/WebServiceSecureHash.js';
import { BackgroundProcess } from '../support/BackgroundProcess.js';
import { RewritingTransport } from '../support/FakeHttpTransport.js';
import { TestKeys, useTempState } from '../support/keys.js';

/**
 * Web Service through the real Node HTTP transport to a local fake Hub: real
 * HTTP, real status codes and deadlines, only the host changed.
 */
const HUB = join(dirname(fileURLToPath(import.meta.url)), '../support/fake-hub.mjs');
const stateDir = useTempState();

let hub: BackgroundProcess;
let recordDir: string;
let record: string;
let http: RewritingTransport;

beforeAll(async () => {
  recordDir = mkdtempSync(join(tmpdir(), 'ecr-hub-'));
  record = join(recordDir, 'requests.log');
  hub = await BackgroundProcess.start(HUB, [], { AMWAL_FAKE_HUB_RECORD: record });
});

afterAll(async () => {
  await hub.stop();
  rmSync(recordDir, { recursive: true, force: true });
});

function session(mode: string, config: EcrConfigOptions = {}): EcrOpenedSession {
  writeFileSync(record, '');
  http = new RewritingTransport(new NodeHttpTransport(), `http://127.0.0.1:${hub.port}`, mode);
  const plan = EcrSessions.plan(
    new WebServiceLink('10001', '20002'),
    new EcrConfig({ secureHashKey: TestKeys.WEB_SERVICE, environment: EcrEnvironment.UAT, stateDirectory: stateDir(), guardFinancialOperations: true, ...config }),
  );
  return EcrSessions.open('SN-WS-0001', plan, { httpTransport: http });
}

function received(): Array<{ path: string; contentType: string; body: string }> {
  return readFileSync(record, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
}

describe('Web Service over HTTP', () => {
  it('posts an approved sale, signed, to the sale endpoint', async () => {
    const approved = await session('approve').sale('1.234', 'WS-ORDER-1');

    expect(approved).toBeInstanceOf(Approved);
    expect((approved as Approved).amount).toBe('1.234');
    expect(http.urls[0], 'the SDK chose the UAT Hub').toBe('https://test.amwalpg.com:25453/Ecr/Sale');
    const first = received()[0]!;
    expect(first.path).toBe('/Ecr/Sale');
    expect(first.contentType.startsWith('application/json')).toBe(true);
    const body = Json.parseObject(first.body);
    expect(body.str('secureHashValue')).toBe(WebServiceSecureHash.sign(body, TestKeys.WEB_SERVICE));
    expect(body.str('merchantReference')).toBe('WS-ORDER-1');
  });

  it('reads a decline and a rejected signature as declines', async () => {
    const declined = await session('decline').sale('1.000', 'WS-D1');
    const rejected = await session('unauthorized').sale('1.000', 'WS-D2');
    expect(declined).toBeInstanceOf(Declined);
    expect((declined as Declined).reason).toBe('Insufficient funds');
    expect(rejected).toBeInstanceOf(Declined);
    expect((rejected as Declined).reason).toBe('secureHashValue mismatch');
  });

  it('reads every kind of missing answer as an unknown outcome that blocks the terminal', async () => {
    // A 5xx that explains itself is read as written (a decline), as in the Windows SDK.
    for (const [i, mode] of ['hub-timeout', 'error-500', 'empty', 'html'].entries()) {
      const s = session(mode, { stateDirectory: join(stateDir(), String(i)) });
      const failed = await s.sale('1.000', 'WS-U' + i);
      expect(failed, mode).toBeInstanceOf(Failed);
      expect((failed as Failed).failure.outcomeUnknown(), mode).toBe(true);
      expect((failed as Failed).recovered, 'Web Service never inquires by itself').toBeNull();

      const blocked = await s.sale('1.000', 'WS-NEXT' + i);
      expect(blocked).toBeInstanceOf(Failed);
      expect((blocked as Failed).failure, mode).toBeInstanceOf(Unresolved);
    }
  });

  it('ends the wait at the client deadline, as a timeout', async () => {
    const started = performance.now();
    const failed = await session('slow', { connectTimeout: 1, responseTimeout: 1 }).sale('1.000', 'WS-SLOW');
    expect(failed).toBeInstanceOf(Failed);
    expect((failed as Failed).failure).toBeInstanceOf(Timeout);
    expect((failed as Failed).failure.message).toContain('Timed out after 2s');
    expect((performance.now() - started) / 1000).toBeLessThan(3);
  });

  it('settles an unknown outcome by inquiry by reference', async () => {
    const s = session('hub-timeout');
    expect(await s.sale('1.234', 'WS-R1')).toBeInstanceOf(Failed);
    expect(await s.pendingOutcomes()).toHaveLength(1);

    http.mode('approve');
    const found = await s.inquireByReference('WS-R1');
    expect(found).toBeInstanceOf(Found);
    expect((found as Found).transaction.stan).toBe('000215');
    expect(await s.pendingOutcomes()).toEqual([]);
    expect((http.urls[1] ?? '').endsWith('/Ecr/Inquiry')).toBe(true);
  });

  it('reads not-found, and closes a receipt', async () => {
    expect(await session('not-found').inquire('215', '20261025')).toBeInstanceOf(NotFound);
    expect(await session('approve').closeReceipt({ originalMerchantReference: 'WS-ORDER-1' })).toBeInstanceOf(ReceiptClosed);
    expect(received()[0]!.path).toBe('/Ecr/closeReceipt');
  });
});
