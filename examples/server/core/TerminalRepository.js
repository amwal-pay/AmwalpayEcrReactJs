import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Terminal } from './Terminal.js';

/**
 * All terminal persistence: a JSON file keyed by serial number, the same shape
 * as the Windows samples' terminals.json.
 *
 * The file is tiny, so every call reads and writes it whole. A write goes to a
 * temp file that then replaces the original, so a crash mid-save leaves the
 * previous list rather than half of a new one.
 */
export class TerminalRepository {
  /** Set when the file existed but could not be read; it was set aside, not deleted. */
  loadWarning = null;

  #path;
  #terminals = [];

  constructor(path) {
    this.#path = path;
    this.#load();
  }

  /** Ordered by name (case-insensitive), then serial. */
  getAll() {
    this.#load();
    return TerminalRepository.#sorted(this.#terminals);
  }

  findBySerial(serialNumber) {
    this.#load();
    return this.#terminals.find((t) => t.serialNumber === serialNumber) ?? null;
  }

  /**
   * Inserts a new terminal, or updates the one identified by `originalSerial`.
   * Changing the serial of an existing terminal replaces the entry.
   *
   * @returns null when saved, otherwise why not
   */
  save(terminal, originalSerial) {
    try {
      this.#load();
      const serialChanged = originalSerial !== terminal.serialNumber;
      if (serialChanged && this.#terminals.some((t) => t.serialNumber === terminal.serialNumber)) {
        return 'A terminal with this serial number already exists';
      }
      const next = this.#terminals.filter((t) => originalSerial === null || t.serialNumber !== originalSerial);
      next.push(terminal);
      this.#write(next);
      this.#terminals = next;
      return null;
    } catch (error) {
      return error.message || 'Could not save terminal';
    }
  }

  /** @returns null when deleted, otherwise why not */
  delete(serialNumber) {
    try {
      this.#load();
      const next = this.#terminals.filter((t) => t.serialNumber !== serialNumber);
      this.#write(next);
      this.#terminals = next;
      return null;
    } catch (error) {
      return error.message || 'Could not delete terminal';
    }
  }

  static #sorted(terminals) {
    return [...terminals].sort((a, b) => {
      const byName = a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
      return byName !== 0 ? byName : a.serialNumber < b.serialNumber ? -1 : a.serialNumber > b.serialNumber ? 1 : 0;
    });
  }

  #load() {
    if (!existsSync(this.#path)) {
      this.#terminals = [];
      return;
    }
    let data = null;
    let reason = 'unreadable';
    try {
      data = JSON.parse(readFileSync(this.#path, 'utf8'));
    } catch (error) {
      reason = error.message;
    }
    if (data === null || typeof data !== 'object' || !Array.isArray(data.terminals)) {
      // Never silently overwrite what could not be read: keep it beside the
      // new file so the operator can recover the entries by hand.
      let aside = this.#path + '.unreadable';
      try {
        copyFileSync(this.#path, aside);
      } catch {
        aside = '(could not be copied)';
      }
      this.loadWarning = `The saved terminal list could not be read (${reason}). A copy was kept at ${aside}.`;
      this.#terminals = [];
      return;
    }
    const seen = new Set();
    const terminals = [];
    for (const row of data.terminals) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
      const terminal = Terminal.fromJSON(row);
      // Keyed by serial: a hand-edited duplicate keeps the first.
      if (terminal.serialNumber === '' || seen.has(terminal.serialNumber)) continue;
      seen.add(terminal.serialNumber);
      terminals.push(terminal);
    }
    this.#terminals = terminals;
  }

  #write(terminals) {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const json = JSON.stringify({ terminals: TerminalRepository.#sorted(terminals).map((t) => t.toJSON()) }, null, 4);
    const temp = this.#path + '.tmp';
    try {
      writeFileSync(temp, json);
      renameSync(temp, this.#path);
    } catch {
      try {
        unlinkSync(temp);
      } catch {
        // Never written.
      }
      throw new Error('Could not save terminal');
    }
  }
}
