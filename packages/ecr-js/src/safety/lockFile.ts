import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { RuntimeException } from '../exception/errors.js';

/**
 * A lock as a file created exclusively (`wx`), holding the owner's process id.
 *
 * Node has no `flock`, so the operating system cannot release the lock when a
 * process dies. Instead a lock whose owner process is gone is stale and taken
 * over: a crashed till never leaves a terminal locked for good. The folder
 * must be on a local disk, so that the process ids in it mean this machine.
 *
 * @internal
 */
export interface LockHolder {
  pid: number;
  host: string;
  token: string;
  createdAt: string;
}

/** A lock file that cannot be read yet is being written; after this long it was abandoned mid-write. */
const UNREADABLE_GRACE_MS = 10_000;

export function ensureDirectory(directory: string, what = 'The ECR state folder'): void {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new RuntimeException(`${what} cannot be created: ${directory}`, { cause: error });
  }
}

/**
 * Takes the lock at `path` without waiting.
 *
 * @returns the release function, or null when a live process holds it
 * @throws RuntimeException the lock file cannot be created for another reason
 */
export function tryLockFile(path: string): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomBytes(8).toString('hex');
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        const holder: LockHolder = { pid: process.pid, host: hostname(), token, createdAt: new Date().toISOString() };
        writeSync(fd, JSON.stringify(holder));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only our own lock: one taken over as stale belongs to someone else now.
        if (readHolder(path)?.token === token) {
          try {
            unlinkSync(path);
          } catch {
            // Already gone.
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new RuntimeException('The ECR lock cannot be opened: ' + path, { cause: error });
      }
      if (!isStale(path)) return null;
      try {
        unlinkSync(path);
      } catch {
        // Another process took it over first; the next attempt finds out.
      }
    }
  }
  return null;
}

/**
 * Takes the lock at `path`, waiting up to `timeoutMs` for another holder to
 * release it. The waits are short (a journal write), so this blocks.
 *
 * @throws RuntimeException the lock could not be taken in time
 */
export function lockFile(path: string, timeoutMs: number, what: string): () => void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryLockFile(path);
    if (release !== null) return release;
    if (Date.now() >= deadline) throw new RuntimeException(`${what} could not be locked: ${path}`);
    sleep(5);
  }
}

function readHolder(path: string): LockHolder | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockHolder>;
    if (typeof data.pid === 'number' && typeof data.token === 'string') {
      return { pid: data.pid, host: String(data.host ?? ''), token: data.token, createdAt: String(data.createdAt ?? '') };
    }
  } catch {
    // Unreadable: see isStale.
  }
  return null;
}

function isStale(path: string): boolean {
  const holder = readHolder(path);
  if (holder === null) {
    try {
      return Date.now() - statSync(path).mtimeMs > UNREADABLE_GRACE_MS;
    } catch {
      return true; // gone already
    }
  }
  // Another machine's process ids mean nothing here: never take its lock over.
  if (holder.host !== '' && holder.host !== hostname()) return false;
  return !isAlive(holder.pid);
}

function isAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}
