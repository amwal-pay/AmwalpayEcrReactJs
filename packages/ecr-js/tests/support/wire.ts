import { SecureHash } from '../../src/internal/SecureHash.js';
import { Json, JsonArray, JsonObject } from '../../src/json/Json.js';

/** Builders for the terminal's answers. */
export const Wire = {
  obj(text: string): JsonObject {
    return Json.parseObject(text);
  },

  /** The nonce the till put on a request; empty when it sent none. */
  nonceOf(request: string): string {
    return Wire.obj(request).str('nonce');
  },

  /** Signs `body` the way the terminal does and returns the wire text. */
  signed(body: JsonObject, key: string): string {
    body.set(SecureHash.FIELD, SecureHash.sign(SecureHash.compose(body), key));
    return body.toJson();
  },

  /** A unified approval envelope echoing `nonce`. */
  approval(nonce: string, reference = 'ORD-1'): JsonObject {
    return new JsonObject({
      success: true,
      responseCode: '00',
      message: 'Approved',
      data: new JsonObject({
        merchantReference: reference,
        terminalSerial: 'TW1',
        amount: '1.234',
        rrn: '622908275947',
        authCode: '751486',
      }),
      errorList: new JsonArray(),
      nonce,
    });
  },

  /** A found-transaction envelope echoing `nonce`. */
  foundEnvelope(nonce: string): JsonObject {
    return new JsonObject({
      success: true,
      responseCode: '00',
      message: 'Transaction found',
      data: new JsonObject({
        transactionId: 'abc-123',
        stan: '000131',
        status: 'Approved',
        amount: '1.234',
        rrn: '622908275947',
      }),
      errorList: new JsonArray(),
      nonce,
    });
  },

  FOUND: '{"success":true,"responseCode":"00","message":"Transaction found",'
    + '"data":{"transactionId":"abc-123","stan":"000131","status":"Approved","amount":"1.234","rrn":"622908275947",'
    + '"authCode":"751486","transactionTypeDisplayName":"Purchase"},"errorList":[]}',
};
