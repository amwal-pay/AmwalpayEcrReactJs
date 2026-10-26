import { EcrTransactionType } from '../EcrTransactionType.js';

/** Web Service ECR operations, one REST endpoint each on the Hub. */
export class WebServiceOperation {
  static readonly Sale = new WebServiceOperation('/Ecr/Sale', 'Sale');
  static readonly Void = new WebServiceOperation('/Ecr/Void', 'Void');
  static readonly Refund = new WebServiceOperation('/Ecr/Refund', 'Refund');
  static readonly TransactionStatus = new WebServiceOperation('/Ecr/Inquiry', 'Transaction status');
  static readonly CloseReceipt = new WebServiceOperation('/Ecr/closeReceipt', 'Close receipt');

  private constructor(readonly value: string, private readonly labelText: string) {}

  static cases(): WebServiceOperation[] {
    const o = WebServiceOperation;
    return [o.Sale, o.Void, o.Refund, o.TransactionStatus, o.CloseReceipt];
  }

  path(): string {
    return this.value;
  }

  label(): string {
    return this.labelText;
  }

  /** The REST operation for a transaction type, or null when it has none (receipts). */
  static forType(type: EcrTransactionType): WebServiceOperation | null {
    switch (type) {
      case EcrTransactionType.Sale: return WebServiceOperation.Sale;
      case EcrTransactionType.Void: return WebServiceOperation.Void;
      case EcrTransactionType.Refund: return WebServiceOperation.Refund;
      case EcrTransactionType.Inquiry: return WebServiceOperation.TransactionStatus;
      case EcrTransactionType.CloseReceipt: return WebServiceOperation.CloseReceipt;
      default: return null;
    }
  }

  toString(): string {
    return this.value;
  }
}
