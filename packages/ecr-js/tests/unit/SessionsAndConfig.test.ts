import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EcrConfig, type EcrConfigOptions } from '../../src/EcrConfig.js';
import { EcrEnvironment } from '../../src/EcrEnvironment.js';
import { EcrSessions } from '../../src/EcrSessions.js';
import { EcrWebServiceTerminal } from '../../src/EcrWebServiceTerminal.js';
import { InvalidArgumentException, LogicException } from '../../src/exception/errors.js';
import { SecureHash } from '../../src/internal/SecureHash.js';
import { LanLink, WebServiceLink } from '../../src/link/EcrLink.js';
import { CloseReceiptFailed, ReceiptUnavailable } from '../../src/result/results.js';
import { WebServiceSecureHash } from '../../src/webservice/WebServiceSecureHash.js';
import { FakeHttpTransport } from '../support/FakeHttpTransport.js';
import { TestKeys, useTempState } from '../support/keys.js';
import { Wire } from '../support/wire.js';

/** Configuration and sessions: open Wi-Fi and Web Service without copying SDK internals. */
const stateDir = useTempState();

function as<T>(value: unknown, type: abstract new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(type);
  return value as T;
}

describe('EcrConfig', () => {
  it('defaults to an Omani deployment on the standard port', () => {
    const config = new EcrConfig();
    expect(config.ecrId).toBe('ECR01');
    expect(config.currencyCode).toBe('512');
    expect(config.minorUnitDigits).toBe(3);
    expect(config.port).toBe(9100);
    expect(config.connectTimeout).toBe(10);
    expect(config.responseTimeout).toBe(120);
    expect(config.probeTimeout).toBe(3);
    expect(config.secureHashKey).toBe('');
    expect(config.environment).toBe(EcrEnvironment.SIT);
    expect(config.autoInquireOnFailure).toBe(true);
    expect(config.guardFinancialOperations, 'opt-in: the Windows SDK has no guard').toBe(false);
    expect(config.signsMessages()).toBe(false);
    expect(EcrConfig.WEB_SERVICE_RESPONSE_TIMEOUT).toBe(130);
  });

  const keys = ['nothex', 'abc', 'aabb', 'aabbccddeeff001', 'aabbccddeeff0011223', 'aabbccddeeff00', 'g'.repeat(24), ' ' + TestKeys.WIFI, TestKeys.WIFI + '\n'];
  it.each<[string, EcrConfigOptions, string]>([
    ['digits -1', { minorUnitDigits: -1 }, 'minorUnitDigits'],
    ['digits 5', { minorUnitDigits: 5 }, 'minorUnitDigits'],
    ['port 0', { port: 0 }, 'port'],
    ['port 65536', { port: 65536 }, 'port'],
    ['timeout 0', { responseTimeout: 0 }, 'responseTimeout'],
    ['timeout negative', { connectTimeout: -1 }, 'connectTimeout'],
    ['timezone', { timezone: 'Mars/Olympus' }, 'timezone'],
    ...keys.map((key): [string, EcrConfigOptions, string] => ['key ' + JSON.stringify(key), { secureHashKey: key }, 'secureHashKey']),
  ])('refuses an invalid value the moment the config is built: %s', (_name, settings, named) => {
    expect(() => new EcrConfig(settings)).toThrow(InvalidArgumentException);
    expect(() => new EcrConfig(settings)).toThrow(named);
  });

  it('accepts well-formed keys, and with() copies and validates', () => {
    for (const key of ['', 'a'.repeat(16), 'A'.repeat(32), '0123456789abcdefABCDEF00']) {
      expect(new EcrConfig({ secureHashKey: key }).secureHashKey).toBe(key);
    }
    expect(new EcrConfig({ secureHashKey: null }).secureHashKey).toBe('');

    const original = new EcrConfig({ ecrId: 'TILL-1', currencyCode: '840', minorUnitDigits: 2, port: 9200, secureHashKey: TestKeys.WIFI, environment: EcrEnvironment.PROD });
    const changed = original.with({ responseTimeout: 60 });
    expect(changed.responseTimeout).toBe(60);
    expect(original.responseTimeout).toBe(120);
    expect(changed.ecrId).toBe('TILL-1');
    expect(changed.secureHashKey).toBe(TestKeys.WIFI);
    expect(changed.environment).toBe(EcrEnvironment.PROD);

    for (const bad of [{ port: 0 }, { minorUnitDigits: 9 }, { secureHashKey: 'abc' }, { noSuchSetting: 1 }]) {
      expect(() => original.with(bad as EcrConfigOptions), JSON.stringify(bad)).toThrow(InvalidArgumentException);
    }
  });

  it('never leaks the key through text, dumps or serialization', () => {
    const config = TestKeys.webService(stateDir());
    expect(String(config)).toContain('secureHashKey=<redacted>');
    expect(String(config)).toContain('environment=UAT');
    expect(String(config)).toContain('merchantId=10001');
    expect(String(new EcrConfig())).toContain('secureHashKey=empty');
    for (const text of [String(config), inspect(config), inspect(config, { showHidden: true, depth: 5 }), JSON.stringify({ ...config }), Object.keys(config).join(',')]) {
      expect(text.toLowerCase()).not.toContain(TestKeys.WEB_SERVICE);
    }
    expect(() => JSON.stringify(config)).toThrow(LogicException);
    expect(Object.isFrozen(config)).toBe(true);
  });

  // PHP's testTheKeyIsHiddenFromStackTraces checks #[SensitiveParameter]: JavaScript stack traces carry no arguments.
});

