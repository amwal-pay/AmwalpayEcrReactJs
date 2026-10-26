import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReceiptUnavailable } from '@amwalpay/ecr-js';
import { decodeState, encodeState } from '../core/stateCodec.js';
import { TransactionEngine } from '../core/TransactionEngine.js';
import { TransactionOutcomes } from '../core/TransactionOutcomes.js';
import { TransactionRequest } from '../core/TransactionRequest.js';
import { StateChecking, StateCompleted, StateFailed, StateIdle, StateInProgress, StateInquired } from '../core/TransactionState.js';

/**
 * One operator flow at a moment, read in one go so state and version belong together.
 *
 * `version` is bumped on every change, so a poller can tell whether anything moved.
 * `timeoutSeconds` is the configured response budget: 130 s on Web Service, 120 s on Wi-Fi.
 * `remainingSeconds` is what is left while busy or fetching a receipt; null otherwise.
 */
export class TransactionSnapshot {
  constructor({ id, terminalSerial, request, usesWebService, state, version, timeoutSeconds, remainingSeconds }) {
    Object.assign(this, { id, terminalSerial, request, usesWebService, state, version, timeoutSeconds, remainingSeconds });
    Object.freeze(this);
  }

  fetchingReceipt() {
    return this.state instanceof StateInquired && this.state.fetchingReceipt;
  }
}

/**
 * Runs transactions on the server, keyed by an id the browser polls. The Node
 * port of the web sample's TransactionRegistry.
 *
 * **A payment is not tied to the HTTP request.** Each run executes as its own
 * task in this long-lived server process; nothing looks at the request's
 * lifetime. The only way to stop waiting is the explicit Cancel, which cannot
 * un-send a request and shows an unknown outcome, never "cancelled".
 *
 * **One running transaction per terminal serial**, enforced here and not by
 * disabling a button: a double click, a second tab or a repeated POST must not
 * put two sales on one terminal. (The SDK's own guard enforces the same rule a
 * level lower.)
 *
 * Runs are written to `runs/` as they change, so a restarted server finds
 * them. A run that was still waiting when its server stopped belongs to a task
 * that no longer exists: it becomes a failure carrying its reference rather
 * than spinning forever.
 */
export class TransactionRegistry {
  /** How long a finished run nobody acknowledged is kept: an unknown outcome must survive a night away. */
  static FINISHED_RETENTION_SECONDS = 12 * 3600;

  #directory;
  #engine;
  #clock;
  #log;
  /** Identifies this server process: a waiting run owned by another one has lost its task. */
  #instance = randomBytes(8).toString('hex');
  #runs = new Map();
  /** Tasks in flight, so a caller (a test, a graceful shutdown) can wait for them. */
  #tasks = new Set();

  constructor(directory, engine, { clock = null, log = null } = {}) {
    this.#directory = directory;
    this.#engine = engine;
    this.#clock = clock;
    this.#log = log;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#load();
  }

