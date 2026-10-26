import { Amount } from '../Amount.js';
import { EcrWireResponse } from '../EcrWireResponse.js';
import { ConnectionLost, Timeout } from '../failure/Failure.js';
import type { JsonObject } from '../json/Json.js';
import { EcrTransaction } from '../result/EcrTransaction.js';
import { NextStep } from '../result/NextStep.js';
import {
  Approved,
  CloseReceiptRefused,
  Declined,
  type EcrInquiry,
  type EcrReceipt,
  type EcrReceiptClosed,
  type EcrResult,
  Failed,
  Found,
  NotFound,
  ReceiptClosed,
  ReceiptReady,
  ReceiptUnavailable,
} from '../result/results.js';
import { trim } from './text.js';
import { ResponseEnvelope } from './ResponseEnvelope.js';

/**
 * Reads an answer, from the terminal or the Hub, into the SDK's result types.
 * The same rules for Wi-Fi and Web Service.
 *
 * @internal
 */
export class WireReaders {
  /** Reads an answer to a sale, void or refund into one of the three outcomes. */
  static toResult(json: JsonObject, merchantReference: string, minorUnitDigits: number): EcrResult {
    const envelope = EcrWireResponse.parse(json);
    const data = envelope.data;
    const reference = orElse(envelope.merchantReference(), merchantReference);

    if (!envelope.success) {
      const nextStep = NextStep.fromWire(json.str('nextStep'));
      // A false envelope that asks for an inquiry is not a decline: money
      // may have moved. The Hub synthesises its timeouts this way
      // (responseCode NO_RESPONSE), so it surfaces as Failed.
      if (nextStep === NextStep.InquireByMerchantReference) {
        const reason = envelope.displayMessage() !== '' ? envelope.displayMessage() : 'timeout';
        const code = trim(envelope.responseCode).toUpperCase();
        const failure = code === 'NO_RESPONSE' || reason.toLowerCase().includes('timeout')
          ? new Timeout(reason)
          : new ConnectionLost(reason);
        return new Failed(reference, failure);
      }

      const declinedReason = envelope.displayMessage();
      return new Declined(
        reference,
        envelope.responseCode,
        declinedReason !== '' ? declinedReason : 'Declined',
        nextStep,
        json.toJson(),
      );
    }

    const requested = data !== null && data.str('amount') !== ''
      ? data.str('amount')
      : Amount.majorUnits(json.str('requestedAmount'), minorUnitDigits);

    return new Approved(
      reference,
      WireReaders.settledAmountMajor(data, minorUnitDigits, json),
      envelope.responseCode,
      first(data?.str('rrn'), json.str('rrn')),
      first(data?.str('authCode'), json.str('authCode')),
      first(data?.str('cardMask'), data?.str('maskedPan'), json.str('maskedPan')),
      data !== null ? data.flag('isPartialApprove') : json.flag('partialApproval'),
      requested,
      json.toJson(),
    );
  }

  /**
   * Reads an answer to an inquiry. The transaction sits under `data`, or is
   * mirrored at the top level by the Hub; "found" means transaction markers
   * are present, not merely that `data` is an object.
   *
   * `success` reports the transaction's own outcome, so a declined sale the
   * terminal knows all about answers `false`. Reading `success` here would
   * turn it into "not found", and a till told that charges again.
   */
  static toInquiry(json: JsonObject, merchantReference: string, minorUnitDigits: number): EcrInquiry {
    const envelope = EcrWireResponse.parse(json);
    const data = WireReaders.inquiryRecord(envelope.data, json);
    const reference = orElse(data?.str('merchantReference') ?? '', orElse(envelope.merchantReference(), merchantReference));

    if (data === null) {
      const reason = envelope.displayMessage();
      return new NotFound(reference, reason !== '' ? reason : 'Transaction not found', json.toJson());
    }

    return new Found(
      reference,
      new EcrTransaction({
        transactionId: data.str('transactionId'),
        stan: orElse(data.str('stan'), data.str('systemTraceNr')),
        type: orElse(data.str('transactionTypeDisplayName'), data.str('transactionType')),
        status: orElse(data.str('status'), envelope.success ? 'Approved' : 'Declined'),
        // Amount is what was requested; authorizedAmount is what settled.
        amount: orElse(data.str('amount'), WireReaders.settledAmountMajor(data, minorUnitDigits, json)),
        totalAmount: data.str('totalAmount'),
        currency: orElse(data.str('currency'), data.str('currencyId')),
        transactionTime: data.str('transactionTime'),
        maskedPan: orElse(data.str('cardMask'), data.str('cardNumber')),
        cardHolderName: data.str('cardHolderName'),
        rrn: data.str('rrn'),
        authCode: data.str('authCode'),
        batchId: data.str('batchId'),
        terminalId: data.str('terminalId'),
        isRefunded: data.flag('isRefunded'),
        canVoid: data.flag('canVoid'),
        canRefund: data.flag('canRefund'),
        partialApproval: data.flag('isPartialApprove'),
        authorizedAmount: orElse(data.str('authorizeAmount'), data.str('amount')),
      }),
      json.toJson(),
    );
  }

