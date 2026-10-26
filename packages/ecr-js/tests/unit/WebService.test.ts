import { describe, expect, it } from 'vitest';
import { EcrConfig } from '../../src/EcrConfig.js';
import { EcrEnvironment } from '../../src/EcrEnvironment.js';
import { EcrTransactionType } from '../../src/EcrTransactionType.js';
import { EcrWebServiceTerminal } from '../../src/EcrWebServiceTerminal.js';
import { EcrWireResponse } from '../../src/EcrWireResponse.js';
import { ConnectionLost, Malformed, Timeout } from '../../src/failure/Failure.js';
import { formatTimestamp } from '../../src/internal/EcrMessage.js';
import { EcrLogger } from '../../src/log/EcrLogger.js';
import { NextStep } from '../../src/result/NextStep.js';
import { Approved, CloseReceiptFailed, Declined, Failed, Found, InquiryFailed, NotFound, ReceiptClosed } from '../../src/result/results.js';
import { HttpResponse, HttpTransportException } from '../../src/webservice/http/HttpTransport.js';
import { WebServiceApi } from '../../src/webservice/WebServiceApi.js';
import { WebServiceOperation } from '../../src/webservice/WebServiceOperation.js';
import { WebServiceRequests } from '../../src/webservice/WebServiceRequests.js';
import { WebServiceRoutes } from '../../src/webservice/WebServiceRoutes.js';
import { WebServiceSecureHash } from '../../src/webservice/WebServiceSecureHash.js';
import { FakeHttpTransport } from '../support/FakeHttpTransport.js';
import type { EcrConfig as Config } from '../../src/EcrConfig.js';
import { TestKeys, useTempState } from '../support/keys.js';
import { Wire } from '../support/wire.js';

/**
 * Web Service against a scripted transport: what is posted where, and how
 * every outcome, including no outcome, becomes one shape. A transport failure
 * read naively is a decline or "not found", both of which invite a till to
 * charge again.
 */
const stateDir = useTempState();

const terminal = (http: FakeHttpTransport, config: Config | null = null, logger: EcrLogger | null = null): EcrWebServiceTerminal =>
  new EcrWebServiceTerminal('TW1', config ?? TestKeys.webService(stateDir()), { logger, http });

const throws = (message: string, timedOut = false): FakeHttpTransport => new FakeHttpTransport(() => {
  throw new HttpTransportException(message, timedOut);
});

const smallSale = () => WebServiceRequests.sale({ merchantId: 1, terminalId: 2, terminalSerial: 'S', amountMinorUnits: 1, merchantReference: 'R' });

function as<T>(value: unknown, type: abstract new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(type);
  return value as T;
}

const noUsableAnswer: Array<[string, () => FakeHttpTransport, string, string]> = [
  ['network error', () => throws('Could not resolve host: test.amwalpg.com'), 'NO_RESPONSE', 'Could not resolve host'],
  ['deadline', () => throws('Operation timed out', true), 'NO_RESPONSE', 'Timed out after 2m 40s'],
  ['empty body', () => FakeHttpTransport.reply(200, '  '), '200', 'Empty response'],
  ['html', () => FakeHttpTransport.reply(200, '<html>bad gateway</html>'), '200', 'not valid JSON'],
  ['null', () => FakeHttpTransport.reply(200, 'null'), '200', 'not valid JSON'],
  ['array', () => FakeHttpTransport.reply(200, '[1,2]'), '200', 'not valid JSON'],
  ['repeated key', () => FakeHttpTransport.reply(200, '{"success":false,"success":true}'), '200', 'not valid JSON'],
  ['5xx with nothing readable', () => FakeHttpTransport.reply(500, '{}', 'Server Error'), '500', 'Server Error'],
];

