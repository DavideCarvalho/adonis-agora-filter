import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The package's main entry point must not *load* Lucid.
 *
 * `@adonisjs/lucid` is an optional peer and the README promises the whole library is built on the
 * structural `QueryBuilderLike` adapter — a single value import of `@adonisjs/lucid` anywhere in
 * the barrel's import graph turns that promise into an `ERR_MODULE_NOT_FOUND`, and the suite would
 * never notice, because Lucid *is* a devDependency here.
 *
 * `@adonisjs/core` is deliberately not in scope: the barrel reads the ambient `HttpContext` for the
 * macros and the model mixin, so the framework is a hard runtime requirement and the peer is
 * declared non-optional to match. Lucid is the one that stays structural.
 *
 * Type-only imports are erased at compile time and are fine; this only rejects the ones that
 * survive into the emitted JavaScript. Other entry points (`/testing`, the provider, the commands)
 * are free to require anything — they exist to be used inside an app.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every source file reachable from the barrel, following relative imports. */
function reachableFromBarrel(): string[] {
  const seen = new Set<string>();
  const queue = [resolve(SRC, 'index.ts')];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const specifier = match[1] as string;
      const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      // A prose mention of a path in a doc comment is not an import; only follow real files.
      if (existsSync(target)) queue.push(target);
    }
  }

  return [...seen];
}

/** Imports of `@adonisjs/lucid` that are NOT type-only, i.e. the ones that survive to runtime. */
function valueImportsOfLucid(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const offenders: string[] = [];

  for (const match of source.matchAll(
    /^import\s+(?!type\s)((?:[^;'"])*?)from\s+'(@adonisjs\/lucid[^']*)'/gm,
  )) {
    const clause = match[1] as string;
    // `import { type A, type B } from '…'` is erased too — only a value binding survives.
    const bindings = clause
      .replace(/[{}]/g, '')
      .split(',')
      .map((part) => part.trim());
    if (bindings.some((binding) => binding.length > 0 && !binding.startsWith('type '))) {
      offenders.push(`${match[2] as string} (${clause.trim()})`);
    }
  }

  return offenders;
}

describe('the main entry point keeps Lucid structural', () => {
  it('loads no @adonisjs/lucid module at runtime', () => {
    const offenders = reachableFromBarrel()
      .flatMap((file) =>
        valueImportsOfLucid(file).map((imp) => `${file.slice(SRC.length + 1)}: ${imp}`),
      )
      .sort();

    expect(offenders).toEqual([]);
  });
});
