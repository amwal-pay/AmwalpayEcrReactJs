import { Approved, Declined, EcrTransactionType, EcrWireResponse, Failed, Found, InquiryFailed, Json, NotFound } from '@amwalpay/ecr-js';
import { TransactionOutcomes } from './TransactionOutcomes.js';
import { StateCompleted, StateFailed, StateInquired } from './TransactionState.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How a transaction ended: the outcome at a glance, the fields that matter to a
 * cashier, and the terminal's full answer tucked away. The wording is the
 * Windows samples' ResultPresenter, word for word.
 *
 * Returns the dialog model: headline, tone (approved|declined), amount,
 * message, note, fields [{label, value}], hints, rawPayload,
 * inquirableReference, offersReceipt, receiptNote.
 */
export class ResultPresenter {
  static PARTIAL_APPROVAL_HEADLINE = 'Partially approved';

  static UNKNOWN_OUTCOME_WARNING = 'The transaction may have completed. Check before taking payment again — '
    + 'sending it a second time would charge the cardholder twice.';

  static for(state, usesWebService) {
    if (state instanceof StateCompleted) return ResultPresenter.forResult(state.result, state.type);
    if (state instanceof StateInquired) return ResultPresenter.forInquiry(state, !usesWebService, usesWebService);
    if (state instanceof StateFailed) return ResultPresenter.forFailure(state);
    return null;
  }

  static forResult(result, type) {
    if (result instanceof Approved) {
      const fields = [];
      // A void carries no authorisation of its own (the terminal returns a
      // placeholder 000000), so showing one would suggest an approval.
      if (type !== EcrTransactionType.Void) fields.push({ label: 'Auth code', value: result.authCode });
      fields.push({ label: 'Card', value: result.maskedPan });
      fields.push({ label: 'Reference', value: result.merchantReference });
      return model({
        headline: result.partialApproval ? ResultPresenter.PARTIAL_APPROVAL_HEADLINE : 'Approved',
        tone: 'approved',
        amount: result.amount,
        message: result.partialApproval ? ResultPresenter.partialMessage(result.amount, result.requestedAmount) : null,
        fields: nonEmpty(fields),
        rawPayload: ResultPresenter.pretty(result.raw),
      });
    }
    if (result instanceof Declined) {
      return model({
        headline: 'Declined',
        tone: 'declined',
        message: EcrWireResponse.displayMessageFromRaw(result.raw, result.reason),
        rawPayload: result.raw !== '' ? ResultPresenter.pretty(result.raw) : null,
      });
    }
    if (!(result instanceof Failed)) throw new Error('Unexpected result');
    return ResultPresenter.forFailure(new StateFailed(result.failure.message));
  }

  /**
   * What the terminal knows about an earlier transaction. The headline is the
   * transaction's own status: an inquiry that finds a declined sale succeeded,
   * and the till needs to read "Declined".
   */
  static forInquiry(state, receiptSupported, webService) {
    const inquiry = state.inquiry;
    if (inquiry instanceof InquiryFailed) return ResultPresenter.forFailure(new StateFailed(inquiry.failure.message));
    if (inquiry instanceof NotFound) {
      return model({
        headline: 'Not found',
        tone: 'declined',
        message: EcrWireResponse.displayMessageFromRaw(inquiry.raw, inquiry.reason),
        note: TransactionOutcomes.inquiryNote(inquiry, webService),
        rawPayload: ResultPresenter.pretty(inquiry.raw),
      });
    }
    if (!(inquiry instanceof Found)) throw new Error('Unexpected inquiry');
    const txn = inquiry.transaction;
    const settled = txn.isApproved();
    // A partial approval read back has to read like the sale did.
    const partial = settled && txn.partialApproval;
    const hints = [];
    if (txn.isRefunded) hints.push('Already refunded');
    if (txn.canVoid) hints.push('Can be voided');
    if (txn.canRefund) hints.push('Can be refunded');
    let message = null;
    if (partial) message = ResultPresenter.partialMessage(txn.authorizedAmount, txn.amount);
    else if (!settled) message = EcrWireResponse.displayMessageFromRaw(inquiry.raw, txn.status);
    return model({
      headline: partial ? ResultPresenter.PARTIAL_APPROVAL_HEADLINE : (txn.status === '' ? 'Found' : txn.status),
      tone: settled ? 'approved' : 'declined',
      amount: partial ? txn.authorizedAmount : txn.amount,
      message,
      fields: nonEmpty([
        { label: 'Receipt number', value: txn.stan },
        { label: 'Type', value: txn.type },
        { label: 'Card', value: txn.maskedPan },
        { label: 'Date/Time', value: ResultPresenter.readableTime(txn.transactionTime) },
      ]),
      hints,
      note: state.recoveredFromFailure
        ? "The terminal's answer to this request was lost, but it was asked automatically "
          + 'and knows this transaction. Do not send it again.'
        : null,
      rawPayload: ResultPresenter.pretty(inquiry.raw),
      offersReceipt: receiptSupported,
      receiptNote: receiptSupported ? null : 'The e-receipt QR is available over Wi‑Fi.',
    });
  }

  /**
   * The exchange itself failed. Not "Declined": no answer came back, so nobody
   * knows yet, and the wording has to stop an operator concluding it did not happen.
   */
  static forFailure(failed) {
    return model({
      headline: failed.inquirableReference === null ? 'Not completed' : 'Outcome unknown',
      tone: 'declined',
      message: failed.message,
      note: failed.note,
      inquirableReference: failed.inquirableReference,
    });
  }

  static partialMessage(approved, requested) {
    return `Only ${approved} of ${requested} was approved. Collect the difference by another means.`;
  }

  /** `2026-08-09T16:58:16.804271` as `09 Aug 2026 16:58`; anything else as it arrived. */
  static readableTime(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
    if (m === null) return value;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    const date = new Date(y, mo - 1, d, h, mi, s);
    // A day or time that does not exist (e.g. 2026-02-30) is shown as it arrived.
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== s) {
      return value;
    }
    return `${String(d).padStart(2, '0')} ${MONTHS[mo - 1]} ${y} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }

  /** Indents JSON for reading; anything that is not JSON is returned as it arrived. */
  static pretty(raw) {
    if (raw === '') return raw;
    try {
      return Json.pretty(Json.parse(raw));
    } catch {
      return raw;
    }
  }
}

function nonEmpty(fields) {
  return fields.filter((f) => f.value !== '');
}

function model({
  headline, tone, amount = '', message = null, fields = [], hints = [], note = null, rawPayload = null,
  inquirableReference = null, offersReceipt = false, receiptNote = null,
}) {
  return {
    headline,
    tone,
    amount,
    message,
    note,
    fields,
    hints,
    rawPayload,
    isUnknownOutcome: inquirableReference !== null,
    inquirableReference,
    offersReceipt,
    receiptNote,
  };
}
