import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EcrApp } from '../server/web/EcrApp.js';
import { DataPaths } from '../server/web/DataPaths.js';
import { KEY, WebExample } from './harness.js';

/**
 * Terminals, settings, the config card and meta: what the web sample's
 * TerminalTests, SettingsTests, ConfigCardTests and MetaTests pin.
 */
describe('terminals, settings and meta', () => {
  let web;
  beforeEach(async () => {
    web = await new WebExample().start();
  });
  afterEach(async () => {
    await web.stop();
  });

  test('terminals are added, edited and deleted by serial, and survive a restart', async () => {
    const added = await web.call('POST', '/api/terminals', { name: 'Till 1', serialNumber: 'SN-1', ecrMode: 2, ipAddress: '192.168.1.50', port: '' });
    expect(added.status).toBe(200);
    expect(added.json.port, 'blank port is the standard 9100').toBe(9100);
    expect(added.json.connectionSummary).toBe('192.168.1.50:9100');
    expect(added.json.displayName).toBe('Till 1 (SN-1)');

    const edited = await web.call('PUT', '/api/terminals/SN-1', { name: 'Till 1b', serialNumber: 'SN-2', ecrMode: 4, merchantId: '10001', terminalId: '20002' });
    expect(edited.status).toBe(200);
    expect(edited.json.connectionSummary).toBe('Merchant 10001 · Terminal 20002');
    expect(edited.json.port).toBe(0);

    const list = (await web.call('GET', '/api/terminals')).json.terminals;
    expect(list.map((t) => t.serialNumber), 'changing the serial replaces the entry').toEqual(['SN-2']);
    expect(existsSync(join(web.dataDir, 'terminals.json'))).toBe(true);
    expect(new EcrApp(new DataPaths(web.dataDir)).terminals.getAll().map((t) => t.serialNumber), 'a restarted server reads them back').toEqual(['SN-2']);
    expect((await web.call('PUT', '/api/terminals/SN-1', { name: 'x', serialNumber: 'x', ecrMode: 2 })).status).toBe(404);
    expect((await web.call('DELETE', '/api/terminals/SN-2')).status).toBe(204);
    expect((await web.call('DELETE', '/api/terminals/SN-2')).status).toBe(404);
    expect((await web.call('GET', '/api/terminals')).json.terminals).toEqual([]);
  });

  test("the editor's messages are the Windows samples' messages", async () => {
    const empty = await web.call('POST', '/api/terminals', { ecrMode: 2, ipAddress: '300.1.1.1', port: '70000' });
    expect(empty.status).toBe(422);
    expect(empty.json.errors).toEqual({
      name: 'Enter a terminal name',
      serial: 'Enter the terminal serial number',
      ip: 'Enter a valid IPv4 address, for example 192.168.1.50',
      port: 'Port must be between 1 and 65535',
    });

    const ws = await web.call('POST', '/api/terminals', { name: 'W', serialNumber: 'W1', ecrMode: 4, merchantId: 'M1', terminalId: '' });
    expect(ws.json.errors).toEqual({ terminalId: 'Enter the backend terminal ID', merchantId: 'The merchant ID must be numeric' });
    expect((await web.call('POST', '/api/terminals', { name: 'x', serialNumber: 'x', ecrMode: 9 })).json.errors).toEqual({ mode: 'Choose an ECR mode' });

    await web.call('POST', '/api/terminals', { name: 'A', serialNumber: 'DUP', ecrMode: 2, ipAddress: '10.0.0.1' });
    const dup = await web.call('POST', '/api/terminals', { name: 'B', serialNumber: 'DUP', ecrMode: 2, ipAddress: '10.0.0.2' });
    expect(dup.json.errors).toEqual({ serial: 'A terminal with this serial number already exists' });
  });

  test('settings start unconfigured on SIT, and a key is never echoed', async () => {
    const settings = (await web.call('GET', '/api/settings')).json;
    expect(settings.environment).toBe('SIT');
    expect(settings.wifi).toEqual({ label: 'Wi-Fi/CABLE secure hash key', configured: false });
    expect(settings.webService).toEqual({ label: 'Web Service secure hash key', configured: false });

    const saved = await web.call('PUT', '/api/settings/keys/wifi', { value: ` ${KEY} ` });
    expect(saved.status).toBe(200);
    expect(saved.json.wifi.configured).toBe(true);
    expect(saved.json.webService.configured, 'two independent keys').toBe(false);
    expect(saved.body).not.toContain(KEY);
    expect((await web.call('GET', '/api/settings')).body).not.toContain(KEY);

    expect((await web.call('PUT', '/api/settings/keys/wifi', { value: ' ' })).json.errors).toEqual({ value: 'Enter the key, or use Clear to remove it' });
    expect((await web.call('PUT', '/api/settings/keys/webService', { value: 'abc' })).json.errors).toEqual({ value: 'Must be an even-length hex string of at least 16 characters' });
    expect((await web.call('PUT', '/api/settings/keys/usb', { value: KEY })).status).toBe(404);

    expect((await web.call('PUT', '/api/settings/environment', { environment: 'uat' })).json.environment).toBe('UAT');
    expect((await web.call('PUT', '/api/settings/environment', { environment: 'LIVE' })).json.errors).toEqual({ environment: 'Choose SIT, UAT or PROD' });

    // Stored encrypted, and readable again by a fresh server.
    const file = readFileSync(join(web.dataDir, 'settings.dat')).toString('latin1');
    expect(file.toLowerCase()).not.toContain(KEY.toLowerCase());
    expect(file).not.toContain('wifiSecureHashKey');
    expect(new EcrApp(new DataPaths(web.dataDir)).settings.wifiSecureHashKey()).toBe(KEY);

    expect((await web.call('DELETE', '/api/settings/keys/wifi')).json.wifi.configured).toBe(false);
  });

  test('a lost key file is a notice, and the keys must be entered again', async () => {
    await web.call('PUT', '/api/settings/keys/wifi', { value: KEY });
    unlinkSync(join(web.dataDir, 'keys', 'settings.key'));

    // The PHP sample reads the file on every request; a Node server reads it at start-up.
    const restarted = new EcrApp(new DataPaths(web.dataDir));

    expect(restarted.settings.wifiSecureHashKey()).toBe('');
    expect(String(restarted.settings.loadWarning)).toContain('Enter the signing keys again');
  });

  test('the config card shows the plan before anyone pays', async () => {
    await web.call('POST', '/api/terminals', { name: 'Hub', serialNumber: 'WS-1', ecrMode: 4, merchantId: '10001', terminalId: '20002' });
    await web.call('POST', '/api/terminals', { name: 'Cable', serialNumber: 'USB-1', ecrMode: 1 });

    const ws = (await web.call('GET', '/api/terminals/WS-1/config')).json;
    expect(ws.transportLabel).toBe('HTTPS Web Service (JSON HMAC)');
    expect(ws.connectionSummary).toBe('SIT · merchant 10001 · terminal 20002');
    expect(ws.keyLabel).toBe('Web Service secure hash key');
    expect(ws.keyStatus).toBe('not configured — set in Settings');
    expect(ws.isReady).toBe(false);
    expect(ws.issues).toContain('Web Service secure hash key is not configured');

    await web.call('PUT', '/api/settings/keys/webService', { value: 'b'.repeat(64) });
    const ready = (await web.call('GET', '/api/terminals/WS-1/config?announce=true')).json;
    expect(ready.isReady).toBe(true);
    expect(ready.keyStatus).toBe('configured');
    expect(await web.log()).toContain('[Web Service] selected WS-1 (Web Service)');

    const usb = (await web.call('GET', '/api/terminals/USB-1/config')).json;
    expect(usb.isSupported).toBe(false);
    expect(usb.issues).toContain('USB Cable is not supported in this sample');
    expect((await web.call('GET', '/api/terminals/NOPE/config')).status).toBe(404);
  });

  test('meta carries the SDK flags, the form layouts and the limits', async () => {
    const meta = (await web.call('GET', '/api/meta')).json;

    expect(meta.operations.map((o) => o.value)).toEqual(['Sale', 'Void', 'Refund', 'Inquiry']);
    const [sale, voided, refund, inquiry] = meta.operations;
    expect(sale.movesMoney).toBe(true);
    expect(sale.layouts['00'].merchantReference).toBe(true);
    expect(voided.amountHelp).toBe("Uses the original transaction's amount");
    expect(voided.layouts['10'].originalTerminal).toBe(true);
    expect(voided.layouts['00'].originalTerminal).toBe(false);
    expect(refund.layouts['00'].originalDate).toBe(true);
    expect(inquiry.startButtonText).toBe('Look up transaction');
    expect(inquiry.layouts['01'].originalReference).toBe(true);
    expect(inquiry.layouts['01'].receiptNumber, 'the receipt number gives way to the reference').toBe(false);
    expect(inquiry.layouts['01'].originalDate).toBe(false);

    expect(meta.modes.map((m) => m.value)).toEqual([1, 2, 3, 4]);
    expect(meta.modes.map((m) => m.supported)).toEqual([false, true, false, true]);
    expect(meta.environments).toEqual(['SIT', 'UAT', 'PROD']);
    expect(meta.amount).toEqual({ min: '0.010', max: '100000.000', fractionDigits: 3, maxDigits: 9 });
    expect(meta.merchantReferenceMaxLength).toBe(32);
    expect(meta.receiptNumberMaxLength).toBe(6);
    expect(meta.defaultPort).toBe(9100);
    expect(meta.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
