import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EXAMPLE, SERIAL, WebExample } from './harness.js';

/** The web sample's SecurityTests: headers, the /api guard, and the page's rendering rules. */
describe('security', () => {
  let web;
  beforeEach(async () => {
    web = await new WebExample().start();
  });
  afterEach(async () => {
    await web.stop();
  });

  test('every response carries the security headers, and /api is never cached', async () => {
    const page = await web.call('GET', '/');
    const api = await web.call('GET', '/api/meta');

    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>Amwal ECR Example</title>');
    for (const response of [page, api]) {
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    }
    expect(api.headers['cache-control']).toBe('no-store');
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1];
    expect(script, 'the page loads its script from the server').toBeDefined();
    expect((await web.call('GET', script)).status).toBe(200);
    expect((await web.call('GET', '/../package.json')).status).toBe(404);
  });

  test('cross-origin and non-JSON calls are refused, and nothing reaches the terminal', async () => {
    const terminal = await web.registerWifi();
    const form = JSON.stringify({ terminalSerial: SERIAL, type: 'Sale', amountDigits: '1000' });

    expect((await web.raw('POST', '/api/transactions', form, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await web.raw('POST', '/api/transactions', 'terminalSerial=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    const foreign = await web.raw('POST', '/api/transactions', form, { 'Content-Type': 'application/json', Origin: 'http://evil.example' });
    expect(foreign.status).toBe(403);
    expect(foreign.json).toEqual({ error: 'Cross-origin requests are not accepted' });
    expect((await web.raw('POST', '/api/transactions', form, { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await web.raw('GET', '/', null, { Host: 'evil.example' })).status, 'DNS rebinding').toBe(400);
    expect((await web.raw('POST', '/api/transactions', '{not json', { 'Content-Type': 'application/json' })).status).toBe(400);
    expect((await web.raw('POST', '/api/terminals', ' '.repeat(70_000) + '{}', { 'Content-Type': 'application/json' })).status).toBe(413);

    expect((await web.call('GET', '/api/transactions')).json.transactions).toEqual([]);
    expect(terminal.output).not.toContain('"messageType":"SALE"');
  });

  test('an unknown API path is a JSON 404', async () => {
    const response = await web.call('GET', '/api/nothing');

    expect(response.status).toBe(404);
    expect(response.json.error).toBe('No such endpoint');
  });

  test('the page has no inline script, style, handlers or markup injection', () => {
    const source = join(EXAMPLE, 'web');
    const files = [join(source, 'index.html'), ...walk(join(source, 'src'))].filter((f) => existsSync(f) && /\.(html|tsx?|jsx?|css)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', 'eval(', 'onclick="', 'style="', 'style={', '<script>']) {
        expect(text.includes(forbidden), `${file} contains ${forbidden}`).toBe(false);
      }
      expect(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(text), `${file} loads something from the network`).toBe(false);
    }
  });
});

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
