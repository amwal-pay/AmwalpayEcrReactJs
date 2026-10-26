import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Redactor } from '@amwalpay/ecr-js';

/**
 * The last {@link LogBuffer.CAPACITY} lines of SDK diagnostics, kept in one
 * file so they survive a restart. Each line is stamped `HH:mm:ss.fff` in server
 * local time, then a tag (`Ecr`, `EcrWebService`).
 */
export class LogBuffer {
  static CAPACITY = 500;

  #path;
  #lines = null;

  constructor(path) {
    this.#path = path;
  }

  append(tag, message) {
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
    // One line per entry: a multi-line message keeps its lines together under one stamp.
    const line = `${stamp} ${tag} ${Redactor.line(String(message)).replace(/\r\n|\n|\r/g, ' ')}`;
    const lines = this.#read();
    lines.push(line);
    if (lines.length > LogBuffer.CAPACITY) lines.splice(0, lines.length - LogBuffer.CAPACITY);
    this.#write(lines);
  }

  clear() {
    this.#write([]);
  }

  snapshot() {
    const lines = this.#read();
    return lines.length === 0 ? '' : lines.join('\n') + '\n';
  }

  count() {
    return this.#read().length;
  }

  #read() {
    if (this.#lines === null) {
      let text = '';
      try {
        text = existsSync(this.#path) ? readFileSync(this.#path, 'utf8') : '';
      } catch {
        text = '';
      }
      this.#lines = text.split('\n').filter((l) => l !== '');
    }
    return this.#lines;
  }

  #write(lines) {
    this.#lines = lines;
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      writeFileSync(this.#path, lines.length === 0 ? '' : lines.join('\n') + '\n');
    } catch {
      // A log that cannot be written must never break a payment.
    }
  }
}
