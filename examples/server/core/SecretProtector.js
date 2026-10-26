import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Encrypts the settings file at rest: AES-256-GCM under a random 256-bit key in
 * `<DataDir>/keys/settings.key`. The counterpart of the web sample's ASP.NET
 * Core Data Protection key ring, and the same file format as the PHP sample
 * (`AEX1 | iv | tag | ciphertext`).
 *
 * The key file is not itself encrypted: what protects it is the data folder's
 * permissions (NTFS ACLs on Windows, 0700/0600 elsewhere). Anyone who can read
 * the folder can decrypt the settings. Back up `keys/` together with
 * `settings.dat`, or accept re-entering the keys.
 */
export class SecretProtector {
  static #MAGIC = Buffer.from('AEX1', 'latin1');

  #keyDirectory;

  constructor(keyDirectory) {
    this.#keyDirectory = keyDirectory;
  }

  protect(plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key(true), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([SecretProtector.#MAGIC, iv, cipher.getAuthTag(), encrypted]);
  }

  /** @throws Error when the data was not encrypted with this folder's key */
  unprotect(data) {
    if (data.length < 32 || !data.subarray(0, 4).equals(SecretProtector.#MAGIC)) {
      throw new Error('The file is not in the expected format.');
    }
    const key = this.#key(false);
    if (key === null) throw new Error(`The key in ${this.#keyDirectory} is missing.`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
      decipher.setAuthTag(data.subarray(16, 32));
      return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`The key in ${this.#keyDirectory} does not decrypt it.`);
    }
  }

  #key(create) {
    const path = join(this.#keyDirectory, 'settings.key');
    if (existsSync(path)) {
      const key = readFileSync(path);
      if (key.length === 32) return key;
    }
    if (!create) return null;
    mkdirSync(this.#keyDirectory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.#keyDirectory, 0o700);
    } catch {
      // Windows: NTFS permissions apply instead.
    }
    const key = randomBytes(32);
    writeFileSync(path, key, { mode: 0o600 });
    return key;
  }
}
