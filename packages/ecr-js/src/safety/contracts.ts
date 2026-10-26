import type { JournalEntry } from './JournalEntry.js';

type MaybePromise<T> = T | Promise<T>;

/**
 * Remembers every merchant reference sent to a terminal and what became of it,
 * across requests and processes. Implement it over your database to share the
 * guard between servers; {@link FileTransactionJournal} is the default.
 *
 * Each method may answer directly or with a promise.
 */
export interface TransactionJournal {
  find(terminalKey: string, reference: string): MaybePromise<JournalEntry | null>;

  /** Entries whose outcome is still unknown, oldest first. */
  unresolved(terminalKey: string): MaybePromise<JournalEntry[]>;

  /** Inserts or replaces the entry for `entry.reference`. */
  put(terminalKey: string, entry: JournalEntry): MaybePromise<void>;

  remove(terminalKey: string, reference: string): MaybePromise<void>;
}

/**
 * One financial transaction per terminal at a time, across every process on
 * the machine. Implement it over a shared lock service (Redis, a database row)
 * when several servers drive the same terminal.
 */
export interface TerminalLock {
  /**
   * Takes the terminal without waiting.
   *
   * @returns the release function, or null when another caller holds the terminal
   */
  tryAcquire(terminalKey: string): MaybePromise<(() => MaybePromise<void>) | null>;
}