  /** @returns {['started', TransactionSnapshot] | ['busy', string]} */
  start(request, usesWebService, responseTimeoutSeconds = 120) {
    this.#sweep();
    const existing = this.#runningOn(request.terminalSerial);
    if (existing !== null) return ['busy', existing];
    // The reference is made and stored before anything is sent, so it is
    // known even if this process dies mid-flight.
    if (request.type.movesMoney() && request.merchantReference === '') {
      request = request.withMerchantReference(TransactionEngine.newReference());
    }
    const now = this.#now();
    let run = {
      id: randomBytes(16).toString('hex'),
      terminalSerial: request.terminalSerial,
      usesWebService,
      timeoutSeconds: Math.max(1, responseTimeoutSeconds),
      started: now,
      updated: now,
      busySince: now,
      version: 0,
      generation: 0,
      owner: this.#instance,
      request,
      state: new StateChecking(),
    };
    run = this.#begin(run, request);
    return ['started', this.#snapshot(run)];
  }

  find(id) {
    this.#sweep();
    const run = this.#runs.get(id);
    return run === undefined ? null : this.#snapshot(run);
  }

  /** Runs the operator has not acknowledged, newest first. */
  pending() {
    this.#sweep();
    return [...this.#runs.values()].sort((a, b) => b.started - a.started).map((run) => this.#snapshot(run));
  }

  /** Stops waiting, like the WPF Cancel button. A no-op once the run has finished. */
  cancel(id) {
    let run = this.#runs.get(id);
    if (run === undefined) return null;
    if (run.state instanceof StateChecking) {
      // Nothing has been sent: the task asks before sending and will be told no.
      run = this.#update(run, new StateIdle());
    } else if (run.state instanceof StateInProgress) {
      // Already sent: stopping here does not stop the terminal.
      run = this.#update(run, TransactionOutcomes.cancelledState(run.request));
    }
    return this.#snapshot(run);
  }

  /**
   * After an unknown outcome: look the transaction up by the reference it was
   * sent with, on the same run id. The only follow-up offered: never a retry.
   *
   * @returns {['started', TransactionSnapshot] | ['notFound'] | ['notApplicable'] | ['busy', string]}
   */
  inquire(id) {
    this.#sweep();
    let run = this.#runs.get(id);
    if (run === undefined) return ['notFound'];
    const state = run.state;
    if (!(state instanceof StateFailed) || state.inquirableReference === null) return ['notApplicable'];
    const existing = this.#runningOn(run.terminalSerial);
    if (existing !== null) return ['busy', existing];
    const inquiry = TransactionRequest.inquiryByReference(run.terminalSerial, state.inquirableReference);
    run = this.#begin({ ...run, request: inquiry }, inquiry);
    return ['started', this.#snapshot(run)];
  }

  /**
   * Fetches the e-receipt of an inquired transaction (Wi-Fi), as a task.
   *
   * @returns {['started', TransactionSnapshot] | ['notFound'] | ['notApplicable']}
   */
  requestReceipt(id) {
    let run = this.#runs.get(id);
    if (run === undefined) return ['notFound'];
    const state = run.state;
    if (!(state instanceof StateInquired) || state.receipt !== null || state.fetchingReceipt || run.usesWebService) {
      return ['notApplicable'];
    }
    run = { ...run, busySince: this.#now(), generation: run.generation + 1, owner: this.#instance };
    run = this.#update(run, state.withReceipt(null, true));
    this.#launch(run.id, run.generation, 'receipt');
    return ['started', this.#snapshot(run)];
  }

  /**
   * Asks the terminal to put its receipt away. Does not change the run's
   * state: the result dialog stays open.
   *
   * @returns {Promise<['done', TransactionSnapshot, string] | ['notFound'] | ['notApplicable', string|null]>}
   */
  async closeReceipt(id) {
    const run = this.#runs.get(id);
    if (run === undefined) return ['notFound'];
    const state = run.state;
    if (!(state instanceof StateCompleted)) return ['notApplicable', null];
    let original = '';
    if (run.usesWebService && state.type.movesMoney()) original = state.result.merchantReference;
    if (run.usesWebService && original.trim() === '') {
      return ['notApplicable', 'Close receipt needs the sale / void / refund reference'];
    }
    const snapshot = this.#snapshot(run);
    const message = await this.#engine.closeTerminalReceipt(run.terminalSerial, original);
    return ['done', snapshot, message];
  }

  /** The operator has read the result. A running transaction cannot be dismissed: false. */
  acknowledge(id) {
    const run = this.#runs.get(id);
    if (run === undefined) return true;
    if (run.state.isBusy()) return false;
    this.#remove(id);
    return true;
  }

  /** Resolves when every task started so far has finished. */
  async idle() {
    while (this.#tasks.size !== 0) await Promise.allSettled([...this.#tasks]);
  }

  // ── The task's side ─────────────────────────────────────────────

  #launch(id, generation, mode) {
    const task = this.#work(id, generation, mode)
      .catch((error) => this.#log?.append('App', '[App] worker error: ' + (error?.message ?? String(error))))
      .finally(() => this.#tasks.delete(task));
    this.#tasks.add(task);
  }

  /** Executes one generation of a run. Writes only while that generation is still current. */
  async #work(id, generation, mode) {
    const run = this.#runs.get(id);
    if (run === undefined || run.generation !== generation) return;
    if (mode === 'receipt') {
      await this.#workReceipt(id, generation, run);
      return;
    }
    const request = run.request;
    let final;
    try {
      final = await this.#engine.run(request, (progress) => {
        // Checked and claimed in one step: a cancel either lands before this
        // (nothing is sent) or after it (an unknown outcome).
        const current = this.#runs.get(id);
        if (current === undefined || current.generation !== generation || !(current.state instanceof StateChecking)) return false;
        this.#update(current, progress);
        return true;
      });
    } catch (error) {
      // The engine answers every failure itself; this is the last line, so
      // that a run can never be left spinning.
      const message = 'Unexpected error: ' + (error?.message ?? String(error));
      final = request.type.movesMoney()
        ? new StateFailed(message, request.merchantReference !== '' ? request.merchantReference : TransactionEngine.newReference())
        : new StateFailed(message);
    }
    const current = this.#runs.get(id);
    // Cancelled, followed up or acknowledged meanwhile: this answer is no
    // longer what the screen shows. (The SDK's journal still has it.)
    if (current === undefined || current.generation !== generation || !current.state.isBusy()) return;
    this.#update(current, final);
  }

  async #workReceipt(id, generation, run) {
    const state = run.state;
    if (!(state instanceof StateInquired)) return;
    let receipt;
    try {
      receipt = await this.#engine.fetchReceipt(state);
    } catch (error) {
      receipt = new ReceiptUnavailable('', error?.message ?? String(error), '');
    }
    const current = this.#runs.get(id);
    // The operator may have moved on while this was in flight.
    if (current !== undefined && current.generation === generation && current.state instanceof StateInquired) {
      this.#update(current, current.state.withReceipt(receipt, false));
    }
  }

  // ── Internals ───────────────────────────────────────────────────

  /** Claims the terminal and starts `request` in a fresh generation. */
  #begin(run, request) {
    const now = this.#now();
    run = { ...run, generation: run.generation + 1, busySince: now, owner: this.#instance, request };
    run = this.#update(run, new StateChecking());
    this.#launch(run.id, run.generation, 'run');
    return run;
  }

  #update(run, state) {
    const next = { ...run, state, version: run.version + 1, updated: this.#now() };
    this.#runs.set(next.id, next);
    this.#write(next);
    return next;
  }

  /** The id of the run busy on `serial`, or null. */
  #runningOn(serial) {
    for (const run of this.#runs.values()) {
      if (run.terminalSerial === serial && run.state.isBusy()) return run.id;
    }
    return null;
  }

  /** Drops finished runs nobody acknowledged for too long. */
  #sweep() {
    const cutoff = this.#now() - TransactionRegistry.FINISHED_RETENTION_SECONDS;
    for (const run of [...this.#runs.values()]) {
      if (!waiting(run.state) && run.updated < cutoff) this.#remove(run.id);
    }
  }

  /**
   * What a run becomes when its task is gone: never "not done". A sale, void
   * or refund that may have been sent keeps its reference.
   */
  #orphaned(run) {
    const state = run.state;
    if (state instanceof StateInquired) {
      return state.withReceipt(new ReceiptUnavailable('', 'The receipt request stopped unexpectedly on the server', ''), false);
    }
    const request = run.request;
    const message = 'The transaction stopped unexpectedly on the server.';
    if (request.type.movesMoney()) {
      return state instanceof StateChecking && request.merchantReference === ''
        ? new StateFailed(message + ' Nothing was sent to the terminal.')
        : new StateFailed(message + ' If the request had already reached the terminal, it may still complete.', request.merchantReference);
    }
    return new StateFailed(
      message,
      request.looksUpByReference() ? request.originalReference : null,
      'An inquiry only reads and changes nothing, so it is safe to try again.',
    );
  }

  #snapshot(run) {
    const busy = waiting(run.state);
    return new TransactionSnapshot({
      id: run.id,
      terminalSerial: run.terminalSerial,
      request: run.request,
      usesWebService: run.usesWebService,
      state: run.state,
      version: run.version,
      timeoutSeconds: run.timeoutSeconds,
      remainingSeconds: busy ? Math.max(0, run.timeoutSeconds - Math.floor(this.#now() - run.busySince)) : null,
    });
  }

  /** Reads the runs a previous server left, and settles the ones whose task is gone. */
  #load() {
    for (const file of readdirSync(this.#directory)) {
      const match = /^([0-9a-f]{32})\.run$/.exec(file);
      if (match === null) continue;
      const run = this.#read(match[1]);
      if (run === null) continue;
      this.#runs.set(run.id, run);
      if (waiting(run.state) && run.owner !== this.#instance) this.#update(run, this.#orphaned(run));
    }
  }

  #read(id) {
    try {
      const data = JSON.parse(readFileSync(this.#path(id), 'utf8'));
      return {
        id,
        terminalSerial: String(data.terminalSerial ?? ''),
        usesWebService: data.usesWebService === true,
        timeoutSeconds: Number(data.timeoutSeconds) || 120,
        started: Number(data.started) || 0,
        updated: Number(data.updated) || 0,
        busySince: Number(data.busySince) || 0,
        version: Number(data.version) || 0,
        generation: Number(data.generation) || 0,
        owner: String(data.owner ?? ''),
        request: TransactionRequest.fromJSON(data.request),
        state: decodeState(data.state),
      };
    } catch {
      return null;
    }
  }

  #write(run) {
    const stored = { ...run, request: run.request.toJSON(), state: encodeState(run.state), stateName: run.state.name() };
    const path = this.#path(run.id);
    const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(stored, null, 4), { mode: 0o600 });
      renameSync(temp, path);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // Never written.
      }
      throw new Error('The transaction state could not be saved in ' + this.#directory, { cause: error });
    }
  }

  #remove(id) {
    this.#runs.delete(id);
    const path = this.#path(id);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // Gone already.
      }
    }
  }

  #path(id) {
    return join(this.#directory, `${id}.run`);
  }

  #now() {
    return this.#clock !== null ? this.#clock() : Date.now() / 1000;
  }
}

function waiting(state) {
  return state.isBusy() || (state instanceof StateInquired && state.fetchingReceipt);
}
