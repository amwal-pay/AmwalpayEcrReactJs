import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { DataPaths } from '../server/web/DataPaths.js';
import { EcrApp } from '../server/web/EcrApp.js';
import { FrontController } from '../server/web/FrontController.js';

export const KEY = '0123456789ABCDEF0123456789ABCDEF';
export const SERIAL = 'TW1234567890';

const here = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE = join(here, '..');
export const REPOSITORY = join(EXAMPLE, '..');

/**
 * Hosts the example web till for real: Node's HTTP server on a temp data
 * folder, transactions as server tasks, against the signed fake terminal in
 * tools/. Each test gets its own server, folder and terminals, like the web
 * sample's Harness and the PHP sample's WebExampleTestCase.
 */
export class WebExample {
  terminals = [];

  async start() {
    this.dataDir = join(tmpdir(), 'ecr-example-' + randomBytes(5).toString('hex'));
    this.app = new EcrApp(new DataPaths(this.dataDir));
    this.server = createServer(new FrontController(publicDirectory(), this.app).listener());
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async stop() {
    for (const terminal of this.terminals) terminal.stop();
    await new Promise((resolve) => this.server.close(resolve));
    // Tasks may still be finishing; let them, before the folder goes.
    await this.app.registry.idle();
    rmSync(this.dataDir, { recursive: true, force: true });
  }

  /** Starts a signed fake terminal and returns it. */
  async fakeTerminal(flags = []) {
    const terminal = await FakeTerminal.start(flags);
    this.terminals.push(terminal);
    return terminal;
  }

  /** Registers a Wi-Fi terminal on a fresh fake and saves the Wi-Fi key. */
  async registerWifi(serial = SERIAL, flags = []) {
    const terminal = await this.fakeTerminal(flags);
    const response = await this.call('POST', '/api/terminals', {
      name: 'Demo', serialNumber: serial, ecrMode: 2, ipAddress: '127.0.0.1', port: String(terminal.port),
    });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect((await this.call('PUT', '/api/settings/keys/wifi', { value: KEY })).status).toBe(200);
    return terminal;
  }

  /** What the browser sends: JSON on every mutating call. */
  call(method, path, body = null, headers = {}) {
    const mutating = method !== 'GET';
    return this.raw(method, path, mutating ? JSON.stringify(body ?? {}) : null, mutating ? { 'Content-Type': 'application/json', ...headers } : headers);
  }

  async raw(method, path, payload, headers = {}) {
    const url = new URL(this.base + path);
    // fetch() will not send a Host header of our choosing; node:http will.
    const { request } = await import('node:http');
    return new Promise((resolve, reject) => {
      const req = request(url, { method, headers: { ...headers, ...(payload !== null ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, body, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  /** The 202 view of a started run. */
  async startRun(form, serial = SERIAL) {
    const response = await this.call('POST', '/api/transactions', { terminalSerial: serial, ...form });
    expect(response.status, response.body).toBe(202);
    return response.json;
  }

  /** Polls until the run is no longer busy (or fetching a receipt). */
  async settle(id, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let view;
    do {
      view = (await this.call('GET', `/api/transactions/${id}`)).json;
      if (!view.busy && !(view.dialog?.receipt?.fetching ?? false)) return view;
      await sleep(150);
    } while (Date.now() < deadline);
    throw new Error('The run did not finish: ' + JSON.stringify(view));
  }

  async log() {
    return String((await this.call('GET', '/api/log')).json.text);
  }
}

/** tools/fake-pos-server.mjs as a child process, on a free port. */
export class FakeTerminal {
  output = '';

  static start(flags = []) {
    const terminal = new FakeTerminal();
    terminal.child = spawn(process.execPath, [join(REPOSITORY, 'tools', 'fake-pos-server.mjs'), '--key', KEY, '--port', '0', ...flags], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The fake terminal did not start: ' + terminal.output)), 15_000);
      const read = (chunk) => {
        terminal.output += chunk.toString('utf8');
        const m = /LISTENING [^\s:]+:(\d+)/.exec(terminal.output);
        if (m !== null && terminal.port === undefined) {
          terminal.port = Number(m[1]);
          clearTimeout(timer);
          resolve(terminal);
        }
      };
      terminal.child.stdout.on('data', read);
      terminal.child.stderr.on('data', read);
      terminal.child.on('exit', () => reject(new Error('The fake terminal exited: ' + terminal.output)));
    });
  }

  stop() {
    this.child.kill();
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The built page when there is one; otherwise a stand-in, so the API tests do not need a Vite build. */
function publicDirectory() {
  const built = join(EXAMPLE, 'web', 'dist');
  if (existsSync(join(built, 'index.html'))) return built;
  const stub = join(tmpdir(), 'ecr-example-public-stub');
  mkdirSync(join(stub, 'assets'), { recursive: true });
  writeFileSync(join(stub, 'index.html'), '<!doctype html><title>Amwal ECR Example</title><script type="module" src="/assets/app.js"></script>');
  writeFileSync(join(stub, 'assets', 'app.js'), 'export {};');
  return stub;
}
