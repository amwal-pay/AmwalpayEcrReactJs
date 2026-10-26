import type { Failure } from '../failure/Failure.js';
import type { EcrTransaction, EcrTransactionFields } from './EcrTransaction.js';
import { NextStep } from './NextStep.js';

// ── Inquiry ─────────────────────────────────────────────────────────

/**
 * The answer to "what became of this transaction": {@link Found},
 * {@link NotFound} or {@link InquiryFailed}.
 *
 * Kept apart from {@link EcrResult} because it reports on a transaction rather
 * than performing one: an inquiry that succeeds says nothing about whether money
 * moved. That is {@link EcrTransaction.status}.
 */
export abstract class EcrInquiry {
  /** @param merchantReference The reference the inquiry was sent with, or the answer's own. */
  constructor(readonly merchantReference: string) {}

  /** `found`, `not_found` or `failed`. */
  abstract outcome(): 'found' | 'not_found' | 'failed';

  abstract toJSON(): Record<string, unknown>;
}

/** The transaction was found. {@link EcrTransaction.status} says what became of it. */
export class Found extends EcrInquiry {
  constructor(
    merchantReference: string,
    readonly transaction: EcrTransaction,
    readonly raw: string,
  ) {
    super(merchantReference);
  }

  outcome(): 'found' {
    return 'found';
  }

  toJSON(): { outcome: 'found'; merchantReference: string; transaction: Required<EcrTransactionFields> } {
    return { outcome: 'found', merchantReference: this.merchantReference, transaction: this.transaction.toJSON() };
  }
}

/**
 * This lookup returned no record.
 *
 * After a lost answer that is not proof nothing was charged: the same answer
 * follows a terminal reset or a record that has aged out. Confirm on the
 * terminal, or with Amwal, before taking payment again.
 */
export class NotFound extends EcrInquiry {
  constructor(
    merchantReference: string,
    readonly reason: string,
    readonly raw: string,
  ) {
    super(merchantReference);
  }

  outcome(): 'not_found' {
    return 'not_found';
  }

  toJSON(): { outcome: 'not_found'; merchantReference: string; reason: string } {
    return { outcome: 'not_found', merchantReference: this.merchantReference, reason: this.reason };
  }
}

/** The lookup itself failed, so nothing was learned. Harmless to repeat: an inquiry moves no money. */
export class InquiryFailed extends EcrInquiry {
  constructor(merchantReference: string, readonly failure: Failure) {
    super(merchantReference);
  }

  outcome(): 'failed' {
    return 'failed';
  }

  toJSON(): { outcome: 'failed'; merchantReference: string; failure: ReturnType<Failure['toJSON']> } {
    return { outcome: 'failed', merchantReference: this.merchantReference, failure: this.failure.toJSON() };
  }
}

// ── Sale, void, refund ──────────────────────────────────────────────

/**
 * How a sale, void or refund ended.
 *
 * The three outcomes call for different things from a till: {@link Approved}
 * means money moved, {@link Declined} means the terminal answered and refused,
 * and {@link Failed} means the exchange itself failed, which may still have
 * taken the customer's money and must never be treated as a refusal.
 *
 * ```ts
 * if (result instanceof Approved) record(result);
 * else if (result instanceof Declined) show(result.reason);
 * else if (result.settled()) apply(result.recovered.transaction);
 * else if (result.failure.outcomeUnknown()) markUnresolved(result.merchantReference);
 * else show(result.failure.message);
 * ```
 */
export abstract class EcrResult {
  /**
   * @param merchantReference The reference the transaction was sent with: the caller's own, or
   *        the one the SDK generated. It names this transaction to the terminal afterwards.
   */
  constructor(readonly merchantReference: string) {}

  isApproved(): this is Approved {
    return this instanceof Approved;
  }

  isDeclined(): this is Declined {
    return this instanceof Declined;
  }

  isFailed(): this is Failed {
    return this instanceof Failed;
  }

  /** `approved`, `declined` or `failed`. */
  abstract outcome(): 'approved' | 'declined' | 'failed';

