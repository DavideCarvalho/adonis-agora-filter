import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import FilterProvider from '../providers/filter_provider.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from '../src/doctor/agora_doctor.js';
import {
  clientMatches,
  codeShape,
  DEFAULT_CLIENT_OUTPUT,
  filterDoctorChecks,
  findClientDirs,
} from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';
import { defineFilter } from '../src/filter_spec.js';
import {
  CONTENT_HASH_PREFIX,
  generateFilterClient,
  generateFilterClients,
  readFilterClientContentHash,
} from '../src/generate_client.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fixture app root; `filters` goes into the `filter` config (what the loader also reads). */
function fakeApp(
  opts: { filters?: unknown; codegen?: unknown; files?: Record<string, string> } = {},
) {
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
          key === 'filter' && opts.filters !== undefined
            ? { filters: opts.filters, codegen: opts.codegen }
            : fallback,
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

function clientFiles(only?: string[], dir = DEFAULT_CLIENT_OUTPUT) {
  const files: Record<string, string> = {};
  for (const client of generateFilterClients(manifest)) {
    if (only && !only.includes(client.name)) continue;
    files[`${dir}/${client.filename}`] = client.code;
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

  it('lists the specs; no generated clients anywhere is reported as skipped, with the path', async () => {
    const out = await run(fakeApp({ filters: manifest }).app);
    expect(out[0]).toEqual({ status: 'ok', message: '2 spec(s): people, posts' });
    expect(out[1]).toMatchObject({ status: 'skip' });
    expect(out[1]?.message).toContain(`no generated clients in ${DEFAULT_CLIENT_OUTPUT}`);
    expect(out[1]?.message).toContain('codegen.output');
    expect(out).toHaveLength(2);
  });

  it('checks the clients in codegen.output from the filter config', async () => {
    const dir = 'inertia/generated/filters';
    const ok = await run(
      fakeApp({ filters: manifest, codegen: { output: dir }, files: clientFiles(undefined, dir) })
        .app,
    );
    expect(ok[1]).toEqual({ status: 'ok', message: `the clients in ${dir} match the manifest` });

    const stale = await run(
      fakeApp({ filters: manifest, codegen: { output: dir }, files: clientFiles(['people'], dir) })
        .app,
    );
    expect(stale[1]).toMatchObject({ status: 'warn' });
    expect(stale[1]?.message).toContain(`clients in ${dir}`);
    expect(stale[1]?.message).toContain('missing: posts_filter_client.ts');
  });

  it('reads codegen.output from a named export of config/filter.ts', async () => {
    const dir = 'resources/js/filters';
    const files = {
      ...clientFiles(undefined, dir),
      'config/filter.js': `export const codegen = { output: '${dir}' }`,
    };
    const out = await run(fakeApp({ filters: manifest, files }).app);
    expect(out[1]?.message).toBe(`the clients in ${dir} match the manifest`);
  });

  it('warns when codegen.output is set but holds no clients', async () => {
    const out = await run(fakeApp({ filters: manifest, codegen: { output: 'web/filters' } }).app);
    expect(out[1]).toMatchObject({ status: 'warn', fix: 'Run `node ace make:filter-client`' });
    expect(out[1]?.message).toContain('web/filters');
  });

  it('finds clients written elsewhere by their banner, checks them, and asks for codegen.output', async () => {
    const dir = 'inertia/generated/filters';
    const files = {
      ...clientFiles(['people'], dir),
      // Same file name without the banner: not a generated client.
      'app/other/x_filter_client.ts': 'export {}',
      'node_modules/pkg/posts_filter_client.ts': generateFilterClients(manifest)[1]?.code ?? '',
    };
    const out = await run(fakeApp({ filters: manifest, files }).app);
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({ status: 'warn' });
    expect(out[1]?.message).toContain(`clients in ${dir}`);
    expect(out[1]?.message).toContain('missing: posts_filter_client.ts');
    expect(out[2]).toMatchObject({ status: 'warn' });
    expect(out[2]?.message).toContain(`generated clients are in ${dir}`);
    expect(out[2]?.fix).toContain(`codegen: { output: '${dir}' }`);
  });

  it('findClientDirs skips node_modules, dot-dirs and the excluded dir', async () => {
    const code = generateFilterClients(manifest)[0]?.code ?? '';
    const { root } = fakeApp({
      files: {
        'a/people_filter_client.ts': code,
        'b/c/people_filter_client.ts': code,
        'node_modules/x/people_filter_client.ts': code,
        '.cache/people_filter_client.ts': code,
        'skip/people_filter_client.ts': code,
      },
    });
    expect(await findClientDirs(root, join(root, 'skip'))).toEqual(['a', 'b/c']);
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
    // Generated from an older version of the spec (one field fewer).
    files[peopleFile] = generateFilterClient(defineFilter({ filterable: ['name'] }), {
      name: 'people',
    });
    const out = await run(fakeApp({ filters: manifest, files }).app);
    expect(out[1]).toMatchObject({ status: 'warn' });
    expect(out[1]?.message).toContain('out of date: people_filter_client.ts');
    expect(out[1]?.message).toContain('missing: posts_filter_client.ts');
    expect(out[1]?.message).toContain('no longer in the manifest: old_filter_client.ts');
    expect(out[1]?.fix).toContain('node ace make:filter-client');
  });

  /** The client {@link typedSpec} generates, exactly as prettier 3.9 printed it (`@adonisjs/prettier-config`). */
  const typedSpec = defineFilter({
    filterable: ['name', 'age', 'status', 'createdAt', 'organization.name', 'ownerEmail'],
    sortable: ['createdAt', 'name', 'age', 'status', 'organizationName', 'veryLongFieldNameOne'],
    fieldTypes: {
      age: { kind: 'number' },
      status: { enumValues: ['active', "it's off"], nullable: true },
    },
  });
  const prettierBody = `import { filterQueryTyped as _filterQueryTyped } from '@adonis-agora/filter-client'

/** Filterable field paths for \`people\` — the client's field-name allow-list. */
export type PeopleFilterFields =
  'name' | 'age' | 'status' | 'createdAt' | 'organization.name' | 'ownerEmail'

/** Per-field value types for \`people\` (drives operator narrowing). */
export interface PeopleFilterFieldTypes {
  age: number
  status: 'active' | "it's off" | null
}

/** Runtime filter metadata for \`people\`. */
export const peopleFilterMeta = {
  fields: ['name', 'age', 'status', 'createdAt', 'organization.name', 'ownerEmail'],
  sortable: ['createdAt', 'name', 'age', 'status', 'organizationName', 'veryLongFieldNameOne'],
  searchable: [],
  relations: [],
  types: { age: 'number', status: 'unknown' },
  defaultSort: [],
  cursorKeyset: [],
  defaultSize: undefined,
  maxSize: undefined,
} as const

/** A type-safe filter-query builder scoped to \`people\`'s filterable fields. */
export function peopleFilterQuery() {
  return _filterQueryTyped<PeopleFilterFields, PeopleFilterFieldTypes>()
}
`;

  it('a prettier-formatted client matches by its content hash', () => {
    const fresh = generateFilterClient(typedSpec, { name: 'people' });
    const hashLine = fresh.split('\n').find((line) => line.startsWith(CONTENT_HASH_PREFIX));
    expect(hashLine).toMatch(/^\/\/ Content hash: sha256:[0-9a-f]{16}$/);
    const formatted = `${fresh.split('\n').slice(0, 4).join('\n')}\n${prettierBody}`;
    expect(readFilterClientContentHash(formatted)).toBe(readFilterClientContentHash(fresh));
    expect(clientMatches(formatted, fresh)).toBe(true);

    // The spec changed: the fresh hash differs, however the old file was formatted.
    const changed = generateFilterClient(
      defineFilter({ ...typedSpec, filterable: [...typedSpec.filterable, 'email'] } as never),
      { name: 'people' },
    );
    expect(clientMatches(formatted, changed)).toBe(false);
  });

  it('the hash is found below a license header, and a hand edit with an intact hash reads as ok', () => {
    const fresh = generateFilterClient(typedSpec, { name: 'people' });
    const licensed = `/*\n * Copyright (c) Acme.\n * SPDX-License-Identifier: MIT\n */\n\n\n${fresh}`;
    expect(readFilterClientContentHash(licensed)).toBe(readFilterClientContentHash(fresh));
    // By design: the check is about manifest drift, and the file says DO NOT EDIT.
    expect(clientMatches(`${fresh}\nexport const extra = 1\n`, fresh)).toBe(true);
  });

  it('an older client without the hash still matches after prettier (unquoted keys, leading |)', () => {
    const fresh = generateFilterClient(typedSpec, { name: 'people' });
    const banner = fresh.split('\n').slice(0, 2).join('\n');
    expect(clientMatches(`${banner}\n\n${prettierBody}`, fresh)).toBe(true);
    expect(
      clientMatches(`${banner}\n\n${prettierBody.replace('age: number', 'age: string')}`, fresh),
    ).toBe(false);
  });

  it('a client reformatted with its hash is ok in the doctor; a wrong hash is out of date', async () => {
    const files = clientFiles();
    for (const key of Object.keys(files)) {
      files[key] = (files[key] as string)
        .replace(/'/g, '"')
        .replace(/;$/gm, '')
        .replace(/\n/g, '\n\n');
    }
    expect((await run(fakeApp({ filters: manifest, files }).app))[1]).toMatchObject({
      status: 'ok',
    });

    const peopleFile = Object.keys(files).find((f) => f.includes('people')) as string;
    files[peopleFile] = (files[peopleFile] as string).replace(
      /sha256:[0-9a-f]+/,
      'sha256:0000000000000000',
    );
    const out = await run(fakeApp({ filters: manifest, files }).app);
    expect(out[1]?.message).toContain('out of date: people_filter_client.ts');
  });

  it('codeShape ignores formatting only', () => {
    expect(codeShape("const a = { b: 'c', };\n")).toBe(codeShape('const a = {b: "c"}'));
    expect(codeShape("const a = 'b'")).not.toBe(codeShape("const a = 'c'"));
    // Changes inside a string literal still count.
    expect(codeShape("const a = 'x,y'")).not.toBe(codeShape("const a = 'xy'"));
    expect(codeShape("const a = 'x y'")).not.toBe(codeShape("const a = 'xy'"));
    expect(codeShape('// a, b\nconst x = 1;')).toBe(codeShape('//  a,b\nconst x = 1'));
    // Quoted identifier keys, quote escapes and a union's leading pipe are formatting too.
    expect(codeShape('const a = { "b": 1, "c-d": 2 }')).toBe(
      codeShape("const a = { b: 1, 'c-d': 2 }"),
    );
    expect(codeShape('const a = { "b": 1 }')).not.toBe(codeShape('const a = { bb: 1 }'));
    expect(codeShape("const a = 'it\\'s'")).toBe(codeShape('const a = "it\'s"'));
    expect(codeShape("type X = 'a' | 'b'")).toBe(codeShape("type X =\n  | 'a'\n  | 'b'"));
    expect(codeShape('const x = a || b')).not.toBe(codeShape('const x = a | b'));
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