describe('plans', () => {
  it('is ready with host, port and key on Wi-Fi', () => {
    const plan = EcrSessions.plan(new LanLink('192.168.1.10', 9100), new EcrConfig({ secureHashKey: TestKeys.WIFI }));
    expect(plan.isReady()).toBe(true);
    expect(plan.usesLan()).toBe(true);
    expect(plan.connectionSummary()).toBe('192.168.1.10:9100');
    expect(plan.signingKeyLabel()).toBe(SecureHash.KEY_LABEL);
    expect(plan.signingKeyConfigured()).toBe(true);
  });

  it('reports what is missing on Wi-Fi without throwing', () => {
    const missing = EcrSessions.plan(new LanLink('  '), new EcrConfig());
    const badKey = EcrSessions.plan(new LanLink('127.0.0.1'), new EcrConfig(), 'abc');
    const url = EcrSessions.plan(new LanLink('http://192.168.1.10'), new EcrConfig({ secureHashKey: TestKeys.WIFI }));

    expect(missing.isReady()).toBe(false);
    expect(missing.issues()).toContain('IP address is required for Wi-Fi ECR');
    expect(missing.issues()).toContain('Wi-Fi/CABLE secure hash key is not configured');
    expect(badKey.isReady()).toBe(false);
    expect(badKey.issues()).toContain('Secure hash key must be an even-length hex string of at least 16 characters');
    expect(badKey.config.secureHashKey).toBe('');
    expect(url.isReady(), 'the Windows SDK does not judge the host').toBe(true);
  });

  it("trims the typed key, and the link's port wins", () => {
    const plan = EcrSessions.plan(new LanLink('10.0.0.5', 9200), new EcrConfig({ port: 9100 }), '  ' + TestKeys.WIFI + '\n');
    expect(plan.isReady()).toBe(true);
    expect(plan.config.secureHashKey).toBe(TestKeys.WIFI);
    expect(plan.config.port).toBe(9200);
    expect(plan.connectionSummary()).toBe('10.0.0.5:9200');
  });

  it.each([0, 65536, -1])('reports an out-of-range port %i as an issue, not an exception', (port) => {
    const plan = EcrSessions.plan(new LanLink('10.0.0.5', port), new EcrConfig({ secureHashKey: TestKeys.WIFI }));
    expect(plan.isReady()).toBe(false);
    expect(plan.issues().join('\n')).toContain('Port must be between 1 and 65535');
  });

  it('merges the IDs of a Web Service plan and raises the answer wait to 130 seconds', () => {
    const plan = EcrSessions.plan(new WebServiceLink('10001', '20001'), new EcrConfig({ secureHashKey: TestKeys.WEB_SERVICE, environment: EcrEnvironment.UAT }));
    const custom = EcrSessions.plan(new WebServiceLink('10001', '20001'), new EcrConfig({ secureHashKey: TestKeys.WEB_SERVICE, responseTimeout: 90 }));

    expect(plan.isReady()).toBe(true);
    expect(plan.usesWebService()).toBe(true);
    expect(plan.config.merchantId).toBe('10001');
    expect(plan.config.terminalId).toBe('20001');
    expect(plan.config.responseTimeout).toBe(130);
    expect(plan.config.connectTimeout + plan.config.responseTimeout).toBe(140);
    expect(plan.signingKeyLabel()).toBe(WebServiceSecureHash.KEY_LABEL);
    expect(plan.connectionSummary()).toBe('UAT · merchant 10001 · terminal 20001');
    expect(custom.config.responseTimeout, 'a wait the caller chose is kept').toBe(90);
    // long.TryParse: surrounding white space and a sign are numeric.
    expect(EcrSessions.plan(new WebServiceLink(' 10001 ', '+20001'), new EcrConfig({ secureHashKey: TestKeys.WEB_SERVICE })).isReady()).toBe(true);
  });

  it('reports missing or non-numeric Web Service IDs once', () => {
    const missing = EcrSessions.plan(new WebServiceLink('', ''), new EcrConfig());
    const letters = EcrSessions.plan(new WebServiceLink('M1', 'T1'), new EcrConfig({ secureHashKey: TestKeys.WEB_SERVICE }));

    expect(missing.issues()).toContain('Merchant ID is required for Web Service');
    expect(missing.issues()).toContain('Terminal ID is required for Web Service');
    expect(missing.issues()).toContain('Web Service secure hash key is not configured');
    expect(missing.issues()).toEqual([...new Set(missing.issues())]);
    expect(letters.issues()).toContain('Merchant ID must be numeric');
    expect(letters.issues()).toContain('Terminal ID must be numeric');
  });
});

