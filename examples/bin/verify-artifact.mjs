#!/usr/bin/env node
/**
 * Proves the example runs on the built package artifacts, not on the SDK's
 * source tree: prints the installed versions, where they were installed from,
 * and the artifacts' checksums, and fails if a package resolves into ../packages.
 *
 *   npm run verify-artifact
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const example = join(here, '..');
const repository = join(example, '..');
const require = createRequire(join(example, 'package.json'));
const lock = existsSync(join(example, 'package-lock.json')) ? JSON.parse(readFileSync(join(example, 'package-lock.json'), 'utf8')) : null;

const { EcrSdk } = await import('@amwalpay/ecr-js');
let failed = false;

for (const name of ['@amwalpay/ecr-js', '@amwalpay/ecr-react']) {
  const manifest = realpathSync(require.resolve(`${name}/package.json`));
  const installed = dirname(manifest);
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const resolved = lock?.packages?.[`node_modules/${name}`]?.resolved ?? '-';
  const file = `amwalpay-${name.split('/')[1]}-${pkg.version}.tgz`;
  const tarball = join(repository, 'dist', file);

  console.log(`Package:      ${name} ${pkg.version}`);
  console.log(`Resolved:     ${resolved}`);
  console.log(`Installed in: ${installed}`);
  if (existsSync(tarball)) {
    const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    const recorded = existsSync(`${tarball}.sha256`) ? readFileSync(`${tarball}.sha256`, 'utf8').trim() : '-';
    console.log(`Artifact:     ${recorded}`);
    if (!recorded.startsWith(actual)) {
      console.error(`FAIL: ${file} does not match its .sha256`);
      failed = true;
    }
  }
  if (installed.startsWith(join(repository, 'packages') + sep)) {
    console.error(`FAIL: ${name} is loaded from its source tree, not from the artifact`);
    failed = true;
  }
  if (pkg.version !== EcrSdk.VERSION) {
    console.error(`FAIL: ${name} ${pkg.version} and EcrSdk.VERSION ${EcrSdk.VERSION} differ`);
    failed = true;
  }
}
console.log(`EcrSdk says:  ${EcrSdk.VERSION} (${EcrSdk.PARITY_WITH})`);

if (failed) process.exit(1);
console.log('OK: the example runs on the built artifacts');
