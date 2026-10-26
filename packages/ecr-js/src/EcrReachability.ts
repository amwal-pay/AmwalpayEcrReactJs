/**
 * Whether the terminal's ECR port answers a connection. It proves the port is
 * open, not that the terminal is idle: a terminal already taking a payment
 * answers too.
 */
export class EcrReachability {
  readonly endpoint: string;

  constructor(
    readonly reachable: boolean,
    readonly host: string,
    readonly port: number,
    readonly error: string | null = null,
    endpoint: string | null = null,
  ) {
    this.endpoint = endpoint ?? (port > 0 ? `${host}:${port}` : host);
  }

  toJSON(): { reachable: boolean; host: string; port: number; error: string | null; endpoint: string } {
    return { reachable: this.reachable, host: this.host, port: this.port, error: this.error, endpoint: this.endpoint };
  }
}
