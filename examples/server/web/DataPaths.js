import { chmodSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The data folder: `AMWAL_ECR_EXAMPLE_DATA`, or the per-user app-data folder
 * `AmwalECR-JS-Example` (`%LOCALAPPDATA%` on Windows, `~/.local/share` elsewhere).
 *
 * | Path             | What                                                     |
 * |------------------|----------------------------------------------------------|
 * | `terminals.json` | Terminal list, keyed by serial                           |
 * | `settings.dat`   | Environment and both signing keys, encrypted             |
 * | `keys/`          | The key that decrypts settings.dat                       |
 * | `runs/`          | Server-owned transactions the page polls                 |
 * | `log.txt`        | The last 500 SDK log lines                               |
 * | `sdk-state/`     | The SDK's terminal lock and merchant-reference journal   |
 */
export class DataPaths {
  constructor(root = null) {
    let base = root ?? process.env.AMWAL_ECR_EXAMPLE_DATA ?? '';
    if (base === '') {
      const appData = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || join(homedir() || tmpdir(), '.local', 'share');
      base = join(appData, 'AmwalECR-JS-Example');
    }
    this.root = base.replace(/[\\/]+$/, '');
  }

  terminals() {
    return join(this.root, 'terminals.json');
  }

  settings() {
    return join(this.root, 'settings.dat');
  }

  keys() {
    return join(this.root, 'keys');
  }

  runs() {
    return join(this.root, 'runs');
  }

  log() {
    return join(this.root, 'log.txt');
  }

  sdkState() {
    return join(this.root, 'sdk-state');
  }

  /** Creates the folders. A root created here is private (0700 on Unix); `keys` always is. */
  ensure() {
    for (const directory of [this.root, this.keys(), this.runs(), this.sdkState()]) {
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      } catch {
        throw new Error('The data folder cannot be created: ' + directory);
      }
    }
    try {
      chmodSync(this.keys(), 0o700);
    } catch {
      // Windows: NTFS permissions apply instead.
    }
  }
}
