/** The fields a journal stores for one entry, all text. */
export interface JournalEntryData {
  reference: string;
  type: string;
  state: string;
  amountMinorUnits: string;
  currencyCode: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  failure: string;
  note: string;
}

/** The current time as the journal writes it: UTC, to the second, `2026-10-25T10:15:00Z`. @internal */
export function utcNow(): string {
  return new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
}

/**
 * One sale, void or refund the guard sent, as the journal remembers it. Holds
 * the reference, type, amount and outcome; never card data or keys.
 */
export class JournalEntry implements JournalEntryData {
  /** Recorded before the request left; the answer has not been read yet. */
  static readonly PENDING = 'pending';
  /** The request went out and the answer did not settle it. Inquire by reference. */
  static readonly UNKNOWN = 'unknown';
  static readonly APPROVED = 'approved';
  static readonly DECLINED = 'declined';
  /** Settled by hand with {@link FinancialGuard.markResolved} after confirming on the terminal or with Amwal. */
  static readonly RESOLVED = 'resolved';

  constructor(
    readonly reference: string,
    readonly type: string,
    readonly state: string,
    readonly amountMinorUnits: string,
    readonly currencyCode: string,
    readonly createdAt: string,
    readonly updatedAt: string,
    readonly status: string = '',
    readonly failure: string = '',
    readonly note: string = '',
  ) {}

  /** Whether the outcome is still unknown: the terminal must be asked before any new money moves. */
  isUnresolved(): boolean {
    return this.state === JournalEntry.PENDING || this.state === JournalEntry.UNKNOWN;
  }

  /** A copy with the given fields changed and `updatedAt` set to now. */
  with(changes: { state?: string; status?: string; failure?: string; note?: string }): JournalEntry {
    return new JournalEntry(
      this.reference,
      this.type,
      changes.state ?? this.state,
      this.amountMinorUnits,
      this.currencyCode,
      this.createdAt,
      utcNow(),
      changes.status ?? this.status,
      changes.failure ?? this.failure,
      changes.note ?? this.note,
    );
  }

  toJSON(): JournalEntryData {
    return {
      reference: this.reference,
      type: this.type,
      state: this.state,
      amountMinorUnits: this.amountMinorUnits,
      currencyCode: this.currencyCode,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      status: this.status,
      failure: this.failure,
      note: this.note,
    };
  }

  /** Reads a stored entry; a missing or non-scalar field reads as "". */
  static fromJSON(data: Record<string, unknown>): JournalEntry {
    const text = (key: string): string => {
      const value = data[key];
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
    };
    return new JournalEntry(
      text('reference'),
      text('type'),
      text('state'),
      text('amountMinorUnits'),
      text('currencyCode'),
      text('createdAt'),
      text('updatedAt'),
      text('status'),
      text('failure'),
      text('note'),
    );
  }
}
