import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

/**
 * `VERSION` is a hand-written literal, so nothing but this test stops it drifting
 * from the version actually published — it sat at `0.1.0` through five releases.
 * Consumers read it to gate on a feature, so a stale value is a wrong answer, not
 * a cosmetic slip.
 */
describe('VERSION', () => {
  it('matches the version in package.json', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(VERSION).toBe(pkg.version);
  });
});
