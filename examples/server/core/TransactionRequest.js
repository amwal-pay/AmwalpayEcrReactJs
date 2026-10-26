import { EcrTransactionType } from '@amwalpay/ecr-js';

/** One operation, as the screen asks for it. */
export class TransactionRequest {
  /**
   * @param {object} fields
   * @param {EcrTransactionType} fields.type
   * @param {string} fields.terminalSerial
   * @param {string|null} [fields.amount] Major units as exact decimal text (e.g. "1.234"); null when the type takes none.
   * @param {string} [fields.transactionDate] `yyyyMMdd`, for operations that look an original up by date.
   * @param {string} [fields.originalReference] Look the original up by the reference it was sent with.
   * @param {string} [fields.merchantReference] This attempt's own reference. Blank: the registry makes one.
   */
  constructor({
    type,
    terminalSerial,
    amount = null,
    receiptNumber = '',
    originalTerminalId = '',
    transactionDate = '',
    originalReference = '',
    merchantReference = '',
  }) {
    this.type = type;
    this.terminalSerial = terminalSerial;
    this.amount = amount;
    this.receiptNumber = receiptNumber;
    this.originalTerminalId = originalTerminalId;
    this.transactionDate = transactionDate;
    this.originalReference = originalReference;
    this.merchantReference = merchantReference;
    Object.freeze(this);
  }

  looksUpByReference() {
    return this.originalReference.trim() !== '';
  }

  withMerchantReference(reference) {
    return new TransactionRequest({ ...this.toJSON(), type: this.type, merchantReference: reference });
  }

  /** The follow-up after an unknown outcome: an inquiry by the reference it was sent with. */
  static inquiryByReference(terminalSerial, reference) {
    // Blank own reference, so the SDK mints this inquiry's merchantReference:
    // copying the sale's here would put one value in both wire fields.
    return new TransactionRequest({ type: EcrTransactionType.Inquiry, terminalSerial, originalReference: reference });
  }

  toJSON() {
    return {
      type: this.type.value,
      terminalSerial: this.terminalSerial,
      amount: this.amount,
      receiptNumber: this.receiptNumber,
      originalTerminalId: this.originalTerminalId,
      transactionDate: this.transactionDate,
      originalReference: this.originalReference,
      merchantReference: this.merchantReference,
    };
  }

  static fromJSON(data) {
    const type = EcrTransactionType.tryFrom(String(data?.type ?? ''));
    if (type === null) throw new Error('Unknown transaction type in a stored run');
    const text = (key) => (typeof data[key] === 'string' ? data[key] : '');
    return new TransactionRequest({
      type,
      terminalSerial: text('terminalSerial'),
      amount: typeof data.amount === 'string' ? data.amount : null,
      receiptNumber: text('receiptNumber'),
      originalTerminalId: text('originalTerminalId'),
      transactionDate: text('transactionDate'),
      originalReference: text('originalReference'),
      merchantReference: text('merchantReference'),
    });
  }
}