describe('routes', () => {
  it('resolves each environment to its Hub, with fixed operation paths', () => {
    const sit = new WebServiceRoutes(EcrEnvironment.SIT);
    const uat = new WebServiceRoutes(EcrEnvironment.UAT);
    const prod = new WebServiceRoutes(EcrEnvironment.PROD);

    expect(sit.hub()).toBe('https://test.amwalpg.com:25452');
    expect(uat.url(WebServiceOperation.Sale)).toBe('https://test.amwalpg.com:25453/Ecr/Sale');
    expect(uat.url(WebServiceOperation.Void)).toBe('https://test.amwalpg.com:25453/Ecr/Void');
    expect(uat.url(WebServiceOperation.Refund)).toBe('https://test.amwalpg.com:25453/Ecr/Refund');
    expect(uat.url(WebServiceOperation.TransactionStatus)).toBe('https://test.amwalpg.com:25453/Ecr/Inquiry');
    expect(uat.url(WebServiceOperation.CloseReceipt)).toBe('https://test.amwalpg.com:25453/Ecr/closeReceipt');
    expect(prod.url(WebServiceOperation.Sale)).toBe('https://pos.amwalpg.com/Ecr/Sale');
    expect(sit.pathFor(EcrTransactionType.Receipt)).toBeNull();
    expect(WebServiceOperation.TransactionStatus.label()).toBe('Transaction status');
  });

  it('reads environment names ignoring case, falling back to SIT', () => {
    expect(EcrEnvironment.fromName(null)).toBe(EcrEnvironment.SIT);
    expect(EcrEnvironment.fromName('uat')).toBe(EcrEnvironment.UAT);
    expect(EcrEnvironment.fromName('  prod  ')).toBe(EcrEnvironment.PROD);
    expect(EcrEnvironment.fromName('production')).toBe(EcrEnvironment.SIT);
    expect(EcrEnvironment.fromName('')).toBe(EcrEnvironment.SIT);
  });
});

describe('the HTTP layer', () => {
  it("posts a sale as JSON to the environment's URL with the configured deadline", async () => {
    const http = FakeHttpTransport.reply(200, '{"success":true,"responseCode":"00"}');
    const api = new WebServiceApi(TestKeys.webService(stateDir(), { connectTimeout: 10, responseTimeout: 150 }), EcrLogger.none(), http);
    const body = WebServiceRequests.sale({ merchantId: 10001, terminalId: 20001, terminalSerial: 'TW1', amountMinorUnits: 111, merchantReference: 'REF-1', transactionDateTime: '20260826115847' });

    const answer = await api.postJson(WebServiceOperation.Sale, body);

    expect(answer.flag('success')).toBe(true);
    expect(http.posts).toHaveLength(1);
    const post = http.posts[0]!;
    expect(post.url).toBe('https://test.amwalpg.com:25453/Ecr/Sale');
    expect(post.body).toBe(body.toJson());
    expect(post.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(post.headers['Accept']).toBe('application/json');
    expect(post.connect).toBe(10);
    expect(post.total, 'the client deadline is connect + answer').toBe(160);
    expect(post.body.startsWith('{'), 'no byte order mark').toBe(true);
  });

  it('reads an HTTP error carrying an envelope as that envelope', async () => {
    const api = new WebServiceApi(TestKeys.webService(stateDir()), EcrLogger.none(), FakeHttpTransport.reply(
      400,
      '{"success":false,"responseCode":"400","message":"Invalid signature","errorList":["secureHashValue mismatch"]}',
    ));
    const wire = EcrWireResponse.parse(await api.postJson(WebServiceOperation.Sale, smallSale()));
    expect(wire.success).toBe(false);
    expect(wire.responseCode).toBe('400');
    expect(wire.displayMessage()).toBe('secureHashValue mismatch');
  });

  it.each(noUsableAnswer)('turns no usable answer (%s) into an unknown-outcome envelope, never a crash', async (_name, http, code, message) => {
    const api = new WebServiceApi(TestKeys.webService(stateDir(), { responseTimeout: 150 }), EcrLogger.none(), http());
    const answer = await api.postJson(WebServiceOperation.Sale, smallSale());
    const wire = EcrWireResponse.parse(answer);
    expect(wire.success).toBe(false);
    expect(wire.responseCode).toBe(code);
    expect(wire.message).toContain(message);
    expect(answer.str('nextStep')).toBe(WebServiceApi.UNKNOWN_OUTCOME_STEP);
  });

  it('refuses an answer body that is not UTF-8 as not valid JSON', async () => {
    const invalid = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]); // {"a":"\xC3("}
    const api = new WebServiceApi(TestKeys.webService(stateDir()), EcrLogger.none(), new FakeHttpTransport(() => new HttpResponse(200, invalid)));
    const answer = await api.postJson(WebServiceOperation.Sale, smallSale());
    expect(answer.str('message')).toContain('not valid JSON');
    expect(answer.str('nextStep')).toBe(WebServiceApi.UNKNOWN_OUTCOME_STEP);
  });
});

