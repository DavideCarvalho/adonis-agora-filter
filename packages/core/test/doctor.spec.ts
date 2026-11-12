import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import FilterProvider from '../providers/filter_provider.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from '../src/doctor/agora_doctor.js';
import { codeShape, DEFAULT_CLIENT_OUTPUT, filterDoctorChecks } from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';
import { defineFilter } from '../src/filter_spec.js';
import { generateFilterClients } from '../src/generate_client.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fixture app root; `filters` goes into the `filter` config (what the loader also reads). */
function fakeApp(opts: { filters?: unknown; files?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'filter-doctor-'));
  roots.push(root);
  for (const [file, source] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return {
    root,
    app: {
      makePath: (...parts: string[]) => join(root, ...parts),
      makeURL: (...parts: string[]) => pathToFileURL(join(root, ...parts)),
      config: {
        get: (key: string, fallback?: unknown) =>
          key === 'filter' && opts.filters !== undefined ? { filters: opts.filters } : fallback,
      },
    } as never,
  };
}

async function run(app: never): Promise<AgoraDoctorResult[]> {
  const check = filterDoctorChecks()[0] as AgoraDoctorCheck;
  const out = await check.run(app);
  return Array.isArray(out) ? out : [out];
}

const manifest = {
  people: { spec: defineFilter({ filterable: ['name', 'age'] }) },
  posts: { spec: defineFilter({ filterable: ['title'] }) },
};

function clientFiles(only?: string[]) {
  const files: Record<string, string> = {};
  for (const client of generateFilterClients(manifest)) {
    if (only && !only.includes(client.name)) continue;
    files[`${DEFAULT_CLIENT_OUTPUT}/${client.filename}`] = client.code;
  }
  return files;
}

describe('filter doctor checks', () => {
  it('has the frozen id and is exported for --no-boot', () => {
    expect(filterDoctorChecks().map((c) => c.id)).toEqual(['filter.manifest']);
    expect(agoraDoctorChecks).toHaveLength(1);
  });

  it('skips without a manifest, errors on a broken one, warns on an empty one', async () => {
    expect((await run(fakeApp().app))[0]?.status).toBe('skip');
    const broken = await run(
      fakeApp({ files: { 'config/filter.js': "throw new Error('bad spec')" } }).app,
    );
    expect(broken[0]).toMatchObject({ status: 'error' });
    expect(broken[0]?.message).toContain('bad spec');
    const empty = await run(fakeApp({ files: { 'config/filter.js': 'export const x = 1' } }).app);
    expect(empty[0]?.status).toBe('warn');
  });

  it('lists the specs; no generated clients is fine', async () => {
    const out = await run(fakeApp({ filters: manifest }).app);
    expect(out).toEqual([{ status: 'ok', message: '2 spec(s): people, posts' }]);
  });

  it('is ok when the clients match the manifest, even reformatted', async () => {
    const files = clientFiles();
    for (const key of Object.keys(files)) {
      // What a formatter does to code: quote style, semicolons, indentation. Comments stay.
      files[key] = (files[key] as string)
        .split('\n')
        .map((line) =>
          /^\s*(\/\/|\/\*|\*)/.test(line) ? line : `  ${line.replace(/'/g, '"').replace(/;$/, '')}`,
        )
        .join('\n');
    }
    const out = await run(fakeApp({ filters: manifest, files }).app);
    expect(out[1]).toMatchObject({ status: 'ok' });
  });

  it('warns on stale, missing and orphaned clients', async () => {
    const files = {
      ...clientFiles(['people']),
      [`${DEFAULT_CLIENT_OUTPUT}/old_filter_client.ts`]: 'export {}',
    };
    const peopleFile = Object.keys(files)[0] as string;
    files[peopleFile] = `${files[peopleFile]}\nexport const extra = 1`;
    const out = await run(fakeApp({ filters: manifest, files }).app);
    expect(out[1]).toMatchObject({ status: 'warn' });
    expect(out[1]?.message).toContain('out of date: people_filter_client.ts');
    expect(out[1]?.message).toContain('missing: posts_filter_client.ts');
    expect(out[1]?.message).toContain('no longer in the manifest: old_filter_client.ts');
    expect(out[1]?.fix).toContain('node ace make:filter-client');
  });

  it('codeShape ignores formatting only', () => {
    expect(codeShape("const a = { b: 'c', };\n")).toBe(codeShape('const a = {b: "c"}'));
    expect(codeShape("const a = 'b'")).not.toBe(codeShape("const a = 'c'"));
    // Changes inside a string literal still count.
    expect(codeShape("const a = 'x,y'")).not.toBe(codeShape("const a = 'xy'"));
    expect(codeShape("const a = 'x y'")).not.toBe(codeShape("const a = 'xy'"));
    expect(codeShape('// a, b\nconst x = 1;')).toBe(codeShape('//  a,b\nconst x = 1'));
  });

  it('the provider registers the check into agora.doctor from boot()', async () => {
    const values = new Map<string, unknown>();
    const app = {
      config: { get: (_k: string, fallback: unknown) => fallback },
      container: {
        hasBinding: (key: string) => values.has(key),
        bindValue: (key: string, value: unknown) => values.set(key, value),
        make: async (key: string) => values.get(key),
      },
    };
    await new FilterProvider(app as never).boot();
    const registry = values.get('agora.doctor') as { checks: AgoraDoctorCheck[] };
    expect(registry.checks.map((c) => c.id)).toEqual(['filter.manifest']);
  });
});
