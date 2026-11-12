import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import FilterProvider from '../providers/filter_provider.js';
import type { DevTool, DevToolCall, DevToolsHub, DevToolsLib } from '../src/dev_tools/contract.js';
import { explainFilterQuery, recordingBuilder } from '../src/dev_tools/explain.js';
import { parseQueryString } from '../src/dev_tools/query_string.js';
import { filterDevTools, registerFilterDevTools } from '../src/dev_tools/tools.js';
import { defineFilter } from '../src/filter_spec.js';
import type { FilterClientManifest } from '../src/generate_client.js';
import { loadFilterManifest } from '../src/manifest.js';

const call: DevToolCall = {
  ctx: {},
  caller: { id: 'dev-open', via: 'open' },
  limits: { maxRows: 100, maxBytes: 48_000 },
};

const people = defineFilter({
  filterable: ['name', 'age', 'status'],
  sortable: ['name', 'age'],
  searchable: ['name'],
  relations: { posts: { filterable: ['title'] } },
  fieldTypes: { age: { kind: 'number' } },
  aliases: { years: 'age' },
  defaultSort: [{ field: 'name', direction: 'asc' }],
  maxSize: 50,
  tenant: { column: 'tenantId', resolve: () => 't1' },
});
const strict = defineFilter({ filterable: ['name'], throwOnInvalid: true });
const manifest: FilterClientManifest = {
  people: { spec: people, fieldTypes: { age: { kind: 'number' } } },
  strict: { spec: strict },
};

