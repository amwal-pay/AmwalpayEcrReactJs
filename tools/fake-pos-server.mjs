#!/usr/bin/env node
/**
 * Stand-in for the POS application's Wi-Fi ECR listener, signed edition.
 *
 * A Node.js port of tools/fake-pos-server.php (itself a port of
 * AmwalpayEcrWindowsExample/Windows-Native-Example/tools/fake_pos_server_signed.py),
 * written without the SDK so it checks the SDK rather than agreeing with it:
 *
 *   - verifies the request's `secureHash` and refuses a repeated `nonce`, as the
 *     terminal does;
 *   - answers in the unified envelope { success, responseCode, message, data,
 *     errorList } and echoes the request's `nonce`;
 *   - signs the answer: HMAC-SHA256 over the sorted top-level scalar key=value
 *     pairs joined by '&' (excluding secureHash), keyed with the HEX-DECODED
 *     secret, as uppercase hex.
 *
 * Framing: a 2-byte big-endian length, then that many bytes of UTF-8 JSON.
 *
 *   node tools/fake-pos-server.mjs --key 0123456789ABCDEF0123456789ABCDEF --port 19100
 *   node tools/fake-pos-server.mjs --key <hex> --decline 51 --delay 3
 *   node tools/fake-pos-server.mjs --key <hex> --partial
 *   node tools/fake-pos-server.mjs --key <hex> --drop-sale                       lost answer, SDK recovers
 *   node tools/fake-pos-server.mjs --key <hex> --drop-sale --drop-first-inquiry  lost answer, operator inquires
 *   node tools/fake-pos-server.mjs --key <hex> --not-found
 *   node tools/fake-pos-server.mjs --key <hex> --stall-sale [--stall-seconds 30] sale not answered in time
 *   node tools/fake-pos-server.mjs --key <hex> --reset-sale                      TCP reset after the sale
 *   node tools/fake-pos-server.mjs --key <hex> --garbage-sale                    unreadable answer to the sale
 *   node tools/fake-pos-server.mjs --key <hex> --wrong-key-sale                  sale answer signed with another key
 *   node tools/fake-pos-server.mjs --key <hex> --busy                            every sale refused as busy
 *   node tools/fake-pos-server.mjs --key <hex> --answer-version 2                answers declare a newer format
 *   node tools/fake-pos-server.mjs --key <hex> --no-close-receipt                old firmware: CLOSE_RECEIPT refused
 *
 * Use a port outside 9100-9199 on a development PC (Flutter tooling listens
 * there). Register the same key as the Wi-Fi secure hash key in the till.
 * Port 0 picks a free port; the first line printed is "LISTENING <host>:<port>".
 * Connections are served one at a time, as a terminal does.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import { parseArgs } from 'node:util';

const MIN_KEY_HEX_CHARS = 16;

let parsed;
try {
  parsed = parseArgs({
    options: {
      key: { type: 'string' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '19100' },
      decline: { type: 'string' }, delay: { type: 'string', default: '0' }, 'not-found': { type: 'boolean' },
      partial: { type: 'boolean' }, 'drop-sale': { type: 'boolean' }, 'drop-first-inquiry': { type: 'boolean' },
      'stall-sale': { type: 'boolean' }, 'stall-seconds': { type: 'string', default: '30' }, 'reset-sale': { type: 'boolean' },
      'garbage-sale': { type: 'boolean' }, 'wrong-key-sale': { type: 'boolean' }, busy: { type: 'boolean' },
      'answer-version': { type: 'string' }, 'no-close-receipt': { type: 'boolean' }, 'max-connections': { type: 'string', default: '0' },
      help: { type: 'boolean' },
    },
  }).values;
} catch (error) {
  usage(error.message);
}
if (parsed.help || parsed.key === undefined) usage(null, parsed.help ? 0 : 2);

const key = parsed.key.trim();
if (key.length < MIN_KEY_HEX_CHARS || key.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(key)) {
  console.error('--key must be an even-length hex string of at least 16 characters');
  process.exit(2);
}

const options = {
  declineCode: parsed.decline ?? null,
  delay: Number(parsed.delay),
  notFound: parsed['not-found'] === true,
  partial: parsed.partial === true,
  dropSale: parsed['drop-sale'] === true,
  inquiryDropsLeft: parsed['drop-first-inquiry'] ? 1 : 0,
  stallSale: parsed['stall-sale'] === true,
  stallSeconds: Number(parsed['stall-seconds']),
  resetSale: parsed['reset-sale'] === true,
  garbageSale: parsed['garbage-sale'] === true,
  wrongKeySale: parsed['wrong-key-sale'] === true,
  busy: parsed.busy === true,
  answerVersion: parsed['answer-version'] !== undefined ? Number(parsed['answer-version']) : null,
  noCloseReceipt: parsed['no-close-receipt'] === true,
};

class FakeTerminal {
  byReference = new Map();
  seenNonces = new Set();
  nextStan = 24;

  constructor(signingKey, o) {
    this.key = signingKey;
    Object.assign(this, o);
  }

  serve(host, port, maxConnections) {
    const queue = [];
    let busy = false;
    let served = 0;
    const server = createServer((socket) => {
      socket.on('error', () => {});
      queue.push(socket);
      next();
    });
    const next = async () => {
      if (busy || queue.length === 0) return;
      busy = true;
      const socket = queue.shift();
      served++;
      try {
        await this.handle(socket);
      } catch (error) {
        this.log('!! ' + error.message);
      }
      if (!socket.destroyed) socket.end();
      busy = false;
      if (maxConnections !== 0 && served >= maxConnections) {
        server.close();
        return;
      }
      next();
    };
    server.on('error', (error) => {
      console.error(`cannot listen on ${host}:${port}: ${error.message}`);
      process.exit(1);
    });
    server.listen(port, host, () => {
      const address = server.address();
      console.log(`LISTENING ${address.address}:${address.port}`);
      console.log('Signing with the key you passed; enter the same key as the Wi-Fi secure hash key in the till.');
    });
  }

  async handle(socket) {
    const reader = new Reader(socket, 5000);
    const header = await reader.readExactly(2);
    if (header === null) return; // a reachability probe connects and leaves without sending anything
    const body = await reader.readExactly(header.readUInt16BE(0));
    if (body === null) return;
    let request;
    try {
      request = JSON.parse(body.toString('utf8'));
    } catch {
      request = null;
    }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      this.log('bad request: not a JSON object');
      return;
    }
    this.log('--> ' + body.toString('utf8'));

    if (this.delay > 0) await sleep(this.delay * 1000);

    const type = String(request.messageType ?? '');
    const problem = this.checkRequest(request);
    let signingKey = this.key;
    let response;

    if (problem !== null) {
      this.log('!! ' + problem);
      response = envelope(false, '96', problem, null, [problem]);
    } else if (type === 'INQUIRY') {
      if (this.inquiryDropsLeft > 0) {
        this.inquiryDropsLeft--;
        this.log('.. closing without an answer (--drop-first-inquiry)');
        return;
      }
      response = this.inquiry(request);
    } else if (type === 'RECEIPT') {
      response = this.receipt(request);
    } else if (type === 'CLOSE_RECEIPT') {
      response = this.noCloseReceipt
        ? envelope(false, '96', 'Unsupported', null, ['CLOSE_RECEIPT not supported'])
        : envelope(true, '00', 'OK', { merchantReference: request.merchantReference ?? '' });
    } else {
      response = this.busy && type === 'SALE'
        ? envelope(false, 'BUSY', 'Terminal is busy with another transaction', null, ['Terminal busy'])
        : this.transaction(request, type);
      if (type === 'SALE') {
        if (this.dropSale) {
          this.log('.. sale recorded, closing without an answer (--drop-sale)');
          return;
        }
        if (this.stallSale) {
          this.log('.. sale recorded, never answering (--stall-sale)');
          this.stallSale = false;
          await sleep(this.stallSeconds * 1000);
          return;
        }
        if (this.resetSale) {
          this.log('.. sale recorded, resetting the connection (--reset-sale)');
          socket.resetAndDestroy();
          return;
        }
        if (this.garbageSale) {
          this.log('.. sale recorded, answering garbage (--garbage-sale)');
          send(socket, '<html>gateway error</html>');
          return;
        }
        if (this.wrongKeySale) signingKey = 'c'.repeat(32);
      }
    }

    if (this.answerVersion !== null) response.version = this.answerVersion;
    response.nonce = String(request.nonce ?? '');
    response.secureHash = sign(response, signingKey);
    const text = JSON.stringify(response);
    send(socket, text);
    this.log('<-- ' + text);
  }

  checkRequest(request) {
    const presented = String(request.secureHash ?? '');
    if (presented === '') return 'request is not signed';
    const expected = Buffer.from(sign(request, this.key));
    const given = Buffer.from(presented.toUpperCase());
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return "request signature does not match this terminal's key";
    }
    const nonce = String(request.nonce ?? '');
    if (this.seenNonces.has(nonce)) return 'nonce already used (replay)';
    this.seenNonces.add(nonce);
    return null;
  }

  transaction(request, type) {
    const reference = String(request.merchantReference ?? '');
    const code = this.declineCode ?? '00';
    if (code !== '00') return envelope(false, code, 'Declined', null, [`Declined by the issuer (${code})`]);
    const original = type !== 'SALE' ? this.findByStan(String(request.stan ?? '')) : null;
    const requested = request.amount !== undefined ? majorUnits(String(request.amount)) : (original?.amount ?? '0.258');
    let settled = requested;
    let partial = false;
    if (this.partial && type === 'SALE') {
      settled = majorUnits(String(Math.floor(Number(request.amount) / 2)));
      partial = true;
    }
    const stan = String(this.nextStan++).padStart(6, '0');
    const name = type.charAt(0) + type.slice(1).toLowerCase();
    this.byReference.set(reference, { stan, type: name, amount: requested, authorized: settled, partial, time: localIsoSeconds() });
    return envelope(true, '00', 'Approved', {
      merchantReference: reference,
      amount: requested,
      authorizeAmount: settled,
      isPartialApprove: partial,
      rrn: String(randomInt(10 ** 11, 10 ** 12 - 1)),
      authCode: type === 'VOID' ? '000000' : String(randomInt(100000, 999999)),
      cardMask: '483312******1234',
      terminalSerial: String(request.terminalSerial ?? ''),
      transactionType: name,
    });
  }

  inquiry(request) {
    const transaction = this.notFound ? null : this.find(request);
    if (transaction === null) return envelope(false, '25', 'No transactions found for the provided STAN and Terminal', null);
    return envelope(true, '00', 'Transaction found', {
      transactionId: '0e9a7c00-0000-4000-8000-000000000001',
      stan: transaction.stan,
      transactionType: transaction.type,
      transactionTypeDisplayName: transaction.type,
      status: 'Approved',
      amount: transaction.amount,
      authorizeAmount: transaction.authorized,
      isPartialApprove: transaction.partial,
      totalAmount: transaction.amount,
      currency: 'OMR',
      transactionTime: transaction.time,
      cardNumber: '483312******1234',
      rrn: '1000000000000000000001',
      batchId: '00000003',
      terminalId: (request.originalTerminalId ?? '') !== '' ? request.originalTerminalId : '30001',
      isRefunded: false,
      canVoid: true,
      canRefund: true,
    });
  }

  receipt(request) {
    if (this.notFound) return envelope(false, '91', 'The receipt could not be generated', null);
    const stan = String(request.stan ?? '');
    return envelope(true, '00', 'Receipt ready', {
      receiptUrl: 'https://example.invalid/receipt?stan=' + stan,
      transactionId: '0e9a7c00-0000-4000-8000-000000000001',
      stan,
    });
  }

  find(request) {
    const byReference = String(request.originalMerchantReference ?? '');
    if (byReference !== '') return this.byReference.get(byReference) ?? null;
    const stan = String(request.stan ?? '');
    return this.findByStan(stan) ?? {
      stan, type: 'Purchase', amount: '0.258', authorized: '0.258', partial: false, time: '2026-08-09T16:58:16.804271',
    };
  }

  findByStan(stan) {
    for (const transaction of this.byReference.values()) if (transaction.stan === stan) return transaction;
    return null;
  }

  log(line) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    console.log(`[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}] ${line}`);
  }
}

/** Reads exact byte counts from a socket; null when it closes or stays silent for `timeoutMs`. */
class Reader {
  buffer = Buffer.alloc(0);
  closed = false;
  waiter = null;

  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    const close = () => {
      this.closed = true;
      this.wake();
    };
    socket.on('end', close);
    socket.on('close', close);
    socket.on('error', close);
  }

  wake() {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async readExactly(count) {
    const deadline = Date.now() + this.timeoutMs;
    while (this.buffer.length < count) {
      if (this.closed || Date.now() >= deadline) return null;
      await new Promise((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, Math.max(1, deadline - Date.now()));
      });
    }
    const chunk = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return chunk;
  }
}

