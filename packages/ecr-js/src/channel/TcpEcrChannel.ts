import { connect as netConnect, type Socket } from 'node:net';
import { EcrConfig } from '../EcrConfig.js';
import { EcrChannelTimeout, EcrIOException, type EcrChannel } from './EcrChannel.js';
import { EcrFrames } from './EcrFrames.js';

/**
 * The terminal over TCP, on the shop's Wi-Fi or LAN.
 *
 * One connection carries one request and one answer, which is how POS ECR ports
 * behave: connect, send, wait for the cardholder, read the result, disconnect.
 *
 * The connect budget and the answer budget are separate. Connecting is a
 * handshake on the local network and either happens quickly or the address is
 * wrong; nothing has been sent, so a connect failure is "unreachable". The long
 * wait belongs to the answer, which includes a cardholder presenting a card.
 */
export class TcpEcrChannel implements EcrChannel {
  /** Prefer passing {@link EcrConfig.connectTimeout}, as {@link EcrTerminal} does. */
  static readonly DEFAULT_CONNECT_TIMEOUT = 3;

  readonly #host: string;
  readonly #port: number;
  readonly #connectTimeout: number;

  constructor(host: string, port: number = EcrConfig.DEFAULT_PORT, connectTimeout: number | null = null) {
    this.#host = host;
    this.#port = port;
    this.#connectTimeout = connectTimeout ?? TcpEcrChannel.DEFAULT_CONNECT_TIMEOUT;
  }

  host(): string {
    return this.#host;
  }

  port(): number {
    return this.#port;
  }

  endpoint(): string {
    return `${this.#host}:${this.#port}`;
  }

  async probe(timeout: number): Promise<string | null> {
    try {
      const socket = await this.connect(timeout);
      socket.destroy();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async exchange(body: string, timeout: number): Promise<Buffer> {
    // Framed first: a request too large for a frame is a local error, and
    // must not be reported as a connection the terminal dropped (which would
    // make the outcome look unknown) when nothing was ever sent.
    const packet = EcrFrames.wrap(body);

    const socket = await this.connect(this.#connectTimeout);

    // From here the request may reach the terminal, so a failure is no
    // longer "nothing happened".
    return new Promise<Buffer>((resolve, reject) => {
      let received: Buffer = Buffer.alloc(0);
      let expected = -1;
      let done = false;

      const finish = (error: Error | null, body?: Buffer): void => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        socket.removeAllListeners('data');
        socket.removeAllListeners('end');
        socket.removeAllListeners('close');
        socket.on('error', () => {});
        socket.destroy();
        if (error !== null) reject(error);
        else resolve(body!);
      };

      const deadline = setTimeout(
        () => finish(new EcrChannelTimeout('the terminal did not answer in time')),
        Math.max(1, Math.round(timeout * 1000)),
      );

      socket.on('data', (chunk: Buffer) => {
        received = received.length === 0 ? chunk : Buffer.concat([received, chunk]);
        if (expected < 0 && received.length >= EcrFrames.HEADER_BYTES) {
          expected = EcrFrames.bodyLength(received);
          if (expected <= 0) {
            finish(new EcrIOException('Terminal returned an empty message'));
            return;
          }
        }
        if (expected >= 0 && received.length >= EcrFrames.HEADER_BYTES + expected) {
          finish(null, Buffer.from(received.subarray(EcrFrames.HEADER_BYTES, EcrFrames.HEADER_BYTES + expected)));
        }
      });
      const ended = (): void => finish(EcrFrames.closed(received.length < EcrFrames.HEADER_BYTES ? 'response header' : 'response body'));
      socket.on('end', ended);
      socket.on('close', ended);
      // A reset or abort after the request went out: the terminal may have
      // acted on it, so this is a lost connection, not an address that could
      // not be reached.
      socket.on('error', (error: NodeJS.ErrnoException) => {
        finish(new EcrIOException('Terminal closed the connection: ' + TcpEcrChannel.reason(error, 'read failed')));
      });

      socket.write(packet);
    });
  }

  /** Opens the connection, or says why not. Nothing has been sent when this fails. */
  private connect(timeout: number): Promise<Socket> {
    const host = this.#host.startsWith('[') && this.#host.endsWith(']') ? this.#host.slice(1, -1) : this.#host;
    const ms = Math.max(1, Math.round(timeout * 1000));
    return new Promise<Socket>((resolve, reject) => {
      const socket = netConnect({ host, port: this.#port });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.removeAllListeners();
        socket.on('error', () => {});
        socket.destroy();
        reject(new EcrIOException(`Connection timed out after ${ms} ms`));
      }, ms);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(socket);
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new EcrIOException(
          error.code === 'ETIMEDOUT' ? `Connection timed out after ${ms} ms` : TcpEcrChannel.reason(error, 'Could not connect'),
        ));
      });
    });
  }

  /** A readable reason for a socket error, e.g. "Connection refused (ECONNREFUSED)". */
  private static reason(error: NodeJS.ErrnoException, fallback: string): string {
    const known: Record<string, string> = {
      ECONNREFUSED: 'Connection refused: nothing is listening on that port',
      ECONNRESET: 'Connection reset by the terminal',
      EPIPE: 'Broken pipe',
      EHOSTUNREACH: 'No route to host',
      ENETUNREACH: 'Network is unreachable',
      ENOTFOUND: 'Host name not found',
      EAI_AGAIN: 'Host name could not be resolved',
      EADDRNOTAVAIL: 'Address not available',
    };
    const code = error.code ?? '';
    if (known[code] !== undefined) return `${known[code]} (${code})`;
    return error.message !== '' ? error.message : fallback;
  }
}