  abstract toJSON(): Record<string, unknown>;
}

/** Money moved. */
export class Approved extends EcrResult {
  /**
   * @param amount What was actually taken or returned, in major units, e.g. `1.234`.
   * @param responseCode The backend's code, `00` on a plain approval.
   * @param maskedPan Masked, never the full number: `543173xxxx5785`. May be empty.
   * @param partialApproval The issuer authorised less than was asked: collect the difference
   *        by other means before handing over the goods. Not a refusal.
   * @param requestedAmount What was asked for, when partially approved.
   * @param raw The terminal's full answer as JSON text, for anything not surfaced here.
   */
  constructor(
    merchantReference: string,
    readonly amount: string,
    readonly responseCode: string,
    readonly rrn: string,
    readonly authCode: string,
    readonly maskedPan: string,
    readonly partialApproval: boolean,
    readonly requestedAmount: string,
    readonly raw: string,
  ) {
    super(merchantReference);
  }

  outcome(): 'approved' {
    return 'approved';
  }

  toJSON(): Record<string, unknown> {
    return {
      outcome: 'approved',
      merchantReference: this.merchantReference,
      amount: this.amount,
      responseCode: this.responseCode,
      rrn: this.rrn,
      authCode: this.authCode,
      maskedPan: this.maskedPan,
      partialApproval: this.partialApproval,
      requestedAmount: this.requestedAmount,
    };
  }
}

/**
 * The terminal answered and refused. No money moved.
 *
 * An answer that says the outcome is unknown (`nextStep`
 * `INQUIRE_BY_MERCHANT_REFERENCE`) never arrives as a decline: it is a
 * {@link Failed}. So {@link nextStep} is always {@link NextStep.None}; it is kept
 * for parity with the Windows SDK.
 */
export class Declined extends EcrResult {
  /** @param reason The text to show: the backend's error list in preference to its message. */
  constructor(
    merchantReference: string,
    readonly responseCode: string,
    readonly reason: string,
    readonly nextStep: NextStep,
    readonly raw: string,
  ) {
    super(merchantReference);
  }

  outcome(): 'declined' {
    return 'declined';
  }

  toJSON(): Record<string, unknown> {
    return {
      outcome: 'declined',
      merchantReference: this.merchantReference,
      responseCode: this.responseCode,
      reason: this.reason,
      nextStep: this.nextStep.value,
    };
  }
}

/**
 * The exchange itself failed.
 *
 * When {@link Failure.outcomeUnknown} is true the payment may have completed.
 * Read {@link recovered} first (Wi-Fi asks the terminal once by itself), then
 * inquire by {@link merchantReference}. Never resend.
 */
export class Failed extends EcrResult {
  /**
   * @param recovered What the terminal said when asked afterwards, or null when it was
   *        not asked. {@link Found} settles it; anything else leaves it unknown. Always null on Web Service.
   */
  constructor(
    merchantReference: string,
    readonly failure: Failure,
    readonly recovered: EcrInquiry | null = null,
  ) {
    super(merchantReference);
  }

  /** Always {@link NextStep.InquireByMerchantReference}: nothing here says the transaction did not happen. */
  nextStep(): NextStep {
    return NextStep.InquireByMerchantReference;
  }

  /** Whether the follow-up inquiry found the transaction, so the outcome is no longer unknown. */
  settled(): this is Failed & { recovered: Found } {
    return this.recovered instanceof Found;
  }

  withRecovered(recovered: EcrInquiry | null): Failed {
    return new Failed(this.merchantReference, this.failure, recovered);
  }

  outcome(): 'failed' {
    return 'failed';
  }

  toJSON(): Record<string, unknown> {
    return {
      outcome: 'failed',
      merchantReference: this.merchantReference,
      failure: this.failure.toJSON(),
      nextStep: this.nextStep().value,
      settled: this.settled(),
      recovered: this.recovered?.toJSON() ?? null,
    };
  }
}

// ── E-receipt ───────────────────────────────────────────────────────

