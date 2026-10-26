import QRCode from 'qrcode';
import { EcrConfig, EcrEnvironment, EcrTransactionType } from '@amwalpay/ecr-js';
import { AmountEntry } from '../core/AmountEntry.js';
import { EcrMode } from '../core/EcrMode.js';
import { LogBuffer } from '../core/LogBuffer.js';
import { TerminalValidator } from '../core/TerminalValidator.js';
import { startOfToday, TransactionFormState } from '../core/TransactionFormState.js';
import { Response } from './Response.js';
import { Views } from './Views.js';

/**
 * The JSON API, route for route the web sample's minimal API: meta, terminals,
 * settings, transactions, log and QR. Handlers only translate; the flow is the
 * Core engine run by the {@link TransactionRegistry}.
 */
export class Api {
  /** A receipt URL is short; this is far above one and well below what a QR can carry. */
  static MAX_QR_TEXT_LENGTH = 1024;

  #app;

  constructor(app) {
    this.#app = app;
  }

  /** @returns {Promise<Response>} */
  async handle(method, path, query, body) {
    // Split before decoding, so an encoded "/" in a serial stays part of it.
    const segments = path.replace(/^\/+|\/+$/g, '').split('/').slice(1).map(decodeSegment);
    if (segments.includes(null)) return error(400, 'The request could not be read');
    const [, a = '', b = ''] = segments;
    const is = (...expected) => segments.length === expected.length && expected.every((s, i) => s === null || s === segments[i]);
    const app = this.#app;

    if (method === 'GET' && is('meta')) return Response.json(200, Views.meta());

    if (method === 'GET' && is('terminals')) return this.#terminals();
    if (method === 'POST' && is('terminals')) return this.#saveTerminal(body, null);
    if (method === 'PUT' && is('terminals', null)) {
      return app.terminals.findBySerial(a) === null ? error(404, 'No such terminal') : this.#saveTerminal(body, a);
    }
    if (method === 'DELETE' && is('terminals', null)) return this.#deleteTerminal(a);
    if (method === 'GET' && is('terminals', null, 'config')) return this.#config(a, query.get('announce') === 'true');

    if (method === 'GET' && is('settings')) return Response.json(200, Views.settings(app.settings));
    if (method === 'PUT' && is('settings', 'environment')) return this.#setEnvironment(body);
    if (method === 'PUT' && is('settings', 'keys', null)) return this.#setKey(b, body);
    if (method === 'DELETE' && is('settings', 'keys', null)) return this.#clearKey(b);

    if (method === 'GET' && is('transactions')) {
      return Response.json(200, { transactions: app.registry.pending().map((run) => Views.transaction(run)) });
    }
    if (method === 'POST' && is('transactions')) return this.#start(body);
    if (method === 'GET' && is('transactions', null)) return this.#find(a);
    if (method === 'POST' && is('transactions', null, 'cancel')) return this.#cancel(a);
    if (method === 'POST' && is('transactions', null, 'inquire')) return this.#inquire(a);
    if (method === 'POST' && is('transactions', null, 'receipt')) return this.#receipt(a);
    if (method === 'POST' && is('transactions', null, 'close-receipt')) return this.#closeReceipt(a);
    if (method === 'DELETE' && is('transactions', null)) {
      return app.registry.acknowledge(a) ? Response.empty(204) : error(409, 'The transaction is still running');
    }

    if (method === 'GET' && is('qr')) return this.#qr(query.get('text') ?? '');
    if (method === 'GET' && is('log')) {
      return Response.json(200, { text: app.log.snapshot(), count: app.log.count(), capacity: LogBuffer.CAPACITY });
    }
    if (method === 'DELETE' && is('log')) {
      app.log.clear();
      return Response.empty(204);
    }

    return error(404, 'No such endpoint');
  }

  // ── Terminals ────────────────────────────────────────────────────

