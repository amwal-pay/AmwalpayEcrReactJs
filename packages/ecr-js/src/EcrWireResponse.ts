import { ResponseEnvelope } from './internal/ResponseEnvelope.js';
import { SecureHash } from './internal/SecureHash.js';
import { Json, type JsonObject } from './json/Json.js';

/**
 * The unified ECR response envelope:
 * `{ success, responseCode, message, data, errorList, nonce?, secureHash? }`.
 *
 * Legacy answers that nest the envelope under `ecrResponse`, or carry flat
 * `approved` / `responseMessage` fields, are normalised.
 */
export class EcrWireResponse {
  constructor(
    readonly success: boolean,
    readonly responseCode: string,
    readonly message: string,
    readonly data: JsonObject | null,
    readonly errorList: string[],
    readonly nonce: string = '',
    readonly secureHash: string = '',
  ) {}

  static parse(json: JsonObject): EcrWireResponse {
    return new EcrWireResponse(
      ResponseEnvelope.isSuccess(json),
      ResponseEnvelope.responseCode(json),
      ResponseEnvelope.wireMessage(json),
      ResponseEnvelope.data(json),
      ResponseEnvelope.errorList(json),
      json.str('nonce'),
      json.str(SecureHash.FIELD),
    );
  }

  /** `data.merchantReference`, then legacy `merchantReferenceId`, then `requestId`. */
  merchantReference(): string {
    if (this.data === null) return '';
    for (const key of ['merchantReference', 'merchantReferenceId', 'requestId']) {
      const value = this.data.str(key);
      if (value !== '') return value;
    }
    return '';
  }

  terminalSerial(): string {
    return this.data?.str('terminalSerial') ?? '';
  }

  /** User-facing text: `errorList` entries first, then the message. */
  displayMessage(): string {
    const errors = this.errorList.join('\n');
    return errors !== '' ? errors : this.message;
  }

  /**
   * User-facing text from raw JSON: `errorList` first, then `message`.
   * `fallback` when the text is empty, not a JSON object, or says nothing.
   */
  static displayMessageFromRaw(raw: string, fallback = ''): string {
    if (raw === '') return fallback;
    try {
      const text = EcrWireResponse.parse(Json.parseObject(raw)).displayMessage();
      return text !== '' ? text : fallback;
    } catch {
      return fallback;
    }
  }
}
