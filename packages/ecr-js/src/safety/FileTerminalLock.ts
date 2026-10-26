import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { TerminalLock } from './contracts.js';
import { ensureDirectory, tryLockFile } from './lockFile.js';

/**
 * A terminal lock as a file created exclusively in the state folder. Held by
 * this process and every other on the machine; a lock whose owner process has
 * died is taken over, so a crashed till never leaves a terminal locked.
 * Works on Windows, Linux and macOS.
 */
export class FileTerminalLock implements TerminalLock {
  constructor(private readonly directory: string) {}

  tryAcquire(terminalKey: string): (() => void) | null {
    ensureDirectory(this.directory);
    const name = 'terminal-' + createHash('sha256').update(terminalKey).digest('hex').slice(0, 32) + '.lock';
    return tryLockFile(join(this.directory, name));
  }
}
