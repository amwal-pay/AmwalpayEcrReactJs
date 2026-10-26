import type { Amount } from './Amount.js';
import type { EcrReachability } from './EcrReachability.js';
import type { EcrSessionPlan } from './EcrSessionPlan.js';
import type { EcrTerminal, OriginalOptions } from './EcrTerminal.js';
import type { EcrWebServiceTerminal } from './EcrWebServiceTerminal.js';
import { InvalidArgumentException, LogicException } from './exception/errors.js';
import { Malformed } from './failure/Failure.js';
import { trim } from './internal/text.js';
import { Validate } from './internal/Validate.js';
import {
  CloseReceiptFailed,
  type EcrInquiry,
  type EcrReceipt,
  type EcrReceiptClosed,
  type EcrResult,
  ReceiptUnavailable,
} from './result/results.js';
import type { FinancialGuard } from './safety/FinancialGuard.js';
import type { JournalEntry } from './safety/JournalEntry.js';

type Money = string | number | bigint | Amount;

/**
 * One opened transport for a validated plan: every sale, void, refund,
 * inquiry, e-receipt and close receipt for that terminal goes through it, the
 * same way over Wi-Fi and Web Service.
 *
 * Open it with {@link EcrSessions.open}.
 */
export class EcrOpenedSession {
  /** @internal Use {@link EcrSessions.open}. */
  constructor(
    readonly plan: EcrSessionPlan,
    private readonly local: EcrTerminal | null,
    private readonly web: EcrWebServiceTerminal | null,
  ) {
    if ((local === null) === (web === null)) throw new InvalidArgumentException('A session has exactly one transport');
  }

  usesWebService(): boolean {
    return this.web !== null;
  }

  usesLocalTerminal(): boolean {
    return this.local !== null;
  }

  /** Receipt URLs exist only on Wi-Fi. */
  supportsReceipt(): boolean {
    return this.local !== null;
  }

  /** The Wi-Fi terminal behind this session, or null on Web Service. */
  lanTerminal(): EcrTerminal | null {
    return this.local;
  }

  /** The Web Service terminal behind this session, or null on Wi-Fi. */
  webServiceTerminal(): EcrWebServiceTerminal | null {
    return this.web;
  }

  /**
   * Whether the Wi-Fi port answers, before a sale. Null on Web Service: the
   * Hub has no probe.
   */
  async probeReachability(): Promise<EcrReachability | null> {
    return this.local !== null ? this.local.probeReachability() : null;
  }

  /**
   * @param amount Major units, e.g. "1.234".
   * @param merchantReference This attempt's own reference. Save it before calling.
   */
  sale(amount: Money, merchantReference = ''): Promise<EcrResult> {
    return this.local !== null
      ? this.local.sale(amount, merchantReference)
      : this.webTerminal().sale(amount, merchantReference);
  }

  /** `originalTerminalId` is Wi-Fi only; Web Service uses the terminal in the plan. */
  void(receiptNumber: string, options: OriginalOptions = {}): Promise<EcrResult> {
    return this.local !== null
      ? this.local.void(receiptNumber, options)
      : this.webTerminal().void(receiptNumber, options.merchantReference ?? '');
  }

  /** @param transactionDate The original's day as `yyyyMMdd`. */
  refund(amount: Money, receiptNumber: string, transactionDate: string, options: OriginalOptions = {}): Promise<EcrResult> {
    return this.local !== null
      ? this.local.refund(amount, receiptNumber, transactionDate, options)
      : this.webTerminal().refund(amount, receiptNumber, transactionDate, options.merchantReference ?? '');
  }

  inquire(receiptNumber: string, transactionDate: string, options: Pick<OriginalOptions, 'originalTerminalId'> = {}): Promise<EcrInquiry> {
    return this.local !== null
      ? this.local.inquire(receiptNumber, transactionDate, { originalTerminalId: options.originalTerminalId ?? '' })
      : this.webTerminal().inquire(receiptNumber, transactionDate);
  }

