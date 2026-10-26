/**
 * What the transaction screen is showing: Idle, Checking, InProgress,
 * Completed, Inquired or Failed.
 */
export class TransactionState {
  isBusy() {
    return this instanceof StateChecking || this instanceof StateInProgress;
  }

  /** A state the operator has to acknowledge before doing anything else. */
  isResult() {
    return this instanceof StateCompleted || this instanceof StateInquired || this instanceof StateFailed;
  }

  /** `idle`, `checking`, `inProgress`, `completed`, `inquired` or `failed`. */
  name() {
    throw new Error('abstract');
  }
}

/** Nothing running: stopped before anything was sent. */
export class StateIdle extends TransactionState {
  name() {
    return 'idle';
  }
}

/** Probing the terminal, before anything is sent to it. */
export class StateChecking extends TransactionState {
  name() {
    return 'checking';
  }
}

/** Sent, waiting on the cardholder and the terminal. */
export class StateInProgress extends TransactionState {
  name() {
    return 'inProgress';
  }
}

/** The terminal answered, approved or declined. The operation is kept alongside. */
export class StateCompleted extends TransactionState {
  constructor(result, type) {
    super();
    this.result = result;
    this.type = type;
  }

  name() {
    return 'completed';
  }
}

/**
 * An inquiry was answered. The request is kept so the receipt can be asked for
 * from here; `recoveredFromFailure` marks a finding from the SDK's automatic
 * inquiry after a sale whose answer was lost.
 */
export class StateInquired extends TransactionState {
  constructor(inquiry, request, { receipt = null, fetchingReceipt = false, recoveredFromFailure = false } = {}) {
    super();
    this.inquiry = inquiry;
    this.request = request;
    this.receipt = receipt;
    this.fetchingReceipt = fetchingReceipt;
    this.recoveredFromFailure = recoveredFromFailure;
  }

  withReceipt(receipt, fetching) {
    return new StateInquired(this.inquiry, this.request, {
      receipt,
      fetchingReceipt: fetching,
      recoveredFromFailure: this.recoveredFromFailure,
    });
  }

  name() {
    return 'inquired';
  }
}

/**
 * The exchange itself failed. `inquirableReference` is set when the outcome is
 * genuinely unknown: the request went out and the transaction may have
 * completed, so the only thing offered is to look it up by that reference.
 * Null when nothing was ever sent.
 */
export class StateFailed extends TransactionState {
  constructor(message, inquirableReference = null, note = null) {
    super();
    this.message = message;
    this.inquirableReference = inquirableReference;
    this.note = note;
  }

  name() {
    return 'failed';
  }
}