const tools = filterDevTools({
  manifest: async () => ({ status: 'loaded', manifest, entrypoint: 'config/filter.js' }),
});
const tool = (name: string) => tools.find((t) => t.name === name) as DevTool;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('parseQueryString', () => {
  it('decodes bracket keys, arrays and encoded values like a request query string', () => {
    expect(
      parseQueryString('?filter[name][contains]=Al+B&filter[age][gte]=18&sort=-age,name&page=2'),
    ).toEqual({
      filter: { name: { contains: 'Al B' }, age: { gte: '18' } },
      sort: '-age,name',
      page: '2',
    });
    expect(
      parseQueryString('where[0][field]=a&where[0][value]=1&ids[]=1&ids[]=2&x=%C3%A9'),
    ).toEqual({
      where: [{ field: 'a', value: '1' }],
      ids: ['1', '2'],
      x: 'é',
    });
  });

  it('ignores prototype keys', () => {
    const out = parseQueryString('__proto__[polluted]=1&filter[constructor][x]=1&a=1');
    expect(out).toEqual({ a: '1' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('explainFilterQuery', () => {
  it('keeps allowed filters and records the builder calls and pagination', () => {
    const out = explainFilterQuery(
      people,
      'filter[name][contains]=Al&filter[years][gte]=18&size=10',
    );
    expect(out.rejected).toBe(false);
    expect(out.issues).toEqual([]);
    expect(out.pagination).toEqual({ page: 1, size: 10 });
    expect(out.calls.map((c) => c.method)).toContain('orderBy');
    expect(JSON.stringify(out.calls)).toContain('age');
    expect(out.serverScope).toEqual({ tenantColumn: 'tenantId', defaultFilters: [] });
  });

  it('reports dropped fields and sorts, ignored search, clamped size', () => {
    const noSearch = defineFilter({ filterable: ['name'], sortable: ['name'], maxSize: 5 });
    const out = explainFilterQuery(
      noSearch,
      'filter[secret][equals]=x&sort=-secret&search=bob&size=99',
    );
    expect(out.rejected).toBe(false);
    expect(out.issues).toEqual([
      expect.objectContaining({ part: 'filter', subject: 'secret', effect: 'dropped' }),
      expect.objectContaining({ part: 'sort', subject: 'secret', effect: 'dropped' }),
      expect.objectContaining({ part: 'search', effect: 'ignored' }),
      expect.objectContaining({ part: 'size', effect: 'clamped' }),
    ]);
    expect(out.pagination).toEqual({ page: 1, size: 5 });
  });

  it('marks a request the spec refuses (throwOnInvalid) as rejected', () => {
    const out = explainFilterQuery(strict, 'filter[secret]=x');
    expect(out.rejected).toBe(true);
    expect(out.rejection).toContain('secret');
    expect(out.issues[0]).toMatchObject({ effect: 'rejected' });
    expect(out.calls).toEqual([]);
  });

  it('the recording builder records nested callbacks and is not thenable', () => {
    const { qb, calls } = recordingBuilder();
    qb.where((q) => q.where('a', 1));
    expect(calls).toEqual([
      { method: 'where', args: [{ callback: [{ method: 'where', args: ['a', 1] }] }] },
    ]);
    expect((qb as unknown as { then?: unknown }).then).toBeUndefined();
  });
});

describe('filter dev tools', () => {
  it('are read tools that follow the hub naming rules', () => {
    expect(tools.map((t) => [t.name, t.kind])).toEqual([
      ['filter_list_specs', 'read'],
      ['filter_get_spec', 'read'],
      ['filter_explain_query', 'read'],
    ]);
    for (const t of tools) expect(t.name).toMatch(/^filter_[a-z0-9]+(_[a-z0-9]+)+$/);
  });

  it('filter_list_specs summarises each spec', async () => {
    const out = (await tool('filter_list_specs').run({}, call)) as { items: unknown[] };
    expect(out.items).toEqual([
      {
        name: 'people',
        filterable: 4,
        sortable: 3,
        searchable: ['name'],
        relations: ['posts'],
        tenantScoped: true,
      },
      {
        name: 'strict',
        filterable: 1,
        sortable: 1,
        searchable: [],
        relations: [],
        tenantScoped: false,
      },
    ]);
  });

  it('filter_list_specs explains a missing manifest instead of failing', async () => {
    const missing = filterDevTools({
      manifest: async () => ({ status: 'missing', entrypoint: 'config/filter.js' }),
    });
    const out = (await (missing[0] as DevTool).run({}, call)) as { items: unknown[]; hint: string };
    expect(out.items).toEqual([]);
    expect(out.hint).toContain('config/filter.ts');
  });

  it('filter_get_spec returns the full spec', async () => {
    const out = (await tool('filter_get_spec').run({ name: 'people' }, call)) as Record<
      string,
      unknown
    >;
    expect(out).toMatchObject({
      name: 'people',
      filterablePaths: ['name', 'age', 'status', 'posts.title'],
      sortablePaths: ['name', 'age', 'posts.title'],
      aliases: { years: 'age' },
      tenantColumn: 'tenantId',
      maxSize: 50,
    });
    expect(out.operators).toContain('contains');
    await expect(tool('filter_get_spec').run({ name: 'nope' }, call)).rejects.toThrow(
      'No spec "nope". Known: people, strict',
    );
    await expect(tool('filter_get_spec').run({}, call)).rejects.toThrow(/name/);
  });

  it('filter_explain_query dry-runs a query string', async () => {
    const out = (await tool('filter_explain_query').run(
      { name: 'people', query: 'filter[nope]=1' },
      call,
    )) as { spec: string; issues: unknown[] };
    expect(out.spec).toBe('people');
    expect(out.issues).toHaveLength(1);
  });
});

describe('loadFilterManifest', () => {
  function appWith(files: Record<string, string>, config?: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), 'filter-manifest-'));
    roots.push(root);
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    const filterUrl = pathToFileURL(join(process.cwd(), 'src/filter_spec.ts')).href;
    return {
      app: {
        makeURL: (...parts: string[]) => pathToFileURL(join(root, ...parts)),
        config: {
          get: (key: string, fallback?: unknown) => (key === 'filter' ? config : fallback),
        },
      },
      filterUrl,
    };
  }

  it('reads a named `filters` export, a default export, or config filter.filters', async () => {
    const spec = { isFilterable: () => true };
    const named = appWith({
      'config/filter.js':
        'export const filters = { a: { spec: { isFilterable() { return true } } } }',
    });
    const loaded = await loadFilterManifest(named.app);
    expect(loaded.status).toBe('loaded');

    const viaConfig = appWith({}, { filters: { b: { spec } } });
    const fromConfig = await loadFilterManifest(viaConfig.app);
    expect(fromConfig).toMatchObject({ status: 'loaded' });
    expect(Object.keys((fromConfig as { manifest: object }).manifest)).toEqual(['b']);
  });

  it('reports missing, empty and broken manifests', async () => {
    expect((await loadFilterManifest(appWith({}).app)).status).toBe('missing');
    expect(
      (await loadFilterManifest(appWith({ 'config/filter.js': 'export const other = 1' }).app))
        .status,
    ).toBe('empty');
    const broken = await loadFilterManifest(
      appWith({ 'config/filter.js': "throw new Error('boom')" }).app,
    );
    expect(broken).toMatchObject({ status: 'failed', error: 'boom' });
  });
});

describe('registerFilterDevTools and the provider', () => {
  const container = (hub: unknown) => ({
    hasBinding: (key: string) => key === 'agora.devTools' && hub !== undefined,
    make: async () => hub,
  });
  const deps = { manifest: async () => ({ status: 'missing' as const, entrypoint: 'x' }) };

  it('registers without authorize on a supporting hub; skips otherwise', async () => {
    const registered: DevToolsLib[] = [];
    const hub: DevToolsHub = {
      version: 1,
      register: (l) => registered.push(l),
      supports: () => true,
    };
    expect(await registerFilterDevTools(container(hub), deps)).toBe('registered');
    expect(registered[0]).toMatchObject({ lib: 'filter' });
    expect(registered[0]?.authorize).toBeUndefined();
    expect(await registerFilterDevTools(container(undefined), deps)).toBe('no-hub');
    expect(await registerFilterDevTools(container({ version: 1, register() {} }), deps)).toBe(
      'unsupported',
    );
  });

  it('the provider registers from boot(), unless filter.devTools is false', async () => {
    const run = async (config: unknown) => {
      const registered: DevToolsLib[] = [];
      const hub: DevToolsHub = {
        version: 1,
        register: (l) => registered.push(l),
        supports: () => true,
      };
      const app = {
        config: { get: (key: string, fallback: unknown) => (key === 'filter' ? config : fallback) },
        container: {
          hasBinding: (key: string) => key === 'agora.devTools',
          make: async () => hub,
        },
        makeURL: (...p: string[]) => pathToFileURL(join('/nonexistent', ...p)),
      };
      await new FilterProvider(app as never).boot();
      return registered;
    };
    expect((await run(undefined)).map((l) => l.lib)).toEqual(['filter']);
    expect(await run({ devTools: false })).toEqual([]);
  });
});

describe('explainFilterQuery: structural errors', () => {
  it('an unknown operator rejects the request even without throwOnInvalid', () => {
    const out = explainFilterQuery(people, 'filter[name][eq]=x');
    expect(out.rejected).toBe(true);
    expect(out.rejection).toContain('Unknown filter operator "eq"');
  });
});
