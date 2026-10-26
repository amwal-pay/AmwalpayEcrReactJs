#!/usr/bin/env node
/**
 * Runs before `npm pack` / `npm publish` of a package (its `prepack` script):
 * copies the documents that live at the repository root into the package, so
 * the tarball carries the same docs, CHANGELOG and SECURITY as the repository.
 *
 *   node tools/prepare-package.mjs ecr-js
 *
 * The copies are build output (see .gitignore); edit the originals at the root.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
if (name !== 'ecr-js' && name !== 'ecr-react') {
  console.error('usage: node tools/prepare-package.mjs ecr-js|ecr-react');
  process.exit(2);
}
const target = join(root, 'packages', name);

const copies = name === 'ecr-js'
  ? [['docs', 'docs'], ['CHANGELOG.md', 'CHANGELOG.md'], ['SECURITY.md', 'SECURITY.md']]
  : [['CHANGELOG.md', 'CHANGELOG.md']];

for (const [from, to] of copies) {
  const source = join(root, from);
  if (!existsSync(source)) continue;
  rmSync(join(target, to), { recursive: true, force: true });
  cpSync(source, join(target, to), { recursive: true });
}
if (!existsSync(join(target, 'dist', 'index.js'))) {
  console.error(`packages/${name}/dist is missing: run "npm run build" first`);
  process.exit(1);
}
