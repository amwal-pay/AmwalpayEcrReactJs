import { EcrTransactionType } from '@amwalpay/ecr-js';
import { AmountEntry } from './AmountEntry.js';
import { TransactionRequest } from './TransactionRequest.js';

/**
 * What the operator has entered, and what is wrong with it. Which fields apply
 * is decided by the transaction type, so showing a field and requiring it
 * cannot disagree. Same rules and messages as the Windows samples' Core.
 */
export class TransactionFormState {
  static MERCHANT_REFERENCE_MAX_LENGTH = 32;
  static RECEIPT_NUMBER_MAX_LENGTH = 6;

  /**
   * @param {object} fields
   * @param {string} [fields.amountDigits] Raw keyed digits (mills); the field renders them as 0.000.
   * @param {Date|null} [fields.originalDate] Date of the original transaction, defaulting to today.
   */
  constructor({
    type = EcrTransactionType.Sale,
    amountDigits = '',
    receiptNumber = '',
    originalTerminalId = '',
    originalDate = null,
    useOtherTerminal = false,
    lookUpByReference = false,
    originalReference = '',
    merchantReference = '',
  } = {}) {
    Object.assign(this, {
      type, amountDigits, receiptNumber, originalTerminalId, originalDate, useOtherTerminal, lookUpByReference, originalReference, merchantReference,
    });
    Object.freeze(this);
  }

  showOtherTerminalSwitch() {
    return this.type.allowsOtherTerminal();
  }

  showOriginalTerminal() {
    return this.type.allowsOtherTerminal() && this.useOtherTerminal;
  }

  /** Only an inquiry may look up by reference. */
  showReferenceSwitch() {
    return this.type === EcrTransactionType.Inquiry;
  }

  /** Optional till reference for a new sale. */
  showMerchantReference() {
    return this.type === EcrTransactionType.Sale;
  }

  looksUpByReference() {
    return this.showReferenceSwitch() && this.lookUpByReference;
  }

  /** The receipt number field gives way to the reference field. */
  showReceiptNumber() {
    return this.type.requiresOriginalStan() && !this.looksUpByReference();
  }

  /** A reference is unique in its own right; the date is not needed to disambiguate it. */
  showOriginalDate() {
    return this.type.requiresOriginalDate() && !this.looksUpByReference();
  }

  /**
   * Validates, and returns either the request to send or the per-field errors
   * keyed like the form (`amount`, `receiptNumber`, `originalTerminalId`,
   * `originalReference`, `merchantReference`).
   *
   * @returns {[TransactionRequest|null, Record<string,string>]}
   */
  validated(terminalSerial) {
    const mills = AmountEntry.mills(this.amountDigits);
    const errors = {};
    if (this.type.requiresAmount()) {
      if (mills === 0) errors.amount = 'Required field';
      else if (mills < AmountEntry.MIN_MILLS) errors.amount = 'minimum amount allowed is ' + AmountEntry.formatMills(AmountEntry.MIN_MILLS);
      else if (mills > AmountEntry.MAX_MILLS) errors.amount = 'maximum amount allowed is ' + AmountEntry.formatMills(AmountEntry.MAX_MILLS);
    }
    if (this.showReceiptNumber() && this.receiptNumber.trim() === '') {
      errors.receiptNumber = 'Enter the receipt number of the transaction to act on';
    }
    if (this.showOriginalTerminal() && this.originalTerminalId.trim() === '') {
      errors.originalTerminalId = 'Enter the terminal the original was taken on';
    }
    if (this.looksUpByReference() && this.originalReference.trim() === '') {
      errors.originalReference = 'Enter the reference the transaction was sent with';
    }
    if (this.showMerchantReference()) {
      const error = TransactionFormState.merchantReferenceError(this.merchantReference);
      if (error !== null) errors.merchantReference = error;
    }
    if (Object.keys(errors).length !== 0) return [null, errors];

    const date = this.originalDate ?? startOfToday();
    return [new TransactionRequest({
      type: this.type,
      terminalSerial,
      amount: this.type.requiresAmount() ? AmountEntry.format(this.amountDigits) : null,
      receiptNumber: this.looksUpByReference() ? '' : this.receiptNumber,
      originalTerminalId: this.showOriginalTerminal() ? this.originalTerminalId : '',
      transactionDate: this.showOriginalDate() ? yyyymmdd(date) : '',
      // By reference: originalMerchantReference is what to look up; this
      // inquiry's own reference stays blank so the SDK mints one.
      originalReference: this.looksUpByReference() ? this.originalReference.trim() : '',
      merchantReference: this.looksUpByReference() ? '' : (this.showMerchantReference() ? this.merchantReference.trim() : ''),
    }), {}];
  }

  /** The same rule the SDK enforces, so the operator hears it before sending. */
  static merchantReferenceError(value) {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (Buffer.byteLength(trimmed, 'utf8') > TransactionFormState.MERCHANT_REFERENCE_MAX_LENGTH) {
      return `A merchant reference is at most ${TransactionFormState.MERCHANT_REFERENCE_MAX_LENGTH} characters`;
    }
    if (!/^[\x21-\x7E]+$/.test(trimmed) || /[&=]/.test(trimmed)) return "Use printable ASCII without spaces, '&' or '='";
    return null;
  }
}

export function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function yyyymmdd(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

export function isoDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
