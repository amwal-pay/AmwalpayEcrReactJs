/**
 * The link to the terminal failed.
 *
 * What the failure means for the payment is decided from the message, the
 * same way the Windows SDK reads `IOException`: "closed the connection" means
 * the request may have arrived (connection lost), "not valid JSON" or "empty
 * message" means the answer was unreadable (malformed), anything else means
 * nothing was sent (unreachable).
 */
export class EcrIOException extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The terminal accepted the request and did not answer in time. Not a refusal:
 * the transaction may still have run.
 */
export class EcrChannelTimeout extends EcrIOException {}

/**
 * How bytes reach a terminal, and nothing else.
 *
 * Signing a request, checking the answer and deciding what a response code
 * means all belong to {@link EcrTerminal} and are the same however the bytes
 * travel. A channel carries one framed request and brings back one framed answer.
 */
export interface EcrChannel {
  /** What to show an operator when this link fails, e.g. `192.168.1.50:9100`. */
  endpoint(): string;

  host(): string;

  /** Zero when the link is not a socket. */
  port(): number;

  /**
   * Whether the terminal can be reached, without sending anything.
   *
   * @returns null when reachable, otherwise the reason
   */
  probe(timeout: number): Promise<string | null>;

  /**
   * Sends one request body and returns the answer body, both UTF-8 JSON
   * without the length header. Framing is the channel's to apply. `timeout`
   * is in seconds.
   *
   * @throws EcrChannelTimeout the terminal accepted the request and did not answer within `timeout` seconds
   * @throws EcrIOException anything else that broke the link
   */
  exchange(body: string, timeout: number): Promise<Uint8Array | string>;
}
