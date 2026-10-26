import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SERIAL, sleep, WebExample } from './harness.js';

/**
 * Server-owned transactions end to end, through server tasks and the signed
 * fake terminal: what the web sample's FormValidationTests,
 * TransactionLifecycleTests and ReceiptTests pin.
 */
describe('transaction lifecycle', () => {
  let web;
  beforeEach(async () => {
    web = await new WebExample().start();
  });
  afterEach(async () => {
    await web.stop();
  });

  test("form errors are Core's messages and nothing starts", async () => {
    await web.registerWifi();
    const errors = async (form) => (await web.call('POST', '/api/transactions', { terminalSerial: SERIAL, ...form })).json.errors ?? {};

    expect(await errors({ type: 'Sale', amountDigits: '' })).toEqual({ amount: 'Required field' });
    expect(await errors({ type: 'Sale', amountDigits: '9' })).toEqual({ amount: 'minimum amount allowed is 0.010' });
    expect(await errors({ type: 'Sale', amountDigits: '1000', merchantReference: 'A B' })).toEqual({ merchantReference: "Use printable ASCII without spaces, '&' or '='" });
    expect(await errors({ type: 'Sale', amountDigits: '1000', merchantReference: 'X'.repeat(33) })).toEqual({ merchantReference: 'A merchant reference is at most 32 characters' });
    expect(await errors({ type: 'Void', receiptNumber: 'ab' })).toEqual({ receiptNumber: 'Enter the receipt number of the transaction to act on' });
    expect(await errors({ type: 'Void', receiptNumber: '24', useOtherTerminal: true })).toEqual({ originalTerminalId: 'Enter the terminal the original was taken on' });
    expect(await errors({ type: 'Inquiry', lookUpByReference: true })).toEqual({ originalReference: 'Enter the reference the transaction was sent with' });
    expect(await errors({ type: 'Settlement' })).toEqual({ type: 'Choose a transaction type' });
    expect((await web.call('POST', '/api/transactions', { type: 'Sale' })).json.errors).toEqual({ terminal: 'Choose a POS terminal' });
    expect((await web.call('POST', '/api/transactions', { terminalSerial: 'GONE', type: 'Sale' })).json.errors).toEqual({ terminal: 'Terminal GONE is no longer registered' });
    expect((await web.call('GET', '/api/transactions')).json.transactions).toEqual([]);
  });

  test('a plan that is not ready refuses to start with its issues', async () => {
    await web.call('POST', '/api/terminals', { name: 'Demo', serialNumber: SERIAL, ecrMode: 2, ipAddress: '127.0.0.1' });

    const refused = await web.call('POST', '/api/transactions', { terminalSerial: SERIAL, type: 'Sale', amountDigits: '1000' });

    expect(refused.status).toBe(422);
    expect(refused.json.errors).toEqual({});
    expect(refused.json.message).toBe('Wi-Fi/CABLE secure hash key is not configured');
  });

  test('an approved sale carries the dialog and can close the receipt', async () => {
    await web.registerWifi();

    const started = await web.startRun({ type: 'Sale', amountDigits: '1234', merchantReference: 'ORDER-1001' });
    expect(started.state).toBe('checking');
    expect(started.busy).toBe(true);
    expect(started.statusText).toBe('Checking the terminal…');
    expect(started.timeoutSeconds).toBe(120);
    expect(Number.isInteger(started.remainingSeconds)).toBe(true);

    const done = await web.settle(started.id);
    expect(done.state).toBe('completed');
    expect(done.version).toBeGreaterThan(started.version);
    expect(done.remainingSeconds).toBeNull();
    const dialog = done.dialog;
    expect(dialog.headline).toBe('Approved');
    expect(dialog.tone).toBe('approved');
    expect(dialog.amount).toBe('1.234');
    expect(dialog.fields.map((f) => f.label)).toEqual(['Auth code', 'Card', 'Reference']);
    expect(dialog.fields[2].value).toBe('ORDER-1001');
    expect(dialog.canCloseReceipt).toBe(true);
    expect(dialog.rawPayload).toContain('"success": true');
    expect(Object.keys(dialog)).toEqual([
      'headline', 'tone', 'amount', 'message', 'note', 'fields', 'hints', 'rawPayload', 'isUnknownOutcome', 'inquirableReference',
      'unknownOutcomeWarning', 'offersReceipt', 'receiptNote', 'receipt', 'canCloseReceipt',
    ]);

    const closed = await web.call('POST', `/api/transactions/${started.id}/close-receipt`);
    expect(closed.json.message).toBe('Terminal is back on its idle screen');
    expect(closed.json.transaction.state, 'closing the receipt leaves the dialog open').toBe('completed');

    expect((await web.call('DELETE', `/api/transactions/${started.id}`)).status).toBe(204);
    expect((await web.call('GET', `/api/transactions/${started.id}`)).status).toBe(404);
    expect((await web.call('DELETE', `/api/transactions/${started.id}`)).status, 'acknowledging twice is fine').toBe(204);
  });

  test('a blank reference is generated and a decline is a decline', async () => {
    await web.registerWifi(SERIAL, ['--decline', '51']);

    const done = await web.settle((await web.startRun({ type: 'Sale', amountDigits: '1000' })).id);

    expect(done.state).toBe('completed');
    expect(done.dialog.headline).toBe('Declined');
    expect(done.dialog.message).toBe('Declined by the issuer (51)');
    expect(done.dialog.isUnknownOutcome).toBe(false);
    expect(await web.log()).toMatch(/"merchantReference":"[0-9A-F]{12}"/);
  });

  test('a partial approval is called out', async () => {
    await web.registerWifi(SERIAL, ['--partial']);

    const { dialog } = await web.settle((await web.startRun({ type: 'Sale', amountDigits: '961100' })).id);

    expect(dialog.headline).toBe('Partially approved');
    expect(dialog.amount).toBe('480.550');
    expect(dialog.message).toBe('Only 480.550 of 961.100 was approved. Collect the difference by another means.');
  });

  test('an unreachable terminal is not completed and not unknown', async () => {
    await web.call('POST', '/api/terminals', { name: 'Off', serialNumber: SERIAL, ecrMode: 2, ipAddress: '127.0.0.1', port: '1' });
    await web.call('PUT', '/api/settings/keys/wifi', { value: '0123456789ABCDEF0123456789ABCDEF' });

    const { dialog } = await web.settle((await web.startRun({ type: 'Sale', amountDigits: '1000' })).id);

    expect(dialog.headline).toBe('Not completed');
    expect(dialog.isUnknownOutcome).toBe(false);
    expect(dialog.message).toContain('127.0.0.1:1 is not reachable');
  });

  test('a lost answer is recovered by the automatic inquiry', async () => {
    await web.registerWifi(SERIAL, ['--drop-sale']);

    const done = await web.settle((await web.startRun({ type: 'Sale', amountDigits: '2500', merchantReference: 'ORDER-2' })).id);

    expect(done.state).toBe('inquired');
    expect(done.dialog.headline).toBe('Approved');
    expect(done.dialog.note).toBe("The terminal's answer to this request was lost, but it was asked automatically and knows this transaction. Do not send it again.");
  });

  test('a lost answer and a lost follow-up offer only an inquiry, on the same run', async () => {
    const terminal = await web.registerWifi(SERIAL, ['--drop-sale', '--drop-first-inquiry']);
    const { id } = await web.startRun({ type: 'Sale', amountDigits: '3000', merchantReference: 'ORDER-3' });

    const unknown = await web.settle(id);
    expect(unknown.state).toBe('failed');
    expect(unknown.dialog.headline).toBe('Outcome unknown');
    expect(unknown.dialog.isUnknownOutcome).toBe(true);
    expect(unknown.dialog.inquirableReference).toBe('ORDER-3');
    expect(unknown.dialog.unknownOutcomeWarning.startsWith('The transaction may have completed.')).toBe(true);

    const inquiry = await web.call('POST', `/api/transactions/${id}/inquire`);
    expect(inquiry.status).toBe(202);
    expect(inquiry.json.id, 'the same run').toBe(id);
    expect(inquiry.json.operation).toBe('Inquiry');

    const found = await web.settle(id);
    expect(found.state).toBe('inquired');
    expect(found.dialog.headline).toBe('Approved');
    expect((await web.call('POST', `/api/transactions/${id}/inquire`)).status, 'no unknown outcome left to look up').toBe(409);
    expect(terminal.output.split('"messageType":"SALE"').length - 1, 'exactly one sale reached the terminal').toBe(1);
  });

  test('cancel is an unknown outcome, never "cancelled"', async () => {
    await web.registerWifi(SERIAL, ['--delay', '5']);
    const { id } = await web.startRun({ type: 'Sale', amountDigits: '700' });
    const deadline = Date.now() + 10_000;
    let view;
    do {
      view = (await web.call('GET', `/api/transactions/${id}`)).json;
      await sleep(100);
    } while (view.state !== 'inProgress' && Date.now() < deadline);

    const cancelled = (await web.call('POST', `/api/transactions/${id}/cancel`)).json;

    expect(cancelled.state).toBe('failed');
    expect(cancelled.dialog.headline).toBe('Outcome unknown');
    expect(cancelled.dialog.message.startsWith('You stopped waiting for the terminal.')).toBe(true);
    expect(cancelled.dialog.inquirableReference).toMatch(/^[0-9A-F]{12}$/);
    await sleep(6000);
    expect((await web.call('GET', `/api/transactions/${id}`)).json.version, 'the late answer does not overwrite it').toBe(cancelled.version);
  });

  test('one running transaction per terminal, but terminals run side by side', async () => {
    await web.registerWifi(SERIAL, ['--delay', '3']);
    await web.registerWifi('TW-OTHER', ['--delay', '3']);

    const first = await web.startRun({ type: 'Sale', amountDigits: '1000' });
    const second = await web.call('POST', '/api/transactions', { terminalSerial: SERIAL, type: 'Sale', amountDigits: '1000' });
    const other = await web.call('POST', '/api/transactions', { terminalSerial: 'TW-OTHER', type: 'Sale', amountDigits: '1000' });

    expect(second.status).toBe(409);
    expect(second.json.error).toBe('A transaction is already running on this terminal');
    expect(second.json.transactionId).toBe(first.id);
    expect(other.status).toBe(202);
    expect((await web.call('DELETE', `/api/transactions/${first.id}`)).status, 'a running transaction cannot be dismissed').toBe(409);

    const pending = (await web.call('GET', '/api/transactions')).json.transactions;
    expect(pending.map((t) => t.id), 'newest first, for a reloaded page').toEqual([other.json.id, first.id]);
    expect((await web.settle(first.id)).state).toBe('completed');
    expect((await web.settle(other.json.id)).state).toBe('completed');
  });

  test('concurrent starts on one terminal let exactly one through', async () => {
    await web.registerWifi(SERIAL, ['--delay', '2']);
    const body = JSON.stringify({ terminalSerial: SERIAL, type: 'Sale', amountDigits: '1000' });
    const post = () => new Promise((resolve, reject) => {
      const req = request(`${web.base}/api/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(body);
    });

    const codes = await Promise.all(Array.from({ length: 8 }, post));

    expect(codes.filter((c) => c === 202), JSON.stringify(codes)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(7);
  });

  test('an inquiry finds the sale and its receipt is a QR code', async () => {
    await web.registerWifi();
    const sale = await web.settle((await web.startRun({ type: 'Sale', amountDigits: '1234', merchantReference: 'ORDER-R' })).id);
    await web.call('DELETE', `/api/transactions/${sale.id}`);

    const { id } = await web.startRun({ type: 'Inquiry', lookUpByReference: true, originalReference: 'ORDER-R' });
    const found = await web.settle(id);
    expect(found.state).toBe('inquired');
    expect(found.dialog.fields.map((f) => f.label)).toEqual(['Receipt number', 'Type', 'Card', 'Date/Time']);
    expect(found.dialog.hints).toContain('Can be voided');
    expect(found.dialog.receipt.showButton).toBe(true);
    expect(found.dialog.canCloseReceipt).toBe(false);

    expect((await web.call('POST', `/api/transactions/${id}/receipt`)).status).toBe(202);
    const { receipt } = (await web.settle(id)).dialog;
    expect(receipt.url.startsWith('https://example.invalid/receipt?stan=')).toBe(true);
    expect(receipt.showButton).toBe(false);
    expect((await web.call('POST', `/api/transactions/${id}/receipt`)).status, 'already has one').toBe(409);

    const qr = await web.call('GET', '/api/qr?text=' + encodeURIComponent(receipt.url));
    expect(qr.status).toBe(200);
    expect(qr.headers['content-type']).toBe('image/svg+xml');
    expect(qr.body).toContain('<svg');
    expect((await web.call('GET', '/api/qr?text=')).status).toBe(400);
    expect((await web.call('GET', '/api/qr?text=' + 'a'.repeat(1025))).status).toBe(400);
  });

  test('void and refund run with their own fields', async () => {
    const terminal = await web.registerWifi();

    const voided = await web.settle((await web.startRun({ type: 'Void', receiptNumber: '24', useOtherTerminal: true, originalTerminalId: '30001' })).id);
    const refund = await web.settle((await web.startRun({ type: 'Refund', amountDigits: '500', receiptNumber: '24', originalDate: '2026-10-20' })).id);

    expect(voided.dialog.headline).toBe('Approved');
    expect(voided.dialog.fields.map((f) => f.label), 'a void has no authorisation of its own').not.toContain('Auth code');
    expect(refund.dialog.headline).toBe('Approved');
    expect(terminal.output).toContain('"originalTerminalId":"30001"');
    expect(terminal.output).toContain('"originalTransactionDate":"20261020"');
  });

  test('the log shows the traffic but never the key, and can be cleared', async () => {
    await web.registerWifi();
    await web.settle((await web.startRun({ type: 'Sale', amountDigits: '1234' })).id);

    const log = (await web.call('GET', '/api/log')).json;

    expect(log.capacity).toBe(500);
    expect(log.count).toBeGreaterThan(5);
    expect(log.text).toContain('Ecr Sending SALE');
    expect(log.text).toContain('483312******1234');
    expect(log.text.toLowerCase()).not.toContain('0123456789abcdef0123456789abcdef');
    expect(log.text).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} Ecr /m);
    expect((await web.call('DELETE', '/api/log')).status).toBe(204);
    expect((await web.call('GET', '/api/log')).json.count).toBe(0);
  });
});
