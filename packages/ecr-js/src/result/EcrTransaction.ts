import { trim } from '../internal/text.js';

/** The fields of an {@link EcrTransaction}. */
export interface EcrTransactionFields {
  /** The backend's identifier, unique across terminals and days. */
  transactionId: string;
  /** The receipt number, unique only within one terminal's day. */
  stan: string;
  /** `Purchase`, `Void`, `Refund`: as the backend names it. */
  type: string;
  /** What became of it: `Approved`, `Declined`, `Voided`... Compare ignoring case. */
  status: string;
  /** In major units. What was requested. */
  amount: string;
  /** Including tips and fees, where there were any. */
  totalAmount: string;
  currency: string;
  /** As recorded, e.g. `2026-08-09T12:41:07`. */
  transactionTime: string;
  /** Masked, never the full number. May be empty. */
  maskedPan: string;
  cardHolderName: string;
  rrn: string;
  authCode: string;
  batchId: string;
  terminalId: string;
  isRefunded: boolean;
  /** Whether the terminal would accept a void for it now. */
  canVoid: boolean;
  /** Whether the terminal would accept a refund against it. */
  canRefund: boolean;
  /** The issuer approved less than asked: {@link authorizedAmount} is what was charged. */
  partialApproval?: boolean;
  /** What was actually authorised. Equal to the amount unless partially approved. */
  authorizedAmount?: string;
}

/** A transaction as the terminal's backend records it. */
export class EcrTransaction implements Required<EcrTransactionFields> {
  readonly transactionId: string;
  readonly stan: string;
  readonly type: string;
  readonly status: string;
  readonly amount: string;
  readonly totalAmount: string;
  readonly currency: string;
  readonly transactionTime: string;
  readonly maskedPan: string;
  readonly cardHolderName: string;
  readonly rrn: string;
  readonly authCode: string;
  readonly batchId: string;
  readonly terminalId: string;
  readonly isRefunded: boolean;
  readonly canVoid: boolean;
  readonly canRefund: boolean;
  readonly partialApproval: boolean;
  readonly authorizedAmount: string;

  constructor(fields: EcrTransactionFields) {
    this.transactionId = fields.transactionId;
    this.stan = fields.stan;
    this.type = fields.type;
    this.status = fields.status;
    this.amount = fields.amount;
    this.totalAmount = fields.totalAmount;
    this.currency = fields.currency;
    this.transactionTime = fields.transactionTime;
    this.maskedPan = fields.maskedPan;
    this.cardHolderName = fields.cardHolderName;
    this.rrn = fields.rrn;
    this.authCode = fields.authCode;
    this.batchId = fields.batchId;
    this.terminalId = fields.terminalId;
    this.isRefunded = fields.isRefunded;
    this.canVoid = fields.canVoid;
    this.canRefund = fields.canRefund;
    this.partialApproval = fields.partialApproval ?? false;
    this.authorizedAmount = fields.authorizedAmount ?? '';
  }

  /** Whether {@link status} reads `Approved`, ignoring case. */
  isApproved(): boolean {
    return trim(this.status).toLowerCase() === 'approved';
  }

  /** Whether {@link status} reads `Declined`, ignoring case. */
  isDeclined(): boolean {
    return trim(this.status).toLowerCase() === 'declined';
  }

  /** The day of {@link transactionTime} as `yyyyMMdd`, or "" when it has none. */
  day(): string {
    const digits = this.transactionTime.replace(/[^0-9]/g, '');
    return digits.length >= 8 ? digits.slice(0, 8) : '';
  }

  toJSON(): Required<EcrTransactionFields> {
    return {
      transactionId: this.transactionId,
      stan: this.stan,
      type: this.type,
      status: this.status,
      amount: this.amount,
      totalAmount: this.totalAmount,
      currency: this.currency,
      transactionTime: this.transactionTime,
      maskedPan: this.maskedPan,
      cardHolderName: this.cardHolderName,
      rrn: this.rrn,
      authCode: this.authCode,
      batchId: this.batchId,
      terminalId: this.terminalId,
      isRefunded: this.isRefunded,
      canVoid: this.canVoid,
      canRefund: this.canRefund,
      partialApproval: this.partialApproval,
      authorizedAmount: this.authorizedAmount,
    };
  }
}