/**
 * A transaction's e-receipt: {@link ReceiptReady}, {@link ReceiptUnavailable} or
 * {@link ReceiptFailed}. The URL is shown as a QR code, so a till with no printer
 * can still hand one over. Wi-Fi only.
 */
export abstract class EcrReceipt {
  constructor(readonly merchantReference: string) {}

  /** `ready`, `unavailable` or `failed`. */
  abstract outcome(): 'ready' | 'unavailable' | 'failed';

  abstract toJSON(): Record<string, unknown>;
}

/** The receipt is published. Put {@link url} in a QR code as it stands. */
export class ReceiptReady extends EcrReceipt {
  constructor(merchantReference: string, readonly url: string, readonly raw: string) {
    super(merchantReference);
  }

  outcome(): 'ready' {
    return 'ready';
  }

  toJSON(): Record<string, unknown> {
    return { outcome: 'ready', merchantReference: this.merchantReference, url: this.url };
  }
}

/** No receipt to show: not found, not published, or not offered on this transport. Asking again is safe. */
export class ReceiptUnavailable extends EcrReceipt {
  constructor(merchantReference: string, readonly reason: string, readonly raw: string) {
    super(merchantReference);
  }

  outcome(): 'unavailable' {
    return 'unavailable';
  }

  toJSON(): Record<string, unknown> {
    return { outcome: 'unavailable', merchantReference: this.merchantReference, reason: this.reason };
  }
}

/** The exchange failed. Nothing changed; the call can be repeated. */
export class ReceiptFailed extends EcrReceipt {
  constructor(merchantReference: string, readonly failure: Failure) {
    super(merchantReference);
  }

  outcome(): 'failed' {
    return 'failed';
  }

  toJSON(): Record<string, unknown> {
    return { outcome: 'failed', merchantReference: this.merchantReference, failure: this.failure.toJSON() };
  }
}

// ── Close receipt ───────────────────────────────────────────────────

/**
 * The answer to a request to put the terminal's receipt away:
 * {@link ReceiptClosed}, {@link CloseReceiptRefused} or {@link CloseReceiptFailed}.
 * Success means the terminal is idle again, whether it had a receipt up or not.
 * Safe to repeat.
 */
export abstract class EcrReceiptClosed {
  constructor(readonly merchantReference: string) {}

  /** `idle`, `refused` or `failed`. */
  abstract outcome(): 'idle' | 'refused' | 'failed';

  abstract toJSON(): Record<string, unknown>;
}

/** The terminal is on its idle screen. (`EcrReceiptClosed.Idle` in the Windows SDK.) */
export class ReceiptClosed extends EcrReceiptClosed {
  constructor(merchantReference: string, readonly raw: string) {
    super(merchantReference);
  }

  outcome(): 'idle' {
    return 'idle';
  }

  toJSON(): Record<string, unknown> {
    return { outcome: 'idle', merchantReference: this.merchantReference };
  }
}

/**
 * The terminal answered and refused, e.g. firmware too old for `CLOSE_RECEIPT`.
 * Treat it as "cannot be asked" and carry on; the receipt stays up.
 */
export class CloseReceiptRefused extends EcrReceiptClosed {
  constructor(
    merchantReference: string,
    readonly responseCode: string,
    readonly reason: string,
    readonly raw: string,
  ) {
    super(merchantReference);
  }

  outcome(): 'refused' {
    return 'refused';
  }

  toJSON(): Record<string, unknown> {
    return { outcome: 'refused', merchantReference: this.merchantReference, responseCode: this.responseCode, reason: this.reason };
  }
}

/** The exchange failed. Nothing changed; the call can be repeated. */
export class CloseReceiptFailed extends EcrReceiptClosed {
  constructor(merchantReference: string, readonly failure: Failure) {
    super(merchantReference);
  }

  outcome(): 'failed' {
    return 'failed';
  }

  toJSON(): Record<string, unknown> {
    return { outcome: 'failed', merchantReference: this.merchantReference, failure: this.failure.toJSON() };
  }
}
