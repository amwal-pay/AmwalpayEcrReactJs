import { describe, expect, it } from 'vitest';
import { EcrWireResponse } from '../../src/EcrWireResponse.js';
import { ConnectionLost, Timeout } from '../../src/failure/Failure.js';
import { WireReaders } from '../../src/internal/WireReaders.js';
import { NextStep } from '../../src/result/NextStep.js';
import {
  Approved,
  CloseReceiptRefused,
  Declined,
  Failed,
  Found,
  NotFound,
  ReceiptClosed,
  ReceiptReady,
  ReceiptUnavailable,
} from '../../src/result/results.js';
import { Wire } from '../support/wire.js';

/**
 * The same approved / declined / failed / found / not-found semantics as the
 * Windows SDK, over the real terminal and Hub payloads its tests pin
 * (InquiryReadingTests, EcrWireResponseTests, TimeoutOutcomeReadingTests).
 */
const FOUND = `
{
  "success": true, "responseCode": "00", "message": "Transaction found",
  "data": {
    "merchantReference": "A1B2C3D4E5F6", "terminalSerial": "SN-WIFI-0001",
    "transactionId": "0e9a7c00-0000-4000-8000-000000000001", "stan": "000208", "systemTraceNr": "000208",
    "transactionType": "Purchase", "transactionTypeDisplayName": "Purchase", "status": "Approved",
    "amount": "0.258", "totalAmount": "0.258", "currency": "OMR", "currencyId": "512",
    "transactionTime": "2026-08-09T16:58:16.804271", "cardNumber": "543173******5785", "cardMask": "543173******5785",
    "cardHolderName": null, "rrn": "1000000000000000000001", "authCode": null, "batchId": "00000003",
    "terminalId": 30001, "merchantId": 10001, "isRefunded": false, "canVoid": true, "canRefund": true
  },
  "errorList": []
}`;

function as<T>(value: unknown, type: abstract new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(type);
  return value as T;
}

describe('sale, void, refund answers', () => {
  it('reads a unified approval field by field', () => {
    const answer = Wire.obj('{"success":true,"responseCode":"00","message":"Approved","data":{"merchantReference":"EA5C14BDB0A2",'
      + '"systemTraceNr":"000008","rrn":"623807390109","authCode":"713984","amount":"0.111","authorizeAmount":"0.111",'
      + '"cardMask":"543173xxxx5785","transactionTypeDisplayName":"Purchase"},"errorList":[]}');
    const approved = as(WireReaders.toResult(answer, 'SENT', 3), Approved);
    expect(approved.merchantReference, "the answer's own reference wins").toBe('EA5C14BDB0A2');
    expect(approved.amount).toBe('0.111');
    expect(approved.rrn).toBe('623807390109');
    expect(approved.authCode).toBe('713984');
    expect(approved.maskedPan).toBe('543173xxxx5785');
    expect(approved.partialApproval).toBe(false);
  });

  it('reads a legacy flat approval in major units', () => {
    const answer = Wire.obj('{"responseCode":"00","responseMessage":"Approved","approved":true,"amount":"000000001234","rrn":"622908275947","authCode":"751486"}');
    const approved = as(WireReaders.toResult(answer, 'ORD-1', 3), Approved);
    expect(approved.amount).toBe('1.234');
    expect(approved.merchantReference).toBe('ORD-1');
  });

  it('reads a partial approval as an approval that says so', () => {
    const answer = Wire.obj('{"success":true,"responseCode":"00","message":"Approved","data":{"merchantReference":"ORD-1","amount":"961.100","authorizeAmount":"50.000","isPartialApprove":true}}');
    const approved = as(WireReaders.toResult(answer, 'ORD-1', 3), Approved);
    expect(approved.partialApproval).toBe(true);
    expect(approved.amount).toBe('50.000');
    expect(approved.requestedAmount).toBe('961.100');
  });

  it('shows the amount when the authorised amount is zero or empty', () => {
    for (const authorized of ['"0"', '""', '0', '"0.000"']) {
      const answer = Wire.obj('{"success":true,"responseCode":"00","data":{"merchantReference":"R","amount":"0.111","authorizeAmount":' + authorized + '}}');
      expect(as(WireReaders.toResult(answer, 'R', 3), Approved).amount, 'authorizeAmount ' + authorized).toBe('0.111');
    }
  });

  it('uses the error list and response code for a decline', () => {
    const answer = Wire.obj('{"success":false,"responseCode":"909","message":"Declined","data":null,"errorList":["Insufficient funds"]}');
    const declined = as(WireReaders.toResult(answer, 'REF-1', 3), Declined);
    expect(declined.reason).toBe('Insufficient funds');
    expect(declined.responseCode).toBe('909');
    expect(declined.nextStep).toBe(NextStep.None);
  });

  it('gives a wordless decline a default reason', () => {
    expect(as(WireReaders.toResult(Wire.obj('{"success":false,"responseCode":"05"}'), 'R', 3), Declined).reason).toBe('Declined');
  });

  it.each([
    '{"success":false,"responseCode":"51","message":"Declined"}',
    '{"success":false,"responseCode":"51","message":"Declined","nextStep":"NONE"}',
    '{"success":false,"responseCode":"51","message":"Declined","nextStep":"SOMETHING_NEW"}',
    '{"responseCode":"51","responseMessage":"DECLINED","approved":false}',
  ])('reads an unknown or absent nextStep as an ordinary decline: %s', (answer) => {
    expect(as(WireReaders.toResult(Wire.obj(answer), 'R', 3), Declined).nextStep).toBe(NextStep.None);
  });

  it('reads an answer asking for an inquiry as an unknown outcome, never a decline', () => {
    const timeout = as(WireReaders.toResult(Wire.obj('{"success":false,"responseCode":"NO_RESPONSE","message":"timeout","nextStep":"INQUIRE_BY_MERCHANT_REFERENCE"}'), 'ORD-TIMEOUT-01', 3), Failed);
    const unsure = as(WireReaders.toResult(Wire.obj('{"success":false,"responseCode":"91","message":"Issuer unavailable","nextStep":"INQUIRE_BY_MERCHANT_REFERENCE"}'), 'ORD-2', 3), Failed);

    expect(timeout.failure).toBeInstanceOf(Timeout);
    expect(timeout.failure.message).toBe('timeout');
    expect(timeout.merchantReference).toBe('ORD-TIMEOUT-01');
    expect(timeout.nextStep()).toBe(NextStep.InquireByMerchantReference);
    expect(timeout.failure.outcomeUnknown()).toBe(true);
    expect(unsure.failure).toBeInstanceOf(ConnectionLost);
  });
});

