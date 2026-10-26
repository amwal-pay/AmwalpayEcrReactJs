import {
  Approved, Busy, ConnectionLost, Declined, EcrTransaction, EcrTransactionType, Failed, Found, InquiryFailed, Invalid,
  Malformed, NextStep, NotFound, ReceiptFailed, ReceiptReady, ReceiptUnavailable, Timeout, Unauthenticated, Unreachable,
  Unresolved,
} from '@amwalpay/ecr-js';
import { TransactionRequest } from './TransactionRequest.js';
import {
  StateChecking, StateCompleted, StateFailed, StateIdle, StateInProgress, StateInquired,
} from './TransactionState.js';

/**
 * Writes a run's state as plain JSON and reads it back into the same classes,
 * so a run survives a server restart. Only the known shapes are read: anything
 * else is refused, the counterpart of the PHP sample's `allowed_classes`.
 */

const FAILURES = {
  busy: Busy, connection_lost: ConnectionLost, invalid: Invalid, malformed: Malformed, timeout: Timeout,
  unauthenticated: Unauthenticated, unreachable: Unreachable, unresolved: Unresolved,
};

export function encodeState(state) {
  if (state instanceof StateIdle) return { name: 'idle' };
  if (state instanceof StateChecking) return { name: 'checking' };
  if (state instanceof StateInProgress) return { name: 'inProgress' };
  if (state instanceof StateCompleted) return { name: 'completed', type: state.type.value, result: encodeResult(state.result) };
  if (state instanceof StateInquired) {
    return {
      name: 'inquired',
      inquiry: encodeInquiry(state.inquiry),
      request: state.request.toJSON(),
      receipt: state.receipt === null ? null : encodeReceipt(state.receipt),
      fetchingReceipt: state.fetchingReceipt,
      recoveredFromFailure: state.recoveredFromFailure,
    };
  }
  if (state instanceof StateFailed) {
    return { name: 'failed', message: state.message, inquirableReference: state.inquirableReference, note: state.note };
  }
  throw new Error('Unknown state');
}

export function decodeState(data) {
  switch (data?.name) {
    case 'idle': return new StateIdle();
    case 'checking': return new StateChecking();
    case 'inProgress': return new StateInProgress();
    case 'completed': return new StateCompleted(decodeResult(data.result), type(data.type));
    case 'inquired':
      return new StateInquired(decodeInquiry(data.inquiry), TransactionRequest.fromJSON(data.request), {
        receipt: data.receipt === null ? null : decodeReceipt(data.receipt),
        fetchingReceipt: data.fetchingReceipt === true,
        recoveredFromFailure: data.recoveredFromFailure === true,
      });
    case 'failed':
      return new StateFailed(text(data.message), nullableText(data.inquirableReference), nullableText(data.note));
    default:
      throw new Error('Unknown state in a stored run');
  }
}

function encodeFailure(failure) {
  return { kind: failure.kind(), message: failure.message };
}

function decodeFailure(data) {
  const Kind = FAILURES[data?.kind];
  if (Kind === undefined) throw new Error('Unknown failure in a stored run');
  return new Kind(text(data.message));
}

function encodeResult(result) {
  if (result instanceof Approved) {
    return {
      kind: 'approved', merchantReference: result.merchantReference, amount: result.amount, responseCode: result.responseCode,
      rrn: result.rrn, authCode: result.authCode, maskedPan: result.maskedPan, partialApproval: result.partialApproval,
      requestedAmount: result.requestedAmount, raw: result.raw,
    };
  }
  if (result instanceof Declined) {
    return {
      kind: 'declined', merchantReference: result.merchantReference, responseCode: result.responseCode, reason: result.reason,
      nextStep: result.nextStep.value, raw: result.raw,
    };
  }
  if (result instanceof Failed) {
    return {
      kind: 'failed', merchantReference: result.merchantReference, failure: encodeFailure(result.failure),
      recovered: result.recovered === null ? null : encodeInquiry(result.recovered),
    };
  }
  throw new Error('Unknown result');
}

