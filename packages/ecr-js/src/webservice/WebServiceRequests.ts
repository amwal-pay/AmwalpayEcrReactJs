import { EcrTransactionType } from '../EcrTransactionType.js';
import type { JsonObject } from '../json/Json.js';
import { WebServiceMessage } from './WebServiceMessage.js';

/** What every Hub body names. */
interface Common {
  merchantId: bigint | number;
  terminalId: bigint | number;
  terminalSerial: string;
  /** Blank: generated. */
  merchantReference?: string;
  ecrId?: string;
  /** `yyyyMMddHHmmss`. Blank: now, in the process's local time zone. */
  transactionDateTime?: string;
  /** Empty: the body is returned unsigned. */
  secureHashKey?: string;
}

interface WithCurrency extends Common {
  currencyCode?: string;
}

/**
 * Builds and signs Hub request bodies, for a caller that posts the JSON
 * itself. Sessions do this on their own; reach for these only when you own the
 * HTTP call. Each returns the body as a {@link JsonObject}: send `body.toJson()`.
 *
 * ```ts
 * const body = WebServiceRequests.sale({ merchantId: 10001n, terminalId: 20002n, terminalSerial: 'SN-WS-0001',
 *   amountMinorUnits: 1234, merchantReference: 'ORDER-1', secureHashKey: key });
 * ```
 */
export class WebServiceRequests {
  /** `amountMinorUnits`: OMR 1.234 is 1234. */
  static sale(o: WithCurrency & { amountMinorUnits: number }): JsonObject {
    return WebServiceMessage.build(EcrTransactionType.Sale, WebServiceRequests.parts(o, {
      amountMinorUnits: o.amountMinorUnits,
    }))[1];
  }

  static void(o: WithCurrency & { stan: string }): JsonObject {
    return WebServiceMessage.build(EcrTransactionType.Void, WebServiceRequests.parts(o, { stan: o.stan }))[1];
  }

  /** `originalTransactionDate`: `yyyyMMdd`. */
  static refund(o: WithCurrency & { amountMinorUnits: number; stan: string; originalTransactionDate: string }): JsonObject {
    return WebServiceMessage.build(EcrTransactionType.Refund, WebServiceRequests.parts(o, {
      amountMinorUnits: o.amountMinorUnits,
      stan: o.stan,
      originalTransactionDate: o.originalTransactionDate,
    }))[1];
  }

  /** Inquiry. By receipt number when `stan` is set; otherwise by `originalMerchantReference`. */
  static transactionStatus(o: WithCurrency & { stan?: string; originalTransactionDate?: string; originalMerchantReference?: string }): JsonObject {
    return WebServiceMessage.build(EcrTransactionType.Inquiry, WebServiceRequests.parts(o, {
      stan: o.stan ?? '',
      originalTransactionDate: o.originalTransactionDate ?? '',
      originalMerchantReference: o.originalMerchantReference ?? '',
    }))[1];
  }

  /** `/Ecr/closeReceipt`: `originalMerchantReference` is the sale, void or refund being dismissed. */
  static closeReceipt(o: Common & { originalMerchantReference: string }): JsonObject {
    return WebServiceMessage.buildCloseReceipt(WebServiceRequests.parts(o, {
      originalMerchantReference: o.originalMerchantReference,
    }))[1];
  }

  private static parts(o: WithCurrency, extra: Record<string, unknown>) {
    return {
      merchantId: o.merchantId,
      terminalId: o.terminalId,
      terminalSerial: o.terminalSerial,
      secureHashKey: o.secureHashKey ?? '',
      currencyCode: o.currencyCode ?? '512',
      ecrId: o.ecrId ?? 'ECR01',
      merchantReference: o.merchantReference ?? '',
      transactionDateTime: o.transactionDateTime ?? '',
      ...extra,
    };
  }
}
