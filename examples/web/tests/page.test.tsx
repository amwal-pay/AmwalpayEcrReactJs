// Renders the whole page against a fake server and drives a sale to its result dialog.
import { EcrProvider } from '@amwalpay/ecr-react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // jsdom has <dialog> but not its modal methods.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const layout = (o: Partial<Record<string, boolean>>) => ({
  amount: false, merchantReference: false, referenceSwitch: false, originalReference: false, receiptNumber: false,
  originalDate: false, otherTerminalSwitch: false, originalTerminal: false, ...o,
});
const sale = layout({ amount: true, merchantReference: true });
const meta = {
  operations: [
    { value: 'Sale', label: 'Sale', requiresAmount: true, requiresOriginalStan: false, requiresOriginalDate: false, allowsOtherTerminal: false, movesMoney: true, amountHelp: '', startButtonText: 'Start transaction', layouts: { '00': sale, '01': sale, '10': sale, '11': sale } },
    { value: 'Inquiry', label: 'Inquiry', requiresAmount: false, requiresOriginalStan: true, requiresOriginalDate: true, allowsOtherTerminal: true, movesMoney: false, amountHelp: 'An inquiry only reads; nothing is charged', startButtonText: 'Look up transaction',
      layouts: { '00': layout({ referenceSwitch: true, receiptNumber: true, originalDate: true, otherTerminalSwitch: true }), '01': layout({ referenceSwitch: true, originalReference: true, otherTerminalSwitch: true }), '10': layout({ referenceSwitch: true, receiptNumber: true, originalDate: true, otherTerminalSwitch: true, originalTerminal: true }), '11': layout({ referenceSwitch: true, originalReference: true, otherTerminalSwitch: true, originalTerminal: true }) } },
  ],
  modes: [{ value: 2, label: 'Wi‑Fi', ipBased: true, supported: true, hint: '', note: '' }, { value: 4, label: 'Web Service', ipBased: false, supported: true, hint: '', note: '' }],
  environments: ['SIT', 'UAT', 'PROD'],
  amount: { min: '0.010', max: '100000.000', fractionDigits: 3, maxDigits: 9 },
  merchantReferenceMaxLength: 32,
  receiptNumberMaxLength: 6,
  defaultPort: 9100,
  today: '2026-10-25',
};
const terminal = { serialNumber: 'SN-1', name: 'Till', ecrMode: 2, modeLabel: 'Wi‑Fi', ipAddress: '127.0.0.1', port: 19100, terminalId: '', merchantId: '', displayName: 'Till (SN-1)', connectionSummary: '127.0.0.1:19100', supported: true };
const config = { serialNumber: 'SN-1', modeLabel: 'Wi‑Fi', transportLabel: 'TCP Wi-Fi (sorted key=value HMAC)', connectionSummary: '127.0.0.1:19100', keyLabel: 'Wi-Fi/CABLE secure hash key', keyConfigured: true, keyStatus: 'configured', issues: [], isReady: true, isSupported: true, usesWebService: false };
const settings = { environment: 'SIT', wifi: { label: 'Wi-Fi/CABLE secure hash key', configured: true }, webService: { label: 'Web Service secure hash key', configured: false }, notice: null };
const id = 'a'.repeat(32);
const run = (over: Record<string, unknown>) => ({ id, terminalSerial: 'SN-1', operation: 'Sale', state: 'inProgress', busy: true, isResult: false, statusText: 'Waiting for the POS terminal…', version: 1, dialog: null, timeoutSeconds: 120, remainingSeconds: 120, ...over });
const dialog = { headline: 'Approved', tone: 'approved', amount: '2.500', message: null, note: null, fields: [{ label: 'Auth code', value: '123456' }], hints: [], rawPayload: '{"success": true}', isUnknownOutcome: false, inquirableReference: null, unknownOutcomeWarning: null, offersReceipt: false, receiptNote: null, receipt: { showButton: false, fetching: false, url: null, problem: null }, canCloseReceipt: true };

function server() {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let polls = 0;
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status });
    const path = String(url).split('?')[0];
    if (path === '/api/meta') return json(200, meta);
    if (path === '/api/terminals') return json(200, { terminals: [terminal], notice: null });
    if (path === '/api/terminals/SN-1/config') return json(200, config);
    if (path === '/api/settings') return json(200, settings);
    if (path === '/api/log') return json(200, { text: '', count: 0, capacity: 500 });
    if (path === '/api/transactions' && method === 'GET') return json(200, { transactions: [] });
    if (path === '/api/transactions' && method === 'POST') return json(202, run({ state: 'checking', statusText: 'Checking the terminal…' }));
    if (path === `/api/transactions/${id}` && method === 'GET') {
      polls++;
      return json(200, polls < 2 ? run({ version: 2 }) : run({ version: 3, state: 'completed', busy: false, isResult: true, dialog, remainingSeconds: null }));
    }
    if (path === `/api/transactions/${id}` && method === 'DELETE') return json(204, null);
    return json(404, { error: 'No such endpoint', transactionId: null });
  });
  return { fetch, calls };
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
}

describe('the page', () => {
  it('runs a sale to its result and acknowledges it on Close', async () => {
    const { fetch, calls } = server();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<EcrProvider fetch={fetch}><App /></EcrProvider>));

    const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!;
    await until(() => !!document.querySelector('#f-terminal option'));
    await until(() => !$<HTMLButtonElement>('#btn-start').disabled);
    expect(document.title).toBe('Transaction · Amwal ECR Example');
    expect($('#cfg-connection').textContent).toBe('127.0.0.1:19100');
    expect($('#view-terminals').hasAttribute('hidden')).toBe(true);

    const amount = $<HTMLInputElement>('#f-amount');
    for (const d of '2500') {
      act(() => {
        amount.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: d, bubbles: true, cancelable: true }));
      });
    }
    expect(amount.value).toBe('2.500');

    act(() => {
      $<HTMLFormElement>('#txn-form').requestSubmit();
    });
    await until(() => calls.some((c) => c.method === 'POST' && c.url === '/api/transactions'));
    const started = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    expect(started).toMatchObject({ terminalSerial: 'SN-1', type: 'Sale', amountDigits: '2500', originalDate: '2026-10-25' });

    await until(() => $('#dlg-result').hasAttribute('open'));
    expect($('#r-headline').textContent).toBe('Approved');
    expect($('#r-amount-text').textContent).toBe('2.500');
    expect($('#r-close-receipt').hasAttribute('hidden')).toBe(false);

    act(() => $<HTMLButtonElement>('#r-close').click());
    await until(() => calls.some((c) => c.method === 'DELETE' && c.url === `/api/transactions/${id}`));
    expect(amount.value).toBe('0.000');
  });

  it('shows the fatal banner when the server cannot be reached', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    act(() => root!.render(<EcrProvider fetch={fetch}><App /></EcrProvider>));
    await until(() => !document.querySelector('#fatal')!.hasAttribute('hidden'));
    expect(document.querySelector('#fatal')!.textContent).toBe('The app could not be reached. Is it still running?');
  });
});