function decodeResult(data) {
  switch (data?.kind) {
    case 'approved':
      return new Approved(text(data.merchantReference), text(data.amount), text(data.responseCode), text(data.rrn), text(data.authCode),
        text(data.maskedPan), data.partialApproval === true, text(data.requestedAmount), text(data.raw));
    case 'declined':
      return new Declined(text(data.merchantReference), text(data.responseCode), text(data.reason), NextStep.fromWire(text(data.nextStep)), text(data.raw));
    case 'failed':
      return new Failed(text(data.merchantReference), decodeFailure(data.failure), data.recovered === null ? null : decodeInquiry(data.recovered));
    default:
      throw new Error('Unknown result in a stored run');
  }
}

function encodeInquiry(inquiry) {
  if (inquiry instanceof Found) {
    return { kind: 'found', merchantReference: inquiry.merchantReference, transaction: inquiry.transaction.toJSON(), raw: inquiry.raw };
  }
  if (inquiry instanceof NotFound) return { kind: 'not_found', merchantReference: inquiry.merchantReference, reason: inquiry.reason, raw: inquiry.raw };
  if (inquiry instanceof InquiryFailed) return { kind: 'failed', merchantReference: inquiry.merchantReference, failure: encodeFailure(inquiry.failure) };
  throw new Error('Unknown inquiry');
}

function decodeInquiry(data) {
  switch (data?.kind) {
    case 'found': {
      const t = data.transaction ?? {};
      return new Found(text(data.merchantReference), new EcrTransaction({
        transactionId: text(t.transactionId), stan: text(t.stan), type: text(t.type), status: text(t.status), amount: text(t.amount),
        totalAmount: text(t.totalAmount), currency: text(t.currency), transactionTime: text(t.transactionTime), maskedPan: text(t.maskedPan),
        cardHolderName: text(t.cardHolderName), rrn: text(t.rrn), authCode: text(t.authCode), batchId: text(t.batchId),
        terminalId: text(t.terminalId), isRefunded: t.isRefunded === true, canVoid: t.canVoid === true, canRefund: t.canRefund === true,
        partialApproval: t.partialApproval === true, authorizedAmount: text(t.authorizedAmount),
      }), text(data.raw));
    }
    case 'not_found': return new NotFound(text(data.merchantReference), text(data.reason), text(data.raw));
    case 'failed': return new InquiryFailed(text(data.merchantReference), decodeFailure(data.failure));
    default: throw new Error('Unknown inquiry in a stored run');
  }
}

function encodeReceipt(receipt) {
  if (receipt instanceof ReceiptReady) return { kind: 'ready', merchantReference: receipt.merchantReference, url: receipt.url, raw: receipt.raw };
  if (receipt instanceof ReceiptUnavailable) return { kind: 'unavailable', merchantReference: receipt.merchantReference, reason: receipt.reason, raw: receipt.raw };
  if (receipt instanceof ReceiptFailed) return { kind: 'failed', merchantReference: receipt.merchantReference, failure: encodeFailure(receipt.failure) };
  throw new Error('Unknown receipt');
}

function decodeReceipt(data) {
  switch (data?.kind) {
    case 'ready': return new ReceiptReady(text(data.merchantReference), text(data.url), text(data.raw));
    case 'unavailable': return new ReceiptUnavailable(text(data.merchantReference), text(data.reason), text(data.raw));
    case 'failed': return new ReceiptFailed(text(data.merchantReference), decodeFailure(data.failure));
    default: throw new Error('Unknown receipt in a stored run');
  }
}

function type(value) {
  const found = EcrTransactionType.tryFrom(text(value));
  if (found === null) throw new Error('Unknown transaction type in a stored run');
  return found;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function nullableText(value) {
  return typeof value === 'string' ? value : null;
}
