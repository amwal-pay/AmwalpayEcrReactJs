import type {
  CloseReceiptView, ConfigView, KeyKind, LogView, MetaView, SettingsView, TerminalForm, TerminalListView,
  TerminalView, TransactionForm, TransactionView,
} from './types.js';

/** A request to the till server failed. `status` is 0 when the server could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: any;

  constructor(status: number, body: any) {
    super(body?.error ?? body?.message ?? (status === 0 ? 'The app could not be reached' : `Request failed (${status})`));
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** Per-field messages of a 422, keyed like the form's fields. */
  get fields(): Record<string, string> {
    return this.body?.errors ?? {};
  }
}

export interface EcrClientOptions {
  /** Prefix for every route, e.g. `https://till.local`. Default: same origin. */
  baseUrl?: string;
  /** The fetch to use. Default: the global one. */
  fetch?: typeof fetch;
}

/** The till server's API, route for route. */
export interface EcrClient {
  meta(): Promise<MetaView>;
  terminals(): Promise<TerminalListView>;
  addTerminal(form: TerminalForm): Promise<TerminalView>;
  saveTerminal(serial: string, form: TerminalForm): Promise<TerminalView>;
  deleteTerminal(serial: string): Promise<null>;
  config(serial: string, announce?: boolean): Promise<ConfigView>;
  settings(): Promise<SettingsView>;
  setEnvironment(environment: string): Promise<SettingsView>;
  setKey(kind: KeyKind, value: string): Promise<SettingsView>;
  clearKey(kind: KeyKind): Promise<SettingsView>;
  pending(): Promise<{ transactions: TransactionView[] }>;
  start(form: TransactionForm): Promise<TransactionView>;
  transaction(id: string): Promise<TransactionView>;
  cancel(id: string): Promise<TransactionView>;
  inquire(id: string): Promise<TransactionView>;
  receipt(id: string): Promise<TransactionView>;
  closeReceipt(id: string): Promise<CloseReceiptView>;
  acknowledge(id: string): Promise<null>;
  log(): Promise<LogView>;
  clearLog(): Promise<null>;
  /** The URL of the QR image (SVG) the server draws for `text`. */
  qrUrl(text: string): string;
}

const enc = encodeURIComponent;

/** The URL of the QR image the server draws for `text`, on the same origin. */
export function qrUrl(text: string, baseUrl = ''): string {
  return `${baseUrl}/api/qr?text=${enc(text)}`;
}

/**
 * A client for the till server. Mutating calls are always JSON, even with
 * nothing to say: the server refuses anything else, which is what stops another
 * site's form from driving it.
 */
export function createEcrClient(options: EcrClientOptions = {}): EcrClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request<T>(method: string, url: string, body?: unknown, { keepalive = false } = {}): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(baseUrl + url, {
        method,
        headers: method === 'GET'
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive,
      });
    } catch {
      throw new ApiError(0, null);
    }
    if (response.status === 204) return null as T;
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, data);
    return data as T;
  }

  return {
    meta: () => request('GET', '/api/meta'),
    terminals: () => request('GET', '/api/terminals'),
    addTerminal: (form) => request('POST', '/api/terminals', form),
    saveTerminal: (serial, form) => request('PUT', `/api/terminals/${enc(serial)}`, form),
    deleteTerminal: (serial) => request('DELETE', `/api/terminals/${enc(serial)}`),
    config: (serial, announce = false) => request('GET', `/api/terminals/${enc(serial)}/config${announce ? '?announce=true' : ''}`),
    settings: () => request('GET', '/api/settings'),
    setEnvironment: (environment) => request('PUT', '/api/settings/environment', { environment }),
    setKey: (kind, value) => request('PUT', `/api/settings/keys/${enc(kind)}`, { value }),
    clearKey: (kind) => request('DELETE', `/api/settings/keys/${enc(kind)}`),
    pending: () => request('GET', '/api/transactions'),
    start: (form) => request('POST', '/api/transactions', form),
    transaction: (id) => request('GET', `/api/transactions/${enc(id)}`),
    cancel: (id) => request('POST', `/api/transactions/${enc(id)}/cancel`),
    inquire: (id) => request('POST', `/api/transactions/${enc(id)}/inquire`),
    receipt: (id) => request('POST', `/api/transactions/${enc(id)}/receipt`),
    closeReceipt: (id) => request('POST', `/api/transactions/${enc(id)}/close-receipt`),
    // keepalive: the acknowledgement must still go out if the page is closed or reloaded right after.
    acknowledge: (id) => request('DELETE', `/api/transactions/${enc(id)}`, undefined, { keepalive: true }),
    log: () => request('GET', '/api/log'),
    clearLog: () => request('DELETE', '/api/log'),
    qrUrl: (text) => qrUrl(text, baseUrl),
  };
}
