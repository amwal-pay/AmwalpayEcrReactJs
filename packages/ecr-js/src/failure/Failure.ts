/**
 * Why an exchange could not be completed.
 *
 * The one distinction that matters after a failure is {@link outcomeUnknown}.
 * When it is false nothing reached the terminal, so there is nothing to
 * reconcile. When it is true the request went out and the terminal may have
 * acted on it, whatever came back or did not: inquire by merchant reference,
 * never resend.
 */
export abstract class Failure {
  constructor(readonly message: string) {}

  /** Whether the request may have reached the terminal, leaving the outcome unknown. */
  outcomeUnknown(): boolean {
    return true;
  }

  /** A short name for the kind of failure: `timeout`, `unreachable`, ... */
  abstract kind(): string;

  toJSON(): { kind: string; message: string; outcomeUnknown: boolean } {
    return { kind: this.kind(), message: this.message, outcomeUnknown: this.outcomeUnknown() };
  }
}

/**
 * Another sale, void or refund is already running on this terminal, from this
 * process or another. Nothing was sent. Added by the PHP SDK: a server runs
 * many requests at once.
 */
export class Busy extends Failure {
  override outcomeUnknown(): boolean {
    return false;
  }

  kind(): string {
    return 'busy';
  }
}

/**
 * The connection broke after the request went out. The transaction may still
 * have completed: inquire before retrying.
 */
export class ConnectionLost extends Failure {
  kind(): string {
    return 'connection_lost';
  }
}

/**
 * The request could not be built: a configuration problem found before
 * anything was sent, such as non-numeric Web Service IDs. Nothing was sent.
 */
export class Invalid extends Failure {
  override outcomeUnknown(): boolean {
    return false;
  }

  kind(): string {
    return 'invalid';
  }
}

/**
 * The answer could not be read. The transaction may still have completed:
 * inquire before retrying.
 */
export class Malformed extends Failure {
  kind(): string {
    return 'malformed';
  }
}

/**
 * The request went out and no answer came in time. The transaction may still
 * have completed: inquire before retrying.
 */
export class Timeout extends Failure {
  kind(): string {
    return 'timeout';
  }
}

/**
 * The answer could not be shown to come from the terminal: not signed with
 * this till's key, or it answers a different request. Discarded, not believed.
 * The terminal may have taken the payment: inquire before retrying. Seen
 * repeatedly, the key on the till and on the terminal differ.
 */
export class Unauthenticated extends Failure {
  kind(): string {
    return 'unauthenticated';
  }
}

/**
 * Nothing is listening: wrong address, terminal off, or a different network.
 * Nothing was sent.
 */
export class Unreachable extends Failure {
  override outcomeUnknown(): boolean {
    return false;
  }

  kind(): string {
    return 'unreachable';
  }
}

/**
 * An earlier sale, void or refund on this terminal has an unknown outcome and
 * must be reconciled by inquiry before a new one is sent. Nothing was sent.
 * Added by the PHP SDK.
 */
export class Unresolved extends Failure {
  override outcomeUnknown(): boolean {
    return false;
  }

  kind(): string {
    return 'unresolved';
  }
}