describe('sale, void, refund outcomes', () => {
  it.each(noUsableAnswer)('reads a sale that got no usable answer (%s) as unknown, not a decline', async (_name, http) => {
    const result = as(await terminal(http()).sale('1.000', 'ORD-1'), Failed);
    expect(result.failure.outcomeUnknown()).toBe(true);
    expect(result.nextStep()).toBe(NextStep.InquireByMerchantReference);
    expect(result.recovered, 'Web Service never inquires by itself').toBeNull();
    expect(result.merchantReference).toBe('ORD-1');
  });

  it('reads a network timeout as a timeout', async () => {
    expect(as(await terminal(throws('Operation timed out', true)).sale('1.000'), Failed).failure).toBeInstanceOf(Timeout);
  });

  it('reads a 5xx that explains itself as the Hub wrote it', async () => {
    // As the Windows SDK: a readable envelope is returned as read, so this is a decline.
    const result = as(await terminal(FakeHttpTransport.reply(502, '{"success":false,"responseCode":"502","message":"Terminal did not respond"}')).sale('1.000'), Declined);
    expect(result.reason).toBe('Terminal did not respond');
  });

  it('reads a real decline and a rejected request as declines with no follow-up', async () => {
    const declined = as(await terminal(FakeHttpTransport.reply(200, '{"success":false,"responseCode":"51","message":"Insufficient funds"}')).sale('1.000'), Declined);
    const rejected = await terminal(FakeHttpTransport.reply(401, '{}'), TestKeys.webService(stateDir() + '/b')).sale('1.000');
    expect(declined.responseCode).toBe('51');
    expect(declined.nextStep).toBe(NextStep.None);
    expect(rejected, 'the Hub refused the request outright: it did not act on it').toBeInstanceOf(Declined);
  });

  it('reads an approval, and signs the body with the Web Service key', async () => {
    const http = FakeHttpTransport.reply(200, '{"success":true,"responseCode":"00","message":"Approved","data":{"merchantReference":"ORD-7","amount":"1.234","rrn":"623807390109","authCode":"713984","cardMask":"543173xxxx5785"}}');
    const approved = as(await terminal(http).sale('1.234', 'ORD-7'), Approved);
    expect(approved.amount).toBe('1.234');
    const sent = Wire.obj(http.posts[0]!.body);
    expect(sent.str('messageType')).toBe('SALE');
    expect(sent.str('merchantId')).toBe('10001');
    expect(sent.str('amount')).toBe('000000001234');
    expect(sent.str('requestDateTime')).toBe(sent.str('transactionDateTime'));
    expect(sent.str('secureHashValue')).toBe(WebServiceSecureHash.sign(sent, TestKeys.WEB_SERVICE));
  });

  it('posts void and refund to their own paths with their own fields', async () => {
    const http = FakeHttpTransport.reply(200, '{"success":true,"responseCode":"00","data":{"amount":"0.500"}}');
    const t = terminal(http);
    await t.void('8', 'VOID-1');
    await t.refund('0.5', '11', '20260826', 'REF-1');

    expect(http.posts[0]!.url.endsWith('/Ecr/Void')).toBe(true);
    expect(http.posts[1]!.url.endsWith('/Ecr/Refund')).toBe(true);
    const voided = Wire.obj(http.posts[0]!.body);
    const refund = Wire.obj(http.posts[1]!.body);
    expect(voided.str('stan')).toBe('000008');
    expect(voided.str('originalMerchantReference')).toBe('VOID-1');
    expect(voided.str('originalTerminalId')).toBe('20001');
    expect(refund.str('amount')).toBe('000000000500');
    expect(refund.str('originalTransactionDate')).toBe('20260826');
  });

  it('reads an answer whatever version it declares', async () => {
    const result = await terminal(FakeHttpTransport.reply(200, '{"version":3,"success":true,"responseCode":"00"}')).sale('1');
    expect(result).toBeInstanceOf(Approved);
  });
});

