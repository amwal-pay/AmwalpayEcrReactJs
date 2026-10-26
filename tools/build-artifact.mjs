#!/usr/bin/env node
/**
 * Builds the exact package artifacts the example and SIT consume:
 *
 *   node tools/build-artifact.mjs   ->  dist/amwalpay-ecr-js-<version>.tgz     (+ .sha256)
 *                                       dist/amwalpay-ecr-react-<version>.tgz  (+ .sha256)
 *
 * Each tarball is what `npm pack` makes of the package: package.json, the
 * compiled `dist/`, and its documents. Tests, tools and examples are left out.
 * The version comes from EcrSdk.VERSION and must match both package.json files
 * and have a CHANGELOG entry. npm stamps every file with a fixed date, so the
 * same sources produce the same archive.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const sdk = read('packages/ecr-js/src/EcrSdk.ts');
const version = /VERSION = '([^']+)'/.exec(sdk)?.[1];
if (!version) fail('EcrSdk.VERSION not found');
if (!/^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$/.test(version)) fail(`EcrSdk.VERSION is not a semantic version: ${version}`);
for (const name of ['ecr-js', 'ecr-react']) {
  const pkg = JSON.parse(read(`packages/${name}/package.json`));
  if (pkg.version !== version) fail(`packages/${name}/package.json is ${pkg.version}, EcrSdk.VERSION is ${version}`);
}
if (!read('CHANGELOG.md').includes(`## ${version}`)) fail(`CHANGELOG.md has no entry for ${version}`);

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const run = (command, cwd = root) => execSync(command, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
run('npm run build');

for (const name of ['ecr-js', 'ecr-react']) {
  const file = `amwalpay-${name}-${version}.tgz`;
  rmSync(join(dist, file), { force: true });
  run(`npm pack --pack-destination "${dist}"`, join(root, 'packages', name));
  const sha256 = createHash('sha256').update(readFileSync(join(dist, file))).digest('hex');
  writeFileSync(join(dist, `${file}.sha256`), `${sha256}  ${file}\n`);
  console.log(`Built ${file}`);
  console.log(`sha256 ${sha256}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
