type TypeValue = 'Sale' | 'Void' | 'Refund' | 'Inquiry' | 'Receipt' | 'CloseReceipt';

/**
 * Operations a terminal can be asked to run.
 *
 * Each type declares what the caller has to supply, so a till's own form can be
 * driven from these flags rather than repeating the rules. What the terminal
 * will accept (whether the original exists, whether it is still voidable) is
 * answered by the terminal.
 *
 * Manual settlement is not offered: it waits on the POS-599 contract.
 */
export class EcrTransactionType {
  /** An ordinary purchase. */
  static readonly Sale = new EcrTransactionType('Sale');

  /** Cancels an earlier transaction for its full amount. No card is presented. */
  static readonly Void = new EcrTransactionType('Void');

  /** Returns money against an earlier transaction, in full or in part. The cardholder presents the card. */
  static readonly Refund = new EcrTransactionType('Refund');

  /** Asks what became of an earlier transaction. Reads only, safe to repeat. */
  static readonly Inquiry = new EcrTransactionType('Inquiry');

  /** Asks for an earlier transaction's e-receipt URL. Wi-Fi only. */
  static readonly Receipt = new EcrTransactionType('Receipt');

  /** Asks the terminal to put its receipt away and return to idle. */
  static readonly CloseReceipt = new EcrTransactionType('CloseReceipt');

  private constructor(readonly value: TypeValue) {}

  static cases(): EcrTransactionType[] {
    const t = EcrTransactionType;
    return [t.Sale, t.Void, t.Refund, t.Inquiry, t.Receipt, t.CloseReceipt];
  }

  /** The type with exactly this value, or null. */
  static tryFrom(value: string): EcrTransactionType | null {
    return EcrTransactionType.cases().find((t) => t.value === value) ?? null;
  }

  /**
   * The operations an operator picks from, in the order a till usually
   * offers them. Receipt and CloseReceipt are absent by design.
   */
  static menuOptions(): EcrTransactionType[] {
    const t = EcrTransactionType;
    return [t.Sale, t.Void, t.Refund, t.Inquiry];
  }

  /** The value carried in the message's `messageType` field. */
  messageType(): string {
    switch (this.value) {
      case 'Sale': return 'SALE';
      case 'Void': return 'VOID';
      case 'Refund': return 'REFUND';
      case 'Inquiry': return 'INQUIRY';
      case 'Receipt': return 'RECEIPT';
      case 'CloseReceipt': return 'CLOSE_RECEIPT';
    }
  }

  displayName(): string {
    return this.value === 'CloseReceipt' ? 'Close receipt' : this.value;
  }

  /** Whether the caller supplies an amount. A void takes the original's amount, which only the terminal knows. */
  requiresAmount(): boolean {
    return this === EcrTransactionType.Sale || this === EcrTransactionType.Refund;
  }

  /** Whether the caller names an earlier transaction by its receipt number (STAN). */
  requiresOriginalStan(): boolean {
    const t = EcrTransactionType;
    return this === t.Void || this === t.Refund || this === t.Inquiry || this === t.Receipt;
  }

  /**
   * Whether the operation carries the original's date: a receipt number is unique only within a
   * terminal's day. Required for a refund; optional (sent when given) for an inquiry or a receipt.
   */
  requiresOriginalDate(): boolean {
    const t = EcrTransactionType;
    return this === t.Refund || this === t.Inquiry || this === t.Receipt;
  }

  /** Whether the operation moves money. */
  movesMoney(): boolean {
    const t = EcrTransactionType;
    return this === t.Sale || this === t.Void || this === t.Refund;
  }

  /** Whether the caller may name a different terminal the original was taken on (Wi-Fi only). */
  allowsOtherTerminal(): boolean {
    return this.requiresOriginalStan();
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}