describe('inquiry answers', () => {
  it('reads a found transaction field for field', () => {
    const found = as(WireReaders.toInquiry(Wire.obj(FOUND), 'SENT', 3), Found);
    const t = found.transaction;
    expect(found.merchantReference).toBe('A1B2C3D4E5F6');
    expect(t.transactionId).toBe('0e9a7c00-0000-4000-8000-000000000001');
    expect(t.stan).toBe('000208');
    expect(t.type).toBe('Purchase');
    expect(t.status).toBe('Approved');
    expect(t.isApproved()).toBe(true);
    expect(t.amount, 'the backend reports major units: not shifted again').toBe('0.258');
    expect(t.totalAmount).toBe('0.258');
    expect(t.currency).toBe('OMR');
    expect(t.maskedPan).toBe('543173******5785');
    expect(t.batchId).toBe('00000003');
    expect(t.terminalId).toBe('30001');
    expect(t.authCode, 'null reads as absent').toBe('');
    expect(t.cardHolderName).toBe('');
    expect(t.canVoid).toBe(true);
    expect(t.canRefund).toBe(true);
    expect(t.isRefunded).toBe(false);
    expect(t.day()).toBe('20260809');
    expect(found.raw).toContain('"transactionId":"0e9a7c00-0000-4000-8000-000000000001"');
  });

  it("carries the terminal's reason when nothing is found", () => {
    const notFound = as(WireReaders.toInquiry(Wire.obj('{"success":false,"responseCode":"25","message":"No transactions found for the provided STAN and Terminal","data":null,"errorList":[]}'), 'R', 3), NotFound);
    const silent = as(WireReaders.toInquiry(Wire.obj('{"success":false,"data":null}'), 'SENT', 3), NotFound);
    expect(notFound.reason).toBe('No transactions found for the provided STAN and Terminal');
    expect(silent.reason).toBe('Transaction not found');
    expect(silent.merchantReference).toBe('SENT');
  });

  it('reads success without a transaction as not found', () => {
    expect(WireReaders.toInquiry(Wire.obj('{"approved":true,"responseMessage":"Odd"}'), 'R', 3)).toBeInstanceOf(NotFound);
  });

  it('reads a declined transaction the terminal knows as found, not not-found', () => {
    const declined = as(WireReaders.toInquiry(Wire.obj('{"success":false,"responseCode":"51","message":"Declined","data":{"stan":"000013","status":"Declined","amount":961.1,"rrn":"624408152411"}}'), 'R', 3), Found);
    const refused = as(WireReaders.toInquiry(Wire.obj('{"responseCode":"51","responseMessage":"Declined","approved":false,"ecrResponse":{"success":false,"data":{"amount":"1.478"}}}'), 'R', 3), Found);
    expect(declined.transaction.status).toBe('Declined');
    expect(declined.transaction.isDeclined()).toBe(true);
    expect(declined.transaction.rrn).toBe('624408152411');
    expect(refused.transaction.status).toBe('Declined');
  });

  it('takes the status from the envelope when the record has none', () => {
    const replayed = Wire.obj('{"responseCode":"00","responseMessage":"Approved","approved":true,"amount":"000000001478","rrn":"622911288892",'
      + '"ecrResponse":{"success":true,"data":{"transactionId":"20ff0b20","systemTraceNr":"000149","actionCode":"00","amount":"1.478","transactionTypeDisplayName":"Purchase"}}}');
    const found = as(WireReaders.toInquiry(replayed, 'R', 3), Found);
    expect(found.transaction.status).toBe('Approved');
    expect(found.transaction.stan).toBe('000149');
  });

  it('reports both amounts of a partial approval', () => {
    const partial = as(WireReaders.toInquiry(Wire.obj('{"success":true,"responseCode":"00","data":{"stan":"000106","status":"Approved","amount":961.1,"authorizeAmount":50.0,"isPartialApprove":true}}'), 'R', 3), Found);
    const ordinary = as(WireReaders.toInquiry(Wire.obj('{"success":true,"responseCode":"00","data":{"stan":"000107","status":"Approved","amount":1.0}}'), 'R', 3), Found);
    expect(partial.transaction.partialApproval).toBe(true);
    expect(partial.transaction.amount).toBe('961.1');
    expect(partial.transaction.authorizedAmount).toBe('50.0');
    expect(ordinary.transaction.partialApproval).toBe(false);
    expect(ordinary.transaction.authorizedAmount).toBe('1.0');
  });

  it("falls back to the envelope's minor units when the record has no amounts", () => {
    const found = as(WireReaders.toInquiry(Wire.obj('{"success":true,"amount":"000000001478","data":{"stan":"1","status":"Approved"}}'), 'R', 3), Found);
    expect(found.transaction.amount).toBe('1.478');
  });

  it("reads the Hub's flat fields when nested data is only correlation", () => {
    const found = as(WireReaders.toInquiry(Wire.obj('{"success":true,"responseCode":"00","message":"Approved","data":{"merchantReference":"A9A14AE818B9","terminalSerial":"SN-WIFI-0001"},'
      + '"merchantReference":"A9A14AE818B9","systemTraceNr":"000032","status":"Approved","amount":"1.234","transactionId":"e970","rrn":"786","transactionTypeDisplayName":"Purchase","currency":"OMR"}'), 'R', 3), Found);
    const notFound = WireReaders.toInquiry(Wire.obj('{"success":false,"responseCode":"25","message":"Transaction not found","data":{"merchantReference":"A9A14AE818B9","terminalSerial":"SN-WIFI-0001"},"errorList":[]}'), 'A9A14AE818B9', 3);
    expect(found.transaction.stan).toBe('000032');
    expect(found.transaction.amount).toBe('1.234');
    expect(found.transaction.type).toBe('Purchase');
    expect(notFound, 'correlation-only data is not a found record').toBeInstanceOf(NotFound);
    expect((notFound as NotFound).reason).toBe('Transaction not found');
  });
});