describe('inquiry and close receipt', () => {
  it('reads an outage during an inquiry as a failed lookup, not not-found', async () => {
    const byReceipt = as(await terminal(throws('network down')).inquire('215', '20260826'), InquiryFailed);
    expect(byReceipt.failure).toBeInstanceOf(ConnectionLost);
    expect(await terminal(throws('network down')).inquireByReference('ORD-1')).toBeInstanceOf(InquiryFailed);
  });

  it('reads an inquiry the Hub rejects as the Windows SDK reads it', async () => {
    for (const [status, body] of [[401, '{}'], [400, '{"success":false,"responseCode":"400","message":"Invalid signature"}'], [404, '{}']] as const) {
      expect(await terminal(FakeHttpTransport.reply(status, body)).inquireByReference('ORD-1'), `HTTP ${status}`).toBeInstanceOf(NotFound);
    }
    // Only an answer that never came is a failed lookup.
    expect(await terminal(FakeHttpTransport.reply(503, '')).inquireByReference('ORD-1')).toBeInstanceOf(InquiryFailed);
  });

  it('still reads a real not-found as not found, and reads a found record', async () => {
    const notFound = await terminal(FakeHttpTransport.reply(200, '{"success":false,"responseCode":"25","message":"Transaction not found"}')).inquire('215', '20260826');
    const http = FakeHttpTransport.reply(200, '{"success":true,"responseCode":"00","data":{"stan":"000215","status":"Approved","amount":"1.234"}}');
    const found = await terminal(http).inquireByReference('ORD-88231', '', 'INQ-1');

    expect(notFound).toBeInstanceOf(NotFound);
    expect(found).toBeInstanceOf(Found);
    const sent = Wire.obj(http.posts[0]!.body);
    expect(sent.str('stan')).toBe('');
    expect(sent.str('originalMerchantReference')).toBe('ORD-88231');
    expect(sent.str('merchantReference')).toBe('INQ-1');
    expect(http.posts[0]!.url.endsWith('/Ecr/Inquiry')).toBe(true);
  });

  it('needs the original reference to close a receipt, and posts it', async () => {
    const http = FakeHttpTransport.reply(200, '{"success":true,"responseCode":"00","message":"OK"}');
    const missing = as(await terminal(http).closeReceipt(' '), CloseReceiptFailed);
    const closed = await terminal(http).closeReceipt('ORD-1');

    expect(missing.failure.message).toContain('original merchant reference');
    expect(closed).toBeInstanceOf(ReceiptClosed);
    expect(http.posts).toHaveLength(1);
    expect(http.posts[0]!.url.endsWith('/Ecr/closeReceipt')).toBe(true);
    expect(Wire.obj(http.posts[0]!.body).str('originalMerchantReference')).toBe('ORD-1');
  });
});

describe('decided before anything leaves', () => {
  it('fails locally and sends nothing for missing or non-numeric backend IDs', async () => {
    const http = FakeHttpTransport.reply(200, '{}');
    for (const [merchant, term] of [['', ''], ['M1', 'T1'], ['10001', '1.5'], ['99999999999999999999', '7']] as const) {
      const ws = terminal(http, new EcrConfig({ merchantId: merchant, terminalId: term, stateDirectory: stateDir() }));
      const sale = as(await ws.sale('1', 'REF-1'), Failed);
      const inquiry = as(await ws.inquire('24', '20260806', 'LOOKUP-1'), InquiryFailed);
      expect(sale.failure).toBeInstanceOf(Malformed);
      expect(sale.merchantReference).toBe('');
      expect(sale.failure.message).toContain('merchantId and terminalId');
      expect(inquiry.merchantReference).toBe('LOOKUP-1');
    }
    expect(http.posts).toEqual([]);
  });

  it('logs a signed body without the secret', async () => {
    const lines: string[] = [];
    await terminal(FakeHttpTransport.reply(200, '{"success":true}'), null, EcrLogger.from((l) => lines.push(l))).sale('1', 'REF-1');
    const log = lines.join('\n');
    expect(log).toContain('[Web Service] SALE POST https://test.amwalpg.com:25453/Ecr/Sale (env=UAT)');
    expect(log).toContain('signing key (Web Service secure hash key): configured');
    expect(log.toLowerCase()).not.toContain(TestKeys.WEB_SERVICE);
  });

  it('reads IDs as long.TryParse reads them', () => {
    expect(EcrWebServiceTerminal.id(' 10001 ')).toBe(10001n);
    expect(EcrWebServiceTerminal.id('007')).toBe(7n);
    expect(EcrWebServiceTerminal.id('-5')).toBe(-5n);
    expect(EcrWebServiceTerminal.id('+5')).toBe(5n);
    expect(EcrWebServiceTerminal.id('9223372036854775807')).toBe(9223372036854775807n);
    expect(EcrWebServiceTerminal.id('99999999999999999999')).toBeNull();
    expect(EcrWebServiceTerminal.id('1.5')).toBeNull();
    expect(EcrWebServiceTerminal.id('')).toBeNull();
  });

  it('stamps the time in the configured zone', async () => {
    const http = FakeHttpTransport.reply(200, '{"success":true}');
    await terminal(http, TestKeys.webService(stateDir(), { timezone: 'Pacific/Kiritimati' })).sale('1');
    const expected = formatTimestamp(new Date(), 'Pacific/Kiritimati').slice(0, 8);
    expect(Wire.obj(http.posts[0]!.body).str('transactionDateTime').startsWith(expected)).toBe(true);
    expect(new HttpResponse(200, '')).toBeInstanceOf(HttpResponse);
  });
});