  #terminals() {
    return Response.json(200, {
      terminals: this.#app.terminals.getAll().map((t) => Views.terminal(t)),
      notice: this.#app.terminals.loadWarning,
    });
  }

  #saveTerminal(form, originalSerial) {
    const value = form.ecrMode;
    const mode = Number.isInteger(value) ? EcrMode.fromValue(value) : null;
    if (mode === null) return fields({ mode: 'Choose an ECR mode' });
    const scalar = (key) => {
      const v = form[key];
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
    };
    const input = {
      name: scalar('name'),
      serial: scalar('serialNumber'),
      mode,
      ip: scalar('ipAddress'),
      port: scalar('port'),
      terminalId: scalar('terminalId'),
      merchantId: scalar('merchantId'),
    };
    const errors = TerminalValidator.validate(input);
    if (Object.keys(errors).length !== 0) return fields(errors);
    const terminal = TerminalValidator.toTerminal(input);
    const failure = this.#app.terminals.save(terminal, originalSerial);
    // A duplicate serial is shown against the serial field, where it can be fixed.
    return failure !== null ? fields({ serial: failure }) : Response.json(200, Views.terminal(terminal));
  }

  #deleteTerminal(serial) {
    if (this.#app.terminals.findBySerial(serial) === null) return error(404, 'No such terminal');
    const failure = this.#app.terminals.delete(serial);
    return failure !== null ? error(500, 'Could not delete the terminal: ' + failure) : Response.empty(204);
  }

  /** announce=true is the "selection changed" log line: only when the operator picks a terminal. */
  #config(serial, announce) {
    const terminal = this.#app.terminals.findBySerial(serial);
    if (terminal === null) return error(404, 'No such terminal');
    const config = this.#app.engine.resolveConfig(terminal);
    if (announce) this.#app.engine.logSelectedConfig(config);
    return Response.json(200, Views.config(config));
  }

  // ── Settings: keys are write-only ─────────────────────────────────

  #setEnvironment(body) {
    const name = (typeof body.environment === 'string' ? body.environment : '').trim().toUpperCase();
    const environment = EcrEnvironment.tryFrom(name);
    if (environment === null) return fields({ environment: 'Choose SIT, UAT or PROD' });
    this.#app.settings.setEnvironment(environment);
    return this.#savedSettings();
  }

  #setKey(kind, body) {
    if (kind !== 'wifi' && kind !== 'webService') return error(404, 'No such key');
    const key = (typeof body.value === 'string' ? body.value : '').trim();
    // Blank is what Clear is for: replacing a key with nothing by accident would
    // quietly disable the terminals that use it.
    if (key === '') return fields({ value: 'Enter the key, or use Clear to remove it' });
    if (!EcrConfig.isValidSecureHashKey(key)) return fields({ value: 'Must be an even-length hex string of at least 16 characters' });
    if (kind === 'webService') this.#app.settings.setWebServiceSecureHashKey(key);
    else this.#app.settings.setWifiSecureHashKey(key);
    return this.#savedSettings();
  }

  #clearKey(kind) {
    if (kind !== 'wifi' && kind !== 'webService') return error(404, 'No such key');
    if (kind === 'webService') this.#app.settings.setWebServiceSecureHashKey('');
    else this.#app.settings.setWifiSecureHashKey('');
    return this.#savedSettings();
  }

  /** The value stays in memory when the file cannot be written, so say so instead of a false "saved". */
  #savedSettings() {
    const saveError = this.#app.settings.saveError;
    return saveError !== null ? error(500, saveError) : Response.json(200, Views.settings(this.#app.settings));
  }

  // ── Transactions ──────────────────────────────────────────────────

  #start(body) {
    const serial = text(body, 'terminalSerial');
    const terminal = serial !== '' ? this.#app.terminals.findBySerial(serial) : null;
    if (terminal === null) {
      return fields({ terminal: serial !== '' ? `Terminal ${serial} is no longer registered` : 'Choose a POS terminal' });
    }
    // The Start button is disabled until the plan is ready, so the operator sees
    // what is missing before paying. The server holds the same line.
    const config = this.#app.engine.resolveConfig(terminal);
    if (!config.isReady()) return Response.json(422, { errors: {}, message: config.issues().join('\n') });
    const wanted = text(body, 'type').trim().toLowerCase();
    const type = EcrTransactionType.menuOptions().find((option) => option.value.toLowerCase() === wanted) ?? null;
    if (type === null) return fields({ type: 'Choose a transaction type' });
    const digits = (v) => v.replace(/[^0-9]/g, '');
    const originalReference = text(body, 'originalReference');
    const form = new TransactionFormState({
      type,
      // The digits the amount field keeps: ASCII digits, no leading zeros, capped.
      amountDigits: AmountEntry.keyedDigits(text(body, 'amountDigits')),
      receiptNumber: digits(text(body, 'receiptNumber')).slice(0, TransactionFormState.RECEIPT_NUMBER_MAX_LENGTH),
      originalTerminalId: digits(text(body, 'originalTerminalId')),
      originalDate: date(text(body, 'originalDate')),
      useOtherTerminal: body.useOtherTerminal === true,
      lookUpByReference: body.lookUpByReference === true,
      // Capped at 32 as it is typed. The sale's own reference is not cut:
      // validation reports an over-long one, with its message.
      originalReference: originalReference.slice(0, TransactionFormState.MERCHANT_REFERENCE_MAX_LENGTH),
      merchantReference: text(body, 'merchantReference'),
    });
    const [request, errors] = form.validated(terminal.serialNumber);
    if (request === null) return fields(errors);
    const ecr = config.ecrConfig();
    // The configured response budget, as the Windows sample: 120 s Wi-Fi, 130 s Web Service.
    const timeout = Math.trunc(ecr.responseTimeout);
    const started = this.#app.registry.start(request, config.usesWebService(), Math.max(1, timeout));
    return started[0] === 'busy'
      ? error(409, 'A transaction is already running on this terminal', started[1])
      : Response.json(202, Views.transaction(started[1]));
  }

  #find(id) {
    const run = this.#app.registry.find(id);
    return run === null ? error(404, 'No such transaction') : Response.json(200, Views.transaction(run));
  }

  #cancel(id) {
    const run = this.#app.registry.cancel(id);
    return run === null ? error(404, 'No such transaction') : Response.json(200, Views.transaction(run));
  }

  #inquire(id) {
    const outcome = this.#app.registry.inquire(id);
    switch (outcome[0]) {
      case 'started': return Response.json(202, Views.transaction(outcome[1]));
      case 'notFound': return error(404, 'No such transaction');
      case 'busy': return error(409, 'Another transaction is running on this terminal', outcome[1]);
      default: return error(409, 'This transaction has no unknown outcome to look up');
    }
  }

  #receipt(id) {
    const outcome = this.#app.registry.requestReceipt(id);
    switch (outcome[0]) {
      case 'started': return Response.json(202, Views.transaction(outcome[1]));
      case 'notFound': return error(404, 'No such transaction');
      default: return error(409, 'No receipt can be requested for this transaction');
    }
  }

  async #closeReceipt(id) {
    const outcome = await this.#app.registry.closeReceipt(id);
    switch (outcome[0]) {
      case 'done': return Response.json(200, { message: outcome[2], transaction: Views.transaction(outcome[1]) });
      case 'notFound': return error(404, 'No such transaction');
      default: return error(409, outcome[1] ?? 'Close receipt is not available for this transaction');
    }
  }

  // ── QR ────────────────────────────────────────────────────────────

  /** Drawn here rather than by a script on the page: nothing to fetch and no client library. */
  async #qr(value) {
    if (value.trim() === '') return error(400, 'Nothing to encode');
    if (value.length > Api.MAX_QR_TEXT_LENGTH) return error(400, `The text is longer than ${Api.MAX_QR_TEXT_LENGTH} characters`);
    try {
      // A receipt URL is scanned off a screen at arm's length; M keeps it readable.
      const svg = await QRCode.toString(value, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 200 });
      return new Response(200, { 'Content-Type': 'image/svg+xml' }, svg);
    } catch {
      return error(400, 'The text is too long for a QR code');
    }
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function text(body, key) {
  const value = body[key] ?? '';
  return typeof value === 'string' ? value : Number.isInteger(value) ? String(value) : '';
}

/** yyyy-MM-dd (a date input) or yyyyMMdd; blank or unreadable is today, and the future is today. */
function date(value) {
  const today = startOfToday();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (m !== null) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const parsed = new Date(y, mo - 1, d);
    if (parsed.getFullYear() === y && parsed.getMonth() === mo - 1 && parsed.getDate() === d) return parsed > today ? today : parsed;
  }
  return today;
}

function fields(errors) {
  return Response.json(422, { errors, message: null });
}

function error(status, message, transactionId = null) {
  return Response.json(status, { error: message, transactionId });
}