  /**
   * Reads the attempt you sent as `originalReference`: the answer to a sale,
   * void or refund that never answered.
   */
  inquireByReference(originalReference: string, options: OriginalOptions & { transactionDate?: string } = {}): Promise<EcrInquiry> {
    return this.local !== null
      ? this.local.inquireByReference(originalReference, options)
      : this.webTerminal().inquireByReference(originalReference, options.transactionDate ?? '', options.merchantReference ?? '');
  }

  /** Wi-Fi only. On Web Service it answers {@link ReceiptUnavailable}. */
  async receipt(receiptNumber: string, transactionDate: string, options: Pick<OriginalOptions, 'originalTerminalId'> = {}): Promise<EcrReceipt> {
    if (this.local === null) return new ReceiptUnavailable('', 'Receipt fetch is only supported over Wi‑Fi and USB cable ECR', '');
    return this.local.receipt(receiptNumber, transactionDate, { originalTerminalId: options.originalTerminalId ?? '' });
  }

  /**
   * Asks the terminal to put its receipt away and go back to idle. Call it
   * from the till's Close receipt action, never automatically.
   *
   * On Web Service, when only `merchantReference` is given it is taken as the
   * original, and the SDK generates this request's own id.
   *
   * @param options.merchantReference This close request's own id. Blank: generated.
   * @param options.originalMerchantReference Web Service requires it: the sale, void or refund being
   *        dismissed. Wi-Fi ignores it.
   */
  async closeReceipt(options: { merchantReference?: string; originalMerchantReference?: string } = {}): Promise<EcrReceiptClosed> {
    const merchantReference = options.merchantReference ?? '';
    const originalMerchantReference = options.originalMerchantReference ?? '';
    if (this.local !== null) return this.local.closeReceipt(merchantReference);
    const original = Validate.isBlank(originalMerchantReference) ? merchantReference : originalMerchantReference;
    if (Validate.isBlank(original)) {
      return new CloseReceiptFailed(merchantReference, new Malformed('Web Service close receipt needs the original merchant reference'));
    }
    // Only one reference passed: it is the original; the SDK mints this request's id.
    const closeReference = Validate.isBlank(originalMerchantReference) ? '' : merchantReference;
    return this.webTerminal().closeReceipt(original, closeReference);
  }

  /** Identifies this terminal to the guard's lock and journal. */
  terminalKey(): string {
    return this.local?.terminalKey() ?? this.webTerminal().terminalKey();
  }

  guard(): FinancialGuard {
    return this.local?.guard() ?? this.webTerminal().guard();
  }

  /**
   * Sales, voids and refunds on this terminal whose outcome is still unknown.
   * While any is listed, a new one answers {@link Unresolved}.
   */
  pendingOutcomes(): Promise<JournalEntry[]> {
    return this.guard().unresolved(this.terminalKey());
  }

  /**
   * Inquires by reference for every unknown outcome on this terminal, and lets
   * the answers settle what they can. Run it at start-up and after a failure.
   * Safe to repeat: an inquiry moves no money.
   *
   * @returns keyed by the original merchant reference
   */
  async reconcile(): Promise<Map<string, EcrInquiry>> {
    const results = new Map<string, EcrInquiry>();
    for (const entry of await this.pendingOutcomes()) {
      results.set(entry.reference, await this.inquireByReference(entry.reference));
    }
    return results;
  }

  /**
   * Settles an unknown outcome by hand, once it was confirmed on the terminal
   * or with Amwal: for example an inquiry that keeps answering "not found".
   *
   * @param note How it was confirmed, for the record.
   */
  markResolved(merchantReference: string, note: string): Promise<JournalEntry> {
    return this.guard().markResolved(this.terminalKey(), trim(merchantReference), note);
  }

  private webTerminal(): EcrWebServiceTerminal {
    if (this.web === null) throw new LogicException('Session has no transport');
    return this.web;
  }
}
