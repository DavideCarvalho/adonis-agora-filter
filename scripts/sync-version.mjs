/**
 * Sync each package's hand-written `VERSION` export with the version changesets just wrote into
 * its package.json.
 *
 * `VERSION` is a literal in source, so a `changeset version` run leaves it behind by design. That
 * drift has shipped twice: once as a stale value consumers read to gate on a feature, once as a
 * red CI on master when `version.spec.ts` caught it after the merge. Running this as part of
 * `version-packages` closes the window — the test stays as the proof, this removes the mistake.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = join(import.meta.dirname, '..', 'packages');
const PATTERN = /(export const VERSION = ')([^']*)(')/;

let changed = 0;
for (const name of readdirSync(PACKAGES)) {
  const pkgPath = join(PACKAGES, name, 'package.json');
  const indexPath = join(PACKAGES, name, 'src', 'index.ts');

  let version;
  try {
    version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  } catch {
    continue;
  }

  let source;
  try {
    source = readFileSync(indexPath, 'utf8');
  } catch {
    continue;
  }
  if (!PATTERN.test(source)) continue;

  const updated = source.replace(PATTERN, `$1${version}$3`);
  if (updated === source) continue;

  writeFileSync(indexPath, updated);
  console.log(`sync-version: ${name} → ${version}`);
  changed += 1;
}

if (changed === 0) console.log('sync-version: every VERSION already matches its package.json');