describe('receipt and close receipt answers', () => {
  it('reads a receipt as the URL the terminal published', () => {
    const ready = as(WireReaders.toReceipt(Wire.obj('{"responseCode":"00","responseMessage":"Receipt ready","approved":true,"ecrResponse":{"success":true,"data":{"receiptUrl":"https://receipts.example.invalid/receipt?transactionId=0001","stan":"000215"}}}'), 'R'), ReceiptReady);
    const unavailable = as(WireReaders.toReceipt(Wire.obj('{"responseCode":"91","responseMessage":"The receipt could not be generated","approved":false,"ecrResponse":{"success":false,"data":null}}'), 'R'), ReceiptUnavailable);
    expect(ready.url).toBe('https://receipts.example.invalid/receipt?transactionId=0001');
    expect(unavailable.reason).toBe('The receipt could not be generated');
  });

  it('reads close receipt as idle or refused', () => {
    const idle = as(WireReaders.toReceiptClosed(Wire.obj('{"success":true,"responseCode":"00","message":"OK","data":{"merchantReference":"CLOSE-1"}}'), 'X'), ReceiptClosed);
    const refused = as(WireReaders.toReceiptClosed(Wire.obj('{"success":false,"responseCode":"96","message":"Unsupported","errorList":["CLOSE_RECEIPT not supported"]}'), 'CLOSE-1'), CloseReceiptRefused);
    expect(idle.merchantReference).toBe('CLOSE-1');
    expect(refused.responseCode).toBe('96');
    expect(refused.reason).toBe('CLOSE_RECEIPT not supported');
  });
});

