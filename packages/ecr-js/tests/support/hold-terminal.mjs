#!/usr/bin/env node
/**
 * Another process running a long Wi-Fi sale: takes the terminal through the
 * SDK's own lock, says so, and holds it until killed.
 *
 *   node tests/support/hold-terminal.mjs <state-dir> <terminal-key>
 *
 * Imports the built SDK (run `npm run build` first).
 */
import { FileTerminalLock } from '../../dist/index.js';

const lock = new FileTerminalLock(process.argv[2]);
const release = lock.tryAcquire(process.argv[3]);
if (release === null) {
  process.stdout.write('BUSY\n');
  process.exit(1);
}
process.stdout.write('LISTENING locked:1\n');
setTimeout(() => {
  release();
}, 60_000);
