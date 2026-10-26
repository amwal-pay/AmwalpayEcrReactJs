import type { JournalEntry } from '../safety/JournalEntry.js';
import { InvalidRequestException } from './InvalidRequestException.js';

/**
 * A sale, void or refund was asked for with a merchant reference this terminal
 * has already been sent.
 *
 * Reusing a reference is how a till resends a payment it is unsure about, and
 * resending is how a cardholder is charged twice. When the earlier attempt's
 * outcome is unknown, inquire by this reference; when it was declined, start
 * the new attempt with a new reference.
 */
export class DuplicateMerchantReferenceException extends InvalidRequestException {
  constructor(readonly previous: JournalEntry) {
    const advice = previous.isUnresolved()
      ? 'Its outcome is still unknown: inquire by this reference, never resend.'
      : 'A new attempt needs a new reference.';
    super(`Merchant reference ${previous.reference} was already sent to this terminal (${previous.type}, ${previous.state}). ${advice}`);
  }
}
