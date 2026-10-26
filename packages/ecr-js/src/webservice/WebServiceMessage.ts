import { EcrTransactionType } from '../EcrTransactionType.js';
import { InvalidArgumentException, LogicException } from '../exception/errors.js';
import { EcrMessage } from '../internal/EcrMessage.js';
import { LocalTime } from '../internal/LocalTime.js';
import { MerchantReference } from '../internal/MerchantReference.js';
import { padLeft } from '../internal/text.js';
import { Validate } from '../internal/Validate.js';
import { JsonObject } from '../json/Json.js';
import { WebServiceSecureHash } from './WebServiceSecureHash.js';

/** What a Web Service body is built from. IDs are already numeric. */
export interface WebServiceMessageParts {
  merchantId: bigint | number;
  terminalId: bigint | number;
  terminalSerial: string;
  secureHashKey: string;
  currencyCode?: string;
  ecrId?: string;
  /** Required for sale and refund. */
  amountMinorUnits?: bigint | number | null;
  /** The receipt number, as given; padded here. */
  stan?: string;
  originalTransactionDate?: string;
  /** Inquiry by reference: the transaction looked up. Close receipt: the one dismissed. */
  originalMerchantReference?: string;
  merchantReference?: string;
  transactionDateTime?: string;
}

/**
 * Web Service request bodies: the Hub contract's field set per operation
 * (POS-552), signed with {@link WebServiceSecureHash}. Field order matches the
 * Windows SDK byte for byte.
 *
 * @internal
 */
export class WebServiceMessage {
  /** @returns the reference and the (signed) body */
  static build(type: EcrTransactionType, parts: WebServiceMessageParts): [string, JsonObject] {
    if (type === EcrTransactionType.CloseReceipt) return WebServiceMessage.buildCloseReceipt(parts);
    if (type === EcrTransactionType.Receipt) throw new LogicException('Receipt is not a Web Service operation');

    const {
      merchantId, terminalId, terminalSerial, secureHashKey, currencyCode = '512', ecrId = 'ECR01',
      amountMinorUnits = null, stan = '', originalTransactionDate = '', originalMerchantReference = '',
      merchantReference = '', transactionDateTime = '',
    } = parts;
    const reference = MerchantReference.resolve(merchantReference);
    const wireDateTime = transactionDateTime !== '' ? transactionDateTime : WebServiceMessage.now();
    const body = new JsonObject()
      .set('version', EcrMessage.PROTOCOL_VERSION)
      .set('messageType', type.messageType())
      .set('merchantId', merchantId)
      .set('terminalId', terminalId)
      .set('terminalSerial', terminalSerial)
      .set('ecrId', ecrId)
      .set('merchantReference', reference)
      .set('currencyCode', currencyCode)
      .set('transactionDateTime', wireDateTime)
      // The Hub validates this separately (RequestDateTimeIsRequired when omitted).
      .set('requestDateTime', wireDateTime);

    switch (type) {
      case EcrTransactionType.Sale:
        body.set('amount', WebServiceMessage.padded(amountMinorUnits));
        break;
      case EcrTransactionType.Void:
        body.set('stan', Validate.paddedStan(stan))
          .set('originalMerchantReference', reference)
          .set('originalTerminalId', terminalId);
        break;
      case EcrTransactionType.Refund:
        body.set('amount', WebServiceMessage.padded(amountMinorUnits))
          .set('stan', Validate.paddedStan(stan))
          .set('originalTransactionDate', originalTransactionDate)
          .set('originalMerchantReference', reference)
          .set('originalTerminalId', terminalId);
        break;
      case EcrTransactionType.Inquiry: {
        const invoiceStan = Validate.paddedStan(stan);
        const byReference = invoiceStan === '' && !Validate.isBlank(originalMerchantReference);
        // By STAN: empty originalMerchantReference. By reference: set it.
        body.set('stan', invoiceStan)
          .set('originalTransactionDate', originalTransactionDate)
          .set('originalMerchantReference', byReference ? MerchantReference.resolve(originalMerchantReference) : '')
          .set('originalTerminalId', terminalId);
        break;
      }
      default:
        throw new LogicException(`${type.displayName()} is not a Web Service operation`);
    }

    return [reference, secureHashKey === '' ? body : WebServiceSecureHash.withHash(body, secureHashKey)];
  }

  /**
   * The Hub's `/Ecr/closeReceipt` body: no `messageType`, no `currencyCode`.
   * `originalMerchantReference` is the sale, void or refund that just finished;
   * `merchantReference` is this close request's own id.
   */
  static buildCloseReceipt(parts: WebServiceMessageParts): [string, JsonObject] {
    const {
      merchantId, terminalId, terminalSerial, secureHashKey, ecrId = 'ECR01',
      merchantReference = '', originalMerchantReference = '', transactionDateTime = '',
    } = parts;
    if (Validate.isBlank(originalMerchantReference)) {
      throw new InvalidArgumentException('Close receipt needs the original merchant reference');
    }
    const reference = MerchantReference.resolve(merchantReference);
    const wireDateTime = transactionDateTime !== '' ? transactionDateTime : WebServiceMessage.now();
    const body = new JsonObject()
      .set('version', EcrMessage.PROTOCOL_VERSION)
      .set('merchantId', merchantId)
      .set('terminalId', terminalId)
      .set('terminalSerial', terminalSerial)
      .set('ecrId', ecrId)
      .set('merchantReference', reference)
      .set('transactionDateTime', wireDateTime)
      .set('requestDateTime', wireDateTime)
      .set('originalMerchantReference', MerchantReference.resolve(originalMerchantReference));

    return [reference, secureHashKey === '' ? body : WebServiceSecureHash.withHash(body, secureHashKey)];
  }

  /** The machine's local time, as `DateTime.Now`; the terminal passes a timestamp in the configured one. */
  private static now(): string {
    return LocalTime.stamp();
  }

  private static padded(minorUnits: bigint | number | null): string {
    if (minorUnits === null) throw new LogicException('This operation needs an amount');
    return padLeft(String(minorUnits), 12);
  }
}