function envelope(success, code, message, data, errors = []) {
  return { success, responseCode: code, message, data, errorList: errors };
}

function compose(object) {
  const pairs = [];
  for (const [name, value] of Object.entries(object)) {
    if (name === 'secureHash' || value === null || value === undefined || typeof value === 'object') continue;
    pairs.push([name, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)]);
  }
  pairs.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))); // ordinal, like the SDK
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

function sign(object, keyHex) {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(compose(object), 'utf8').digest('hex').toUpperCase();
}

function majorUnits(minor, digits = 3) {
  const text = String(Number.parseInt(minor, 10) || 0).padStart(digits + 1, '0');
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

function send(socket, body) {
  const bytes = Buffer.from(body, 'utf8');
  const header = Buffer.alloc(2);
  header.writeUInt16BE(bytes.length, 0);
  socket.write(Buffer.concat([header, bytes]));
}

function localIsoSeconds() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage(problem, code = 2) {
  if (problem) console.error(problem);
  console.error('usage: node tools/fake-pos-server.mjs --key <hex> [--host 127.0.0.1] [--port 19100] [flags]');
  console.error('see the header of this file for the flags');
  process.exit(code);
}

new FakeTerminal(key, options).serve(parsed.host, Number(parsed.port), Number(parsed['max-connections']));
