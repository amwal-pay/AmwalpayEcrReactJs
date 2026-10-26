/** One HTTP answer: status, body and reason phrase (empty on HTTP/2). */
export class HttpResponse {
  /** @param body The answer as text, or as the raw bytes so the SDK can refuse invalid UTF-8. */
  constructor(
    readonly status: number,
    readonly body: string | Uint8Array,
    readonly reasonPhrase: string = '',
  ) {}

  /** The body as text, invalid UTF-8 shown as U+FFFD: for logs and emptiness checks only. */
  text(): string {
    return typeof this.body === 'string' ? this.body : Buffer.from(this.body).toString('utf8');
  }
}

/**
 * No HTTP answer was read: DNS, TLS, connection refused or reset, or the
 * deadline passed. The request may have reached the Hub, so the SDK reads this
 * as an unknown outcome.
 */
export class HttpTransportException extends Error {
  constructor(message: string, readonly timedOut = false, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HttpTransportException';
  }
}

/**
 * Posts one JSON body and returns the answer. {@link NodeHttpTransport} is the
 * default; supply your own to route through a corporate proxy or to test. The
 * URL is always the one the SDK resolved for the environment.
 */
export interface HttpTransport {
  /**
   * @param connectTimeout seconds to establish the connection
   * @param totalTimeout seconds for the whole exchange, connection included
   * @throws HttpTransportException no answer was read
   */
  post(url: string, body: string, headers: Record<string, string>, connectTimeout: number, totalTimeout: number): Promise<HttpResponse>;
}
