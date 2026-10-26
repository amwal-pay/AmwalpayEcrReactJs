/**
 * What the till should do about an outcome it cannot act on directly.
 *
 * Stated rather than left for the till to infer from a response code, because
 * the wrong inference is expensive: reading an unknown outcome as a refusal and
 * sending the sale again charges the cardholder twice.
 */
export class NextStep {
  /** The answer settles the matter. */
  static readonly None = new NextStep('NONE');

  /** Ask what became of the transaction, quoting the reference it was sent with. Never retry instead. */
  static readonly InquireByMerchantReference = new NextStep('INQUIRE_BY_MERCHANT_REFERENCE');

  private constructor(readonly value: 'NONE' | 'INQUIRE_BY_MERCHANT_REFERENCE') {}

  /** Reads the wire value. Unknown values read as None: a till must not act on a step it does not understand. */
  static fromWire(value: string): NextStep {
    return value === NextStep.InquireByMerchantReference.value ? NextStep.InquireByMerchantReference : NextStep.None;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}
