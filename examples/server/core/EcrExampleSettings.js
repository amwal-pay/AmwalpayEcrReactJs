import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EcrEnvironment } from '@amwalpay/ecr-js';
import { EcrMode } from './EcrMode.js';

const DEFAULTS = Object.freeze({ environment: 'SIT', wifiSecureHashKey: '', webServiceSecureHashKey: '' });

/**
 * App-owned signing and Web Service settings: the environment and the two
 * signing keys, stored encrypted in `settings.dat`. The SDK does not store or
 * choose keys; {@link secureHashKeyFor} picks one for the selected terminal.
 */
export class EcrExampleSettings {
  /** Set when the file existed but could not be decrypted (another folder's key, or damage). */
  loadWarning = null;

  /** The last error from writing the file, or null. Cleared by the next good write. */
  saveError = null;

  #values = { ...DEFAULTS };
  #path;
  #protector;

  constructor(path, protector) {
    this.#path = path;
    this.#protector = protector;
    this.#load();
  }

  environment() {
    return EcrEnvironment.fromName(this.#values.environment);
  }

  setEnvironment(environment) {
    this.#update('environment', environment.value);
  }

  /** Signing key for Wi-Fi (USB cable and Bluetooth share it). */
  wifiSecureHashKey() {
    return this.#values.wifiSecureHashKey;
  }

  setWifiSecureHashKey(key) {
    this.#update('wifiSecureHashKey', String(key).trim());
  }

  /** Web Service signing key: a different secret from the Wi-Fi one. */
  webServiceSecureHashKey() {
    return this.#values.webServiceSecureHashKey;
  }

  setWebServiceSecureHashKey(key) {
    this.#update('webServiceSecureHashKey', String(key).trim());
  }

  /** The secret to put on the SDK config for the selected terminal mode. */
  secureHashKeyFor(mode) {
    return mode === EcrMode.WebService ? this.webServiceSecureHashKey() : this.wifiSecureHashKey();
  }

  /** What console.log shows: never a key. */
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return { environment: this.#values.environment, keys: '<redacted>' };
  }

  toJSON() {
    return { environment: this.#values.environment, keys: '<redacted>' };
  }

  #update(name, value) {
    const next = { ...this.#values, [name]: value };
    this.#values = next;
    try {
      this.#write(next);
      this.saveError = null;
      // The file that could not be read has just been replaced by a good one.
      this.loadWarning = null;
    } catch (error) {
      // The value stays in memory for this process, but say so: a key that
      // silently fails to persist is a support call after the next restart.
      this.saveError = 'Could not save settings: ' + error.message;
    }
  }

  #load() {
    if (!existsSync(this.#path)) return;
    try {
      let data;
      try {
        data = readFileSync(this.#path);
      } catch {
        throw new Error('The file could not be read.');
      }
      const values = JSON.parse(this.#protector.unprotect(data));
      if (values === null || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error('The file is not in the expected format.');
      }
      for (const name of Object.keys(DEFAULTS)) {
        if (typeof values[name] === 'string') this.#values[name] = values[name];
      }
    } catch (error) {
      this.loadWarning = 'The saved settings could not be read (they are encrypted with the key in the data folder): '
        + error.message + ' Enter the signing keys again.';
      this.#values = { ...DEFAULTS };
    }
  }

  #write(values) {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const bytes = this.#protector.protect(JSON.stringify(values));
    const temp = `${this.#path}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, bytes, { mode: 0o600 });
      renameSync(temp, this.#path);
    } catch {
      try {
        unlinkSync(temp);
      } catch {
        // Never written.
      }
      throw new Error('The settings file could not be written.');
    }
  }
}
