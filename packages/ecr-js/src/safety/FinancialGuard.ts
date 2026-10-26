import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EcrConfig } from '../EcrConfig.js';
import type { EcrTransactionType } from '../EcrTransactionType.js';
import { InvalidArgumentException, LogicException } from '../exception/errors.js';
import { DuplicateMerchantReferenceException } from '../exception/DuplicateMerchantReferenceException.js';
import { Busy, Unresolved } from '../failure/Failure.js';
import { trim } from '../internal/text.js';
import type { EcrLogger } from '../log/EcrLogger.js';
import { Approved, Declined, type EcrInquiry, type EcrResult, Failed, Found, NotFound } from '../result/results.js';
import type { TerminalLock, TransactionJournal } from './contracts.js';
import { FileTerminalLock } from './FileTerminalLock.js';
import { FileTransactionJournal } from './FileTransactionJournal.js';
import { JournalEntry, utcNow } from './JournalEntry.js';

/**
 * The payment-safety rules a till cannot leave to each request:
 *
 * 1. **One financial transaction per terminal at a time.** A second sale, void
 *    or refund while one is running, from any process on the machine, gets
 *    {@link Busy} and nothing is sent.
 * 2. **A merchant reference is used once.** Sending a reference this terminal has
 *    already been sent throws {@link DuplicateMerchantReferenceException}: that is
 *    how a till resends a payment it is unsure about.
 * 3. **No new money movement while an outcome is unknown.** After a timeout, a
 *    lost connection, an unreadable or unauthenticated answer, the reference is
 *    kept as unresolved, and the next sale, void or refund on that terminal gets
 *    {@link Unresolved} until an inquiry by reference settles it, or an operator
 *    settles it with {@link markResolved}.
 * 4. **The reference is persisted before the request leaves**, so a process
 *    killed mid-wait leaves an unresolved entry, not a forgotten payment.
 *
 * Inquiries, receipts and close receipt move no money and are never blocked.
 * The Windows SDK leaves these rules to the till (its web sample enforces 1);
 * so, to match it, this SDK (like the PHP one) leaves them off by default.
 * Turn them on with `new EcrConfig({ guardFinancialOperations: true })` unless
 * your own system enforces the same rules.
 */
export class FinancialGuard {
  constructor(
    private readonly journal: TransactionJournal,
    private readonly lock: TerminalLock,
    private readonly isEnabled = true,
    private readonly logger: EcrLogger | null = null,
  ) {}

  static fromConfig(config: EcrConfig, logger: EcrLogger | null = null): FinancialGuard {
    const directory = config.stateDirectory ?? join(tmpdir(), 'amwalpay-ecr');
    return new FinancialGuard(
      new FileTransactionJournal(directory),
      new FileTerminalLock(directory),
      config.guardFinancialOperations,
      logger,
    );
  }

  enabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Runs one sale, void or refund under the rules above.
   *
   * @param terminalKey Identifies the physical terminal (see the terminals' `terminalKey()`).
   * @param reference The resolved merchant reference the request will carry.
   * @param send Builds and sends the request.
   * @throws DuplicateMerchantReferenceException
   */
  async run(
    terminalKey: string,
    type: EcrTransactionType,
    reference: string,
    amountMinorUnits: string,
    currencyCode: string,
    send: () => Promise<EcrResult>,
  ): Promise<EcrResult> {
    if (!this.isEnabled) return send();

    const release = await this.lock.tryAcquire(terminalKey);
    if (release === null) {
      this.logger?.debug(`[Guard] ${type.messageType()} ${reference} refused: another transaction is running on this terminal`);
      return new Failed(reference, new Busy(
        'Another sale, void or refund is in progress on this terminal. Nothing was sent; '
        + 'wait for it to finish, then try again.',
      ));
    }

    try {
      const previous = await this.journal.find(terminalKey, reference);
      if (previous !== null) throw new DuplicateMerchantReferenceException(previous);

      const open = await this.journal.unresolved(terminalKey);
      if (open.length !== 0) {
        const references = open.map((e) => e.reference).join(', ');
        this.logger?.debug(`[Guard] ${type.messageType()} ${reference} refused: unresolved ${references}`);
        return new Failed(reference, new Unresolved(
          `An earlier transaction on this terminal has an unknown outcome: ${references}`
          + '. Nothing was sent. Inquire by that merchant reference before taking a new payment.',
        ));
      }

      const now = utcNow();
      await this.journal.put(terminalKey, new JournalEntry(
        reference,
        type.value,
        JournalEntry.PENDING,
        amountMinorUnits,
        currencyCode,
        now,
        now,
      ));

      const result = await send();
      await this.record(terminalKey, reference, result);
      return result;
    } finally {
      await release();
    }
  }

  /**
   * Lets an inquiry by reference settle an unresolved entry: a record whose
   * status is Approved or Declined settles it. Not found settles nothing:
   * after a lost answer it does not prove nothing was charged.
   */
  async observeInquiry(terminalKey: string, originalReference: string, inquiry: EcrInquiry): Promise<void> {
    if (!this.isEnabled) return;
    const entry = await this.journal.find(terminalKey, originalReference);
    if (entry === null || !entry.isUnresolved()) return;
    if (inquiry instanceof Found) {
      const status = inquiry.transaction.status;
      const state = inquiry.transaction.isApproved() ? JournalEntry.APPROVED
        : inquiry.transaction.isDeclined() ? JournalEntry.DECLINED : JournalEntry.UNKNOWN;
      await this.journal.put(terminalKey, entry.with({
        state,
        status,
        note: state === JournalEntry.UNKNOWN
          ? `Inquiry found status "${status}": confirm on the terminal or with Amwal, then mark it resolved.`
          : 'Settled by inquiry by merchant reference.',
      }));
    } else if (inquiry instanceof NotFound) {
      await this.journal.put(terminalKey, entry.with({
        state: JournalEntry.UNKNOWN,
        note: `Inquiry found no record (${inquiry.reason}). That does not prove nothing was charged.`,
      }));
    }
  }

  async unresolved(terminalKey: string): Promise<JournalEntry[]> {
    return this.isEnabled ? this.journal.unresolved(terminalKey) : [];
  }

  async entry(terminalKey: string, reference: string): Promise<JournalEntry | null> {
    return this.isEnabled ? this.journal.find(terminalKey, reference) : null;
  }

  /**
   * Settles an unresolved entry by hand, after the outcome was confirmed on the
   * terminal or with Amwal. `note` should say how it was confirmed.
   */
  async markResolved(terminalKey: string, reference: string, note: string): Promise<JournalEntry> {
    if (!this.isEnabled) throw new LogicException('The financial guard is off: there is no journal to settle');
    const entry = await this.journal.find(terminalKey, reference);
    if (entry === null) {
      throw new InvalidArgumentException(`No transaction with merchant reference ${reference} was sent to this terminal`);
    }
    if (!entry.isUnresolved()) return entry;
    if (trim(note) === '') throw new InvalidArgumentException('Say how the outcome was confirmed');
    const resolved = entry.with({ state: JournalEntry.RESOLVED, note: trim(note) });
    await this.journal.put(terminalKey, resolved);
    this.logger?.debug(`[Guard] ${reference} marked resolved by the operator`);
    return resolved;
  }

  private async record(terminalKey: string, reference: string, result: EcrResult): Promise<void> {
    const entry = await this.journal.find(terminalKey, reference);
    if (entry === null) return;
    if (result instanceof Approved) {
      await this.journal.put(terminalKey, entry.with({ state: JournalEntry.APPROVED, status: 'Approved' }));
      return;
    }
    if (result instanceof Declined) {
      await this.journal.put(terminalKey, entry.with({ state: JournalEntry.DECLINED, status: result.responseCode }));
      return;
    }
    if (!(result instanceof Failed)) return;
    if (!result.failure.outcomeUnknown()) {
      // Nothing was sent: the reference was never used and may be used again.
      await this.journal.remove(terminalKey, reference);
      return;
    }
    const failure = `${result.failure.kind()}: ${result.failure.message}`;
    const current = (await this.journal.find(terminalKey, reference)) ?? entry;
    if (!current.isUnresolved()) {
      // The automatic inquiry already settled it.
      await this.journal.put(terminalKey, current.with({ failure }));
      return;
    }
    await this.journal.put(terminalKey, current.with({ state: JournalEntry.UNKNOWN, failure }));
  }
}