describe('opening', () => {
  it('dispatches each link to its transport', async () => {
    const lan = EcrSessions.open('SN1', EcrSessions.plan(new LanLink('127.0.0.1'), new EcrConfig({ secureHashKey: TestKeys.WIFI })));
    const web = EcrSessions.open('SN1', EcrSessions.plan(new WebServiceLink('10001', '20001'), new EcrConfig({ secureHashKey: TestKeys.WEB_SERVICE })));

    expect(lan.usesLocalTerminal()).toBe(true);
    expect(lan.usesWebService()).toBe(false);
    expect(lan.supportsReceipt()).toBe(true);
    expect(lan.lanTerminal()).not.toBeNull();
    expect(web.usesWebService()).toBe(true);
    expect(web.supportsReceipt()).toBe(false);
    expect(await web.probeReachability(), 'the Hub has no probe').toBeNull();
    expect(web.webServiceTerminal()).toBeInstanceOf(EcrWebServiceTerminal);
  });

  it('cannot open a plan with issues, but can open one with a blank serial', () => {
    expect(() => EcrSessions.open('SN1', EcrSessions.plan(new LanLink(''), new EcrConfig({ secureHashKey: TestKeys.WIFI })))).toThrow('unresolved issues');
    // The Windows SDK opens it and sends the serial as given.
    expect(EcrSessions.open('  ', EcrSessions.plan(new LanLink('127.0.0.1'), new EcrConfig({ secureHashKey: TestKeys.WIFI }))).usesLocalTerminal()).toBe(true);
  });

  it('cannot fetch a receipt on Web Service, and needs the original reference to close one', async () => {
    const http = FakeHttpTransport.reply(200, '{"success":true,"responseCode":"00"}');
    const plan = EcrSessions.plan(new WebServiceLink('10001', '20001'), new EcrConfig({ secureHashKey: TestKeys.WEB_SERVICE, stateDirectory: stateDir() }));
    const session = EcrSessions.open('SN1', plan, { httpTransport: http });

    const receipt = as(await session.receipt('24', '20260817'), ReceiptUnavailable);
    const closed = as(await session.closeReceipt(), CloseReceiptFailed);
    await session.closeReceipt({ originalMerchantReference: 'ORD-1' });
    await session.closeReceipt({ merchantReference: 'ORD-2' });

    expect(receipt.reason).toContain('only supported over');
    expect(closed.failure.message).toContain('original merchant reference');
    expect(Wire.obj(http.posts[0]!.body).str('originalMerchantReference')).toBe('ORD-1');
    const single = Wire.obj(http.posts[1]!.body);
    expect(single.str('originalMerchantReference'), 'one reference is the original').toBe('ORD-2');
    expect(single.str('merchantReference'), 'and this request gets its own').not.toBe('ORD-2');
  });

  it('makes new merchant references in the SDK shape', () => {
    expect(EcrSessions.newMerchantReference()).toMatch(/^[0-9A-F]{12}$/);
    expect(EcrSessions.newMerchantReference()).not.toBe(EcrSessions.newMerchantReference());
  });
});