describe('EcrWireResponse', () => {
  it('normalises legacy shapes', () => {
    const flat = EcrWireResponse.parse(Wire.obj('{"responseCode":"00","responseMessage":"Approved","approved":true,"amount":"000000001111"}'));
    const nested = EcrWireResponse.parse(Wire.obj('{"approved":true,"ecrResponse":{"success":true,"responseCode":"00","message":"Approved","data":{"rrn":"623807390109"},"errorList":[]}}'));
    const signed = EcrWireResponse.parse(Wire.obj('{"success":true,"data":{"merchantReference":"EA5C14BDB0A2","terminalSerial":"QQW"},"nonce":"82D8","secureHash":"ABC123"}'));
    expect(flat.success).toBe(true);
    expect(flat.message).toBe('Approved');
    expect(nested.success).toBe(true);
    expect(nested.data?.str('rrn')).toBe('623807390109');
    expect(signed.nonce).toBe('82D8');
    expect(signed.secureHash).toBe('ABC123');
    expect(signed.terminalSerial()).toBe('QQW');
  });

  it('falls back through the legacy reference keys', () => {
    expect(EcrWireResponse.parse(Wire.obj('{"success":true,"data":{"merchantReference":"CURRENT","merchantReferenceId":"LEGACY","requestId":"OLDER"}}')).merchantReference()).toBe('CURRENT');
    expect(EcrWireResponse.parse(Wire.obj('{"success":true,"data":{"merchantReferenceId":"LEGACY-1"}}')).merchantReference()).toBe('LEGACY-1');
    expect(EcrWireResponse.parse(Wire.obj('{"success":true,"data":{"requestId":"OLDER"}}')).merchantReference()).toBe('OLDER');
  });

  it('trims error list entries and drops blank or non-text ones', () => {
    const envelope = EcrWireResponse.parse(Wire.obj('{"success":false,"errorList":["  a  ","","   ",{"x":1},null,"b"]}'));
    expect(envelope.errorList).toEqual(['a', 'b']);
    expect(envelope.displayMessage()).toBe('a\nb');
  });

  it('falls back from success to approved, then to the response code', () => {
    expect(EcrWireResponse.parse(Wire.obj('{"success":"yes","approved":true}')).success).toBe(true);
    expect(EcrWireResponse.parse(Wire.obj('{"success":"yes","responseCode":"00"}')).success).toBe(true);
    expect(EcrWireResponse.parse(Wire.obj('{"success":"yes","responseCode":"51"}')).success).toBe(false);
    expect(EcrWireResponse.parse(Wire.obj('{}')).success).toBe(false);
  });

  it('reads a display message from raw text', () => {
    expect(EcrWireResponse.displayMessageFromRaw('{"success":false,"message":"Declined","errorList":["Insufficient funds"]}', 'Declined')).toBe('Insufficient funds');
    for (const raw of ['', 'not json', '[1]', 'null', '{"success":true}']) {
      expect(EcrWireResponse.displayMessageFromRaw(raw, 'fallback')).toBe('fallback');
    }
  });
});
