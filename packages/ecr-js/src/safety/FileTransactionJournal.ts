import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeException } from '../exception/errors.js';
import { compareBytes } from '../internal/text.js';
import type { TransactionJournal } from './contracts.js';
import { JournalEntry, type JournalEntryData } from './JournalEntry.js';
import { ensureDirectory, lockFile } from './lockFile.js';

type Entries = Record<string, JournalEntryData>;

/**
 * The journal as one JSON file per terminal, in a private folder.
 *
 * Every change is a read-modify-write under an exclusive lock, written to a
 * temporary file and renamed into place, so two processes never interleave
 * and a crash never leaves half a file. Settled entries older than the
 * retention period are dropped; unresolved ones are kept until they are settled.
 */
export class FileTransactionJournal implements TransactionJournal {
  /** How long to wait for another process's journal write. */
  private static readonly LOCK_WAIT_MS = 10_000;

  constructor(
    private readonly directory: string,
    private readonly retentionDays = 90,
  ) {}

  find(terminalKey: string, reference: string): JournalEntry | null {
    const entries = this.read(terminalKey);
    return Object.prototype.hasOwnProperty.call(entries, reference) ? JournalEntry.fromJSON(entries[reference] as unknown as Record<string, unknown>) : null;
  }

  unresolved(terminalKey: string): JournalEntry[] {
    const open: JournalEntry[] = [];
    for (const data of Object.values(this.read(terminalKey))) {
      const entry = JournalEntry.fromJSON(data as unknown as Record<string, unknown>);
      if (entry.isUnresolved()) open.push(entry);
    }
    return open.sort((a, b) => compareBytes(a.createdAt, b.createdAt));
  }

  put(terminalKey: string, entry: JournalEntry): void {
    this.update(terminalKey, (entries) => {
      entries[entry.reference] = entry.toJSON();
      return entries;
    });
  }

  remove(terminalKey: string, reference: string): void {
    this.update(terminalKey, (entries) => {
      delete entries[reference];
      return entries;
    });
  }

  private read(terminalKey: string): Entries {
    const path = this.path(terminalKey);
    if (!existsSync(path)) return {};
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new RuntimeException('The ECR transaction journal could not be read: ' + path, { cause: error });
    }
    if (text === '') return {};
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const entries = (data as { entries?: unknown } | null)?.entries;
    if (data === null || typeof data !== 'object' || Array.isArray(data) || entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
      // Fail closed: a journal that cannot be read cannot prove a reference is unused.
      throw new RuntimeException('The ECR transaction journal is corrupt and must be checked by hand: ' + path);
    }
    const copy: Entries = Object.create(null);
    for (const [reference, value] of Object.entries(entries as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object') copy[reference] = value as JournalEntryData;
    }
    return copy;
  }

  private update(terminalKey: string, change: (entries: Entries) => Entries): void {
    ensureDirectory(this.directory);
    const path = this.path(terminalKey);
    const release = lockFile(path + '.lock', FileTransactionJournal.LOCK_WAIT_MS, 'The ECR transaction journal');
    try {
      const entries = this.prune(change(this.read(terminalKey)));
      const json = JSON.stringify({ terminal: terminalKey, entries }, null, 4);
      const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        writeFileSync(temp, json, { mode: 0o600 });
        renameWithRetry(temp, path);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          // Never written.
        }
        throw new RuntimeException('The ECR transaction journal could not be saved: ' + path, { cause: error });
      }
    } finally {
      release();
    }
  }

  private prune(entries: Entries): Entries {
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
    for (const [reference, data] of Object.entries(entries)) {
      const entry = JournalEntry.fromJSON(data as unknown as Record<string, unknown>);
      if (!entry.isUnresolved() && entry.updatedAt !== '' && compareBytes(entry.updatedAt, cutoff) < 0) {
        delete entries[reference];
      }
    }
    return entries;
  }

  private path(terminalKey: string): string {
    return join(this.directory, 'journal-' + createHash('sha256').update(terminalKey).digest('hex').slice(0, 32) + '.json');
  }
}

/** On Windows a rename can briefly fail while another process (or a virus scanner) reads the target. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
