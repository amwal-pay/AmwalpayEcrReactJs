import { describe, expect, it } from 'vitest';
import { EcrTransactionType } from '../../src/EcrTransactionType.js';
import { InvalidArgumentException, LogicException } from '../../src/exception/errors.js';
import { SecureHash } from '../../src/internal/SecureHash.js';
import { WebServiceMessage } from '../../src/webservice/WebServiceMessage.js';
import { WebServiceRequests } from '../../src/webservice/WebServiceRequests.js';
import { WebServiceSecureHash } from '../../src/webservice/WebServiceSecureHash.js';
import { TestKeys } from '../support/keys.js';

/**
 * Web Service signing and the Hub wire shapes (POS-552), pinned byte for byte
 * to the Windows SDK's expected bodies.
 */
const SALE_SIGNING_TEXT = 'amount=000000000111&currencyCode=512&ecrId=ECR01&merchantId=8899&merchantReference=EA5C14BDB0A2'
  + '&messageType=SALE&requestDateTime=20260826115847&terminalId=999&terminalSerial=QQW&transactionDateTime=20260826115847&version=1';

const ids = { merchantId: 8899n, terminalId: 999n, terminalSerial: 'QQW' };

describe('WebServiceSecureHash', () => {
  it('has the known answer for the Web Service signing string', () => {
    expect(WebServiceSecureHash.calcHash(SALE_SIGNING_TEXT, TestKeys.WEB_SERVICE)).toBe('FEF8D18506A6AC035DC825A1DBA4413EE885898BBCE27EE4A681683FFAADC61E');
    expect(WebServiceSecureHash.calcHash(SALE_SIGNING_TEXT, TestKeys.WIFI)).toBe('E4190003B5E8B496DAFE11C464F6BDA387735F1050C1DE69DCC4B2848D19F7C2');
  });

  it('signs a sale body over exactly the documented signing string', () => {
    const body = WebServiceRequests.sale({ ...ids, amountMinorUnits: 111, merchantReference: 'EA5C14BDB0A2', transactionDateTime: '20260826115847', secureHashKey: TestKeys.WEB_SERVICE });
    expect(WebServiceSecureHash.compose(body)).toBe(SALE_SIGNING_TEXT);
    expect(body.str('secureHashValue')).toBe('FEF8D18506A6AC035DC825A1DBA4413EE885898BBCE27EE4A681683FFAADC61E');
  });

  it('calcHash is empty for an invalid secret', () => {
    expect(WebServiceSecureHash.calcHash('amount=1', 'not-hex')).toBe('');
    expect(WebServiceSecureHash.calcHash('amount=1', '')).toBe('');
  });

  it('sale wire shape', () => {
    expect(WebServiceRequests.sale({ ...ids, amountMinorUnits: 111, merchantReference: 'EA5C14BDB0A2', transactionDateTime: '20260826115847' }).toJson()).toBe(
      '{"version":1,"messageType":"SALE","merchantId":8899,"terminalId":999,"terminalSerial":"QQW","ecrId":"ECR01","merchantReference":"EA5C14BDB0A2","currencyCode":"512","transactionDateTime":"20260826115847","requestDateTime":"20260826115847","amount":"000000000111"}',
    );
  });

  it('void wire shape', () => {
    expect(WebServiceRequests.void({ ...ids, stan: '8', merchantReference: '77619797A075', transactionDateTime: '20260826120107' }).toJson()).toBe(
      '{"version":1,"messageType":"VOID","merchantId":8899,"terminalId":999,"terminalSerial":"QQW","ecrId":"ECR01","merchantReference":"77619797A075","currencyCode":"512","transactionDateTime":"20260826120107","requestDateTime":"20260826120107","stan":"000008","originalMerchantReference":"77619797A075","originalTerminalId":999}',
    );
  });

  it('refund wire shape', () => {
    expect(WebServiceRequests.refund({ ...ids, amountMinorUnits: 22, stan: '11', originalTransactionDate: '20260826', merchantReference: '3FD2197EB935', transactionDateTime: '20260826120556' }).toJson()).toBe(
      '{"version":1,"messageType":"REFUND","merchantId":8899,"terminalId":999,"terminalSerial":"QQW","ecrId":"ECR01","merchantReference":"3FD2197EB935","currencyCode":"512","transactionDateTime":"20260826120556","requestDateTime":"20260826120556","amount":"000000000022","stan":"000011","originalTransactionDate":"20260826","originalMerchantReference":"3FD2197EB935","originalTerminalId":999}',
    );
  });

  it('inquiry by receipt wire shape', () => {
    expect(WebServiceRequests.transactionStatus({ ...ids, stan: '13', originalTransactionDate: '20260826', merchantReference: '0B574EB48120', transactionDateTime: '20260826120654' }).toJson()).toBe(
      '{"version":1,"messageType":"INQUIRY","merchantId":8899,"terminalId":999,"terminalSerial":"QQW","ecrId":"ECR01","merchantReference":"0B574EB48120","currencyCode":"512","transactionDateTime":"20260826120654","requestDateTime":"20260826120654","stan":"000013","originalTransactionDate":"20260826","originalMerchantReference":"","originalTerminalId":999}',
    );
  });

  it('inquiry by merchant reference wire shape', () => {
    expect(WebServiceRequests.transactionStatus({ ...ids, stan: '', originalTransactionDate: '20260826', merchantReference: 'INQ-NEW-REF01', transactionDateTime: '20260826120654', originalMerchantReference: 'ORD-88231ABC' }).toJson()).toBe(
      '{"version":1,"messageType":"INQUIRY","merchantId":8899,"terminalId":999,"terminalSerial":"QQW","ecrId":"ECR01","merchantReference":"INQ-NEW-REF01","currencyCode":"512","transactionDateTime":"20260826120654","requestDateTime":"20260826120654","stan":"","originalTransactionDate":"20260826","originalMerchantReference":"ORD-88231ABC","originalTerminalId":999}',
    );
  });

  it('close receipt wire shape has no messageType or currency', () => {
    const o = { merchantId: 10001n, terminalId: 20003n, terminalSerial: 'SN-WS-0002', originalMerchantReference: 'BB13726B7E261874', merchantReference: 'AC4C243243C6A7C5', transactionDateTime: '20261014113326' };
    expect(WebServiceRequests.closeReceipt(o).toJson()).toBe(
      '{"version":1,"merchantId":10001,"terminalId":20003,"terminalSerial":"SN-WS-0002","ecrId":"ECR01","merchantReference":"AC4C243243C6A7C5","transactionDateTime":"20261014113326","requestDateTime":"20261014113326","originalMerchantReference":"BB13726B7E261874"}',
    );
    const signed = WebServiceRequests.closeReceipt({ ...o, secureHashKey: TestKeys.WEB_SERVICE });
    expect(signed.str('secureHashValue')).toHaveLength(64);
    expect(WebServiceSecureHash.compose(signed)).not.toContain('secureHashValue');
  });

  it('withHash does not mutate its input and replaces an earlier hash', () => {
    const body = WebServiceRequests.sale({ ...ids, amountMinorUnits: 111, merchantReference: 'EA5C14BDB0A2', transactionDateTime: '20260826115847' });
    const once = WebServiceSecureHash.withHash(body, TestKeys.WIFI);
    const twice = WebServiceSecureHash.withHash(once, TestKeys.WEB_SERVICE);

    expect(body.has('secureHashValue'), "the caller's body is left alone").toBe(false);
    expect(once.str('secureHashValue')).not.toBe(twice.str('secureHashValue'));
    expect(twice.str('secureHashValue')).toBe(WebServiceSecureHash.sign(body, TestKeys.WEB_SERVICE));
    expect(WebServiceSecureHash.withHash(body, ''), 'an empty secret leaves the body unchanged').toBe(body);
  });

  it('refuses an invalid secret rather than sending an unsigned body', () => {
    const body = WebServiceRequests.sale({ merchantId: 1, terminalId: 2, terminalSerial: 'S', amountMinorUnits: 1, merchantReference: 'R' });
    expect(() => WebServiceSecureHash.withHash(body, 'not-hex')).toThrow(InvalidArgumentException);
  });

  it('a receipt is not a Web Service operation', () => {
    expect(() => WebServiceMessage.build(EcrTransactionType.Receipt, { merchantId: 1, terminalId: 2, terminalSerial: 'S', secureHashKey: '' })).toThrow(LogicException);
  });

  it('the two transports sign different fields', () => {
    expect(WebServiceSecureHash.FIELD).toBe('secureHashValue');
    expect(SecureHash.FIELD).toBe('secureHash');
  });
});
