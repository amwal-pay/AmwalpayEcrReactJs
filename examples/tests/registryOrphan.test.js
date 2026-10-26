import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EcrTransactionType } from '@amwalpay/ecr-js';
import { afterEach, describe, expect, test } from 'vitest';
import { TransactionRequest } from '../server/core/TransactionRequest.js';
import { StateFailed } from '../server/core/TransactionState.js';
import { DataPaths } from '../server/web/DataPaths.js';
import { TransactionRegistry } from '../server/web/TransactionRegistry.js';

/**
 * A server that stops mid-payment (recycled, the machine slept, a crash) must
 * not leave a run spinning forever, and must not turn a sale that may have been
 * sent into "not done". The web sample keeps runs in memory and lists this as
 * a limitation; this port, like the PHP one, detects it.
 */
describe('registry', () => {
  let now = 1_000_000;
  const directories = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** An engine whose run never finishes: exactly what a stopped server looks like from outside. */
  const stuck = { run: () => new Promise(() => {}), fetchReceipt: () => new Promise(() => {}), closeTerminalReceipt: async () => '' };

  function registry(directory) {
    return new TransactionRegistry(directory, stuck, { clock: () => now });
  }

  function folder() {
    const paths = new DataPaths(join(tmpdir(), 'ecr-registry-' + randomBytes(5).toString('hex')));
    paths.ensure();
    directories.push(paths.root);
    return paths.runs();
  }

  test('a sale whose server stopped becomes an unknown outcome with its reference', () => {
    const runs = folder();
    const first = registry(runs);
    const [, run] = first.start(new TransactionRequest({ type: EcrTransactionType.Sale, terminalSerial: 'SN-1', amount: '1.000' }), false);
    const reference = run.request.merchantReference;

    expect(reference, 'made and stored before anything is sent').toMatch(/^[0-9A-F]{12}$/);
    now += 5;
    expect(first.find(run.id)?.state.isBusy(), 'while its server runs it is still running').toBe(true);

    // The server restarts: the task that ran this sale is gone.
    const restarted = registry(runs);
    const after = restarted.find(run.id);

    expect(after?.state).toBeInstanceOf(StateFailed);
    expect(after.state.inquirableReference).toBe(reference);
    expect(after.state.message).toContain('stopped unexpectedly');
    expect(restarted.start(new TransactionRequest({ type: EcrTransactionType.Sale, terminalSerial: 'SN-1', amount: '1.000' }), false)[0], 'the terminal is free again').toBe('started');
  });

  test('finished runs nobody read are kept twelve hours, then dropped', () => {
    const runs = folder();
    const [, run] = registry(runs).start(new TransactionRequest({ type: EcrTransactionType.Inquiry, terminalSerial: 'SN-2', originalReference: 'ORD-1' }), false);
    const restarted = registry(runs);
    expect(restarted.find(run.id)?.state).toBeInstanceOf(StateFailed);
    expect(restarted.find(run.id).state.inquirableReference, 'an inquiry by reference keeps what it looked up').toBe('ORD-1');

    now += TransactionRegistry.FINISHED_RETENTION_SECONDS - 60;
    expect(restarted.find(run.id)).not.toBeNull();
    now += 120;
    expect(restarted.find(run.id)).toBeNull();
  });
});
