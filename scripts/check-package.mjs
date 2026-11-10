/**
 * Lint every published package the way a consumer will receive it: `publint` checks the
 * package.json against the packed files, `attw` checks that each `exports` subpath resolves to
 * types and JavaScript. Run after `pnpm build`.
 *
 * Every package here is ESM-only, so attw uses the `esm-only` profile (CJS `require` and node10
 * resolution are not supported targets).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = join(import.meta.dirname, '..', 'packages');

const run = (bin, args) => execFileSync('pnpm', ['exec', bin, ...args], { stdio: 'inherit' });

let checked = 0;
for (const name of readdirSync(PACKAGES).sort()) {
  const dir = join(PACKAGES, name);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (pkg.private) continue;

  console.log(`\n▶ ${pkg.name}`);
  run('publint', ['--strict', dir]);
  run('attw', ['--pack', dir, '--profile', 'esm-only']);
  checked++;
}

if (checked === 0) {
  console.error('check-package: no publishable packages found');
  process.exit(1);
}