  /** Reads an answer to a receipt request. */
  static toReceipt(json: JsonObject, merchantReference: string): EcrReceipt {
    const envelope = EcrWireResponse.parse(json);
    const reference = orElse(envelope.merchantReference(), merchantReference);
    const url = envelope.data?.str('receiptUrl') ?? '';
    if (url === '') {
      const reason = envelope.displayMessage();
      return new ReceiptUnavailable(reference, reason !== '' ? reason : 'The receipt could not be generated', json.toJson());
    }
    return new ReceiptReady(reference, url, json.toJson());
  }

  /** Reads an answer to close receipt. Success is taken from the envelope only. */
  static toReceiptClosed(json: JsonObject, merchantReference: string): EcrReceiptClosed {
    const envelope = EcrWireResponse.parse(json);
    const reference = orElse(envelope.merchantReference(), merchantReference);
    if (!envelope.success) {
      const reason = envelope.displayMessage();
      return new CloseReceiptRefused(
        reference,
        envelope.responseCode,
        reason !== '' ? reason : 'The terminal refused to close its receipt',
        json.toJson(),
      );
    }
    return new ReceiptClosed(reference, json.toJson());
  }

  /**
   * The amount actually settled, in major units: `authorizeAmount` when it is
   * greater than zero, otherwise `amount`, otherwise the envelope's minor units.
   * Voids often carry `authorizeAmount` as zero while `amount` holds the figure.
   */
  static settledAmountMajor(data: JsonObject | null, minorUnitDigits: number, root: JsonObject): string {
    if (data !== null) {
      if (isPositiveDecimal(data.str('authorizeAmount'))) return data.str('authorizeAmount');
      const amount = data.str('amount');
      if (amount !== '') return amount;
    }
    return Amount.majorUnits(root.str('amount'), minorUnitDigits);
  }

  /** Nested `data` when it names a transaction; otherwise the Hub's top-level fields; otherwise none. */
  private static inquiryRecord(nested: JsonObject | null, json: JsonObject): JsonObject | null {
    if (hasTransactionRecord(nested)) return nested;
    const root = ResponseEnvelope.root(json);
    return hasTransactionRecord(root) ? root : null;
  }
}

const RECORD_MARKERS = [
  'systemTraceNr', 'stan', 'transactionId', 'status', 'rrn', 'authCode', 'amount', 'authorizeAmount',
  'transactionType', 'transactionTypeDisplayName',
];

function hasTransactionRecord(data: JsonObject | null): data is JsonObject {
  return data !== null && RECORD_MARKERS.some((key) => data.str(key) !== '');
}

/** Whether `text` is a decimal number greater than zero, read without a float. */
function isPositiveDecimal(text: string): boolean {
  const m = /^\s*([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE][+-]?[0-9]+)?\s*$/.exec(text);
  if (m === null) return false;
  const mantissa = (m[2] ?? '') + (m[3] ?? '');
  if (mantissa === '') return false;
  return m[1] !== '-' && trim(mantissa, '0') !== '';
}

function orElse(value: string, fallback: string): string {
  return value !== '' ? value : fallback;
}

function first(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return '';
}
