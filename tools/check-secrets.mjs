#!/usr/bin/env node
/**
 * Fails when the repository holds something that looks like a real secret or
 * card number. Run in CI and before every commit:
 *
 *   node tools/check-secrets.mjs
 *
 * Flags: hex strings of 32+ characters that are not known placeholders, PEM
 * private keys, and Luhn-valid 13-19 digit runs that are not masked. The
 * allow-list holds the synthetic placeholders the tests share with the Windows
 * and PHP SDKs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const placeholders = new Set([
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'cccccccccccccccccccccccccccccccc',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'dddddddddddddddddddddddddddddddd',
  '0123456789ABCDEF0123456789ABCDEF',
  '0123456789abcdef0123456789abcdef',
  '82D83D6C05C1FBFA6AE72AE7C644D614',
  '00000000000000000000000000000001',
  // Published known-answer vectors (docs/protocol.md), outputs of the placeholders above.
  '9425F9125C871197E5D0A6B88E4F9E6E29D1E0E49C96AA3D88A5E34D6FB9D45A',
  'FEF8D18506A6AC035DC825A1DBA4413EE885898BBCE27EE4A681683FFAADC61E',
]);
// Signatures and known answers are HMAC outputs, not secrets: 64 hex characters after a known label.
const signatureContext = /(secureHash|secureHashValue|KnownAnswer|known answer|sign\(|calcHash|toBe\(|toEqual\(|0x|sha256|expected|E1979257)/i;
const idContext = /(nonce|transactionId|receipt|sha256|integrity|shasum|DownloadReceipt|e970c800)/i;
const cardSafe = new Set(['4111111111111111']); // the industry test card number, used to prove masking

const skip = [`${sep}node_modules${sep}`, `${sep}.git${sep}`, `${sep}dist${sep}`, `${sep}coverage${sep}`, `${sep}var${sep}`];
const extensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.md', '.json', '.html', '.css', '.yml', '.yaml', '.txt', '.env', '.ps1', '.sh', '']);
const skipFiles = new Set(['check-secrets.mjs', 'package-lock.json']);

const problems = [];
for (const path of walk(root)) {
  if (skip.some((part) => path.includes(part))) continue;
  const name = path.slice(path.lastIndexOf(sep) + 1);
  if (skipFiles.has(name) || !extensions.has(extname(name).toLowerCase())) continue;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((line, n) => {
    const where = `${relative(root, path)}:${n + 1}`;
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) problems.push(`${where} private key`);
    for (const [candidate] of line.matchAll(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])/g)) {
      if (placeholders.has(candidate) || /^(.)\1+$/.test(candidate)) continue;
      if (candidate.length === 64 && signatureContext.test(line)) continue;
      if (idContext.test(line)) continue;
      problems.push(`${where} long hex string (possible key): ${candidate.slice(0, 8)}…`);
    }
    for (const [candidate] of line.matchAll(/(?<![0-9])[0-9]{13,19}(?![0-9])/g)) {
      if (cardSafe.has(candidate) || !luhn(candidate)) continue;
      problems.push(`${where} Luhn-valid digit run (possible card number): ${candidate.slice(0, 6)}…`);
    }
  });
}

if (problems.length !== 0) {
  console.error('Possible secrets or card data:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('No secrets or card numbers found.');

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
