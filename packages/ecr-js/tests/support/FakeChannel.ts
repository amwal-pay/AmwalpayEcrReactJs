import { EcrIOException, type EcrChannel } from '../../src/channel/EcrChannel.js';

type Script = (body: string, connection: number) => string | null | Promise<string | null>;

/**
 * A scripted channel, so terminal logic runs without a socket.
 *
 * The script sees each request as text plus the zero-based number of the
 * exchange and returns the answer body. Returning null is a connection dropped
 * without a reply, which is how a Wi-Fi failure looks from the till; the script
 * may also throw anything a real channel could.
 */
export class FakeChannel implements EcrChannel {
  static readonly DROPPED = 'Terminal closed the connection while sending the response header';

  readonly requests: string[] = [];
  readonly timeouts: number[] = [];
  probeError: string | null = null;

  constructor(private readonly script: Script) {}

  static always(answer: string | null): FakeChannel {
    return new FakeChannel(() => answer);
  }

  endpoint(): string {
    return 'fake:9100';
  }

  host(): string {
    return 'fake';
  }

  port(): number {
    return 9100;
  }

  async probe(_timeout: number): Promise<string | null> {
    return this.probeError;
  }

  async exchange(body: string, timeout: number): Promise<string> {
    const connection = this.requests.length;
    this.requests.push(body);
    this.timeouts.push(timeout);
    const reply = await this.script(body, connection);
    if (reply === null) throw new EcrIOException(FakeChannel.DROPPED);
    return reply;
  }
}
