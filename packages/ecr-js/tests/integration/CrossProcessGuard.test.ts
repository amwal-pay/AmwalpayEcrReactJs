import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { EcrTerminal } from '../../src/EcrTerminal.js';
import { Busy } from '../../src/failure/Failure.js';
import { Approved, Failed, Found } from '../../src/result/results.js';
import { BackgroundProcess } from '../support/BackgroundProcess.js';
import { FakeChannel } from '../support/FakeChannel.js';
import { TestKeys, useTempState } from '../support/keys.js';
import { Wire } from '../support/wire.js';

/**
 * One financial transaction per terminal across processes, as on a server
 * where several workers drive the same till.
 */
const HOLD = join(dirname(fileURLToPath(import.meta.url)), '../support/hold-terminal.mjs');
const DIST = join(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
const stateDir = useTempState();

beforeAll(() => {
  if (!existsSync(DIST)) throw new Error('Run "npm run build" first: the child process imports dist/index.js');
});

describe('cross-process guard', () => {
  it('refuses a sale as busy, and sends nothing, while another process holds the terminal', async () => {
    const channel = FakeChannel.always('{"success":true,"responseCode":"00","data":{"amount":"1.000"}}');
    const t = new EcrTerminal(channel, 'TW1', TestKeys.unsigned(stateDir()));
    const other = await BackgroundProcess.start(HOLD, [stateDir(), t.terminalKey()]);
    try {
      const busy = await t.sale('1.000', 'ORD-1');
      const inquiry = await new EcrTerminal(FakeChannel.always(Wire.FOUND), 'TW1', TestKeys.unsigned(stateDir())).inquireByReference('ANY');

      expect(busy).toBeInstanceOf(Failed);
      expect((busy as Failed).failure).toBeInstanceOf(Busy);
      expect(channel.requests).toEqual([]);
      expect(inquiry, 'an inquiry is never blocked').toBeInstanceOf(Found);
    } finally {
      await other.stop();
    }

    // Killed, not released: the lock file is still there, naming a dead process.
    const lockFile = readdirSync(stateDir()).find((f) => f.startsWith('terminal-') && f.endsWith('.lock'));
    expect(lockFile).toBeDefined();
    expect(JSON.parse(readFileSync(join(stateDir(), lockFile!), 'utf8')).pid).toBe(other.pid);

    expect(await t.sale('1.000', 'ORD-1'), 'a lock left by a dead process is taken over as stale').toBeInstanceOf(Approved);
  });
});
