import { describe, expect, it } from 'vitest';
import { applyCursorFromRequest, applyFilterFromRequest } from '../src/apply_from_request.js';
import { defineFilter, FilterDefinitionError, specToFilterConfig } from '../src/filter_spec.js';
import { InvalidColumnFilterError } from '../src/validate-column-filter.js';
import { MockQueryBuilder } from './mock_query_builder.js';

/** Build a fake HttpContext exposing `request.qs()` plus any extra props (e.g. auth). */
function ctxOf(qs: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { request: { qs: () => qs }, ...extra };
}

describe('defineFilter — declaration', () => {
  it('requires a filterable allow-list', () => {
    expect(() => defineFilter({} as any)).toThrow(FilterDefinitionError);
  });

  it('rejects a negative or non-integer maxDepth', () => {
    expect(() => defineFilter({ filterable: ['a'], maxDepth: -1 })).toThrow(FilterDefinitionError);
    expect(() => defineFilter({ filterable: ['a'], maxDepth: 1.5 })).toThrow(FilterDefinitionError);
  });

  it('defaults sortable to filterable and maxDepth to the declared relation depth', () => {
    const spec = defineFilter({
      filterable: ['name'],
      relations: { posts: { relations: { comments: {} } } },
    });
    expect(spec.sortable).toEqual(['name']);
    expect(spec.maxDepth).toBe(2);
    expect(Object.isFrozen(spec)).toBe(true);
  });
});

describe('defineFilter — allow-list predicates', () => {
  const spec = defineFilter({ filterable: ['name', 'age'], sortable: ['name'] });

  it('admits declared base columns, rejects others', () => {
    expect(spec.isFilterable('name')).toBe(true);
    expect(spec.isFilterable('age')).toBe(true);
    expect(spec.isFilterable('secret')).toBe(false);
  });

  it('honors a separate sortable list', () => {
    expect(spec.isSortable('name')).toBe(true);
    expect(spec.isSortable('age')).toBe(false);
  });

  it("treats '*' as any base column but never a prototype key", () => {
    const star = defineFilter({ filterable: '*' });
    expect(star.isFilterable('anything')).toBe(true);
    expect(star.isFilterable('__proto__')).toBe(false);
    expect(star.isFilterable('constructor')).toBe(false);
  });
});

describe('defineFilter — relation whitelist + maxDepth', () => {
  const spec = defineFilter({
    filterable: ['name'],
    relations: {
      posts: {
        filterable: ['title', 'status'],
        relations: { comments: { filterable: ['body'] } },
      },
    },
  });

  it('admits whitelisted relation columns', () => {
    expect(spec.isFilterable('posts.title')).toBe(true);
    expect(spec.isFilterable('posts.status')).toBe(true);
    expect(spec.isFilterable('posts.comments.body')).toBe(true);
  });

  it('rejects non-whitelisted relations and columns', () => {
    expect(spec.isFilterable('secrets.title')).toBe(false);
    expect(spec.isFilterable('posts.author')).toBe(false);
    expect(spec.isFilterable('posts.comments.email')).toBe(false);
  });

  it('enforces an explicit maxDepth cap below the declared depth', () => {
    const capped = defineFilter({
      filterable: ['name'],
      maxDepth: 1,
      relations: {
        posts: { filterable: ['title'], relations: { comments: { filterable: ['body'] } } },
      },
    });
    expect(capped.isFilterable('posts.title')).toBe(true);
    expect(capped.isFilterable('posts.comments.body')).toBe(false); // depth 2 > maxDepth 1
  });

  it('drops a disallowed relation-path filter through the request helper', () => {
    const qb = new MockQueryBuilder();
    applyFilterFromRequest(qb, spec, ctxOf({ filter: { 'posts.title': 'hi', 'secrets.k': 'x' } }));
    const flat = qb.flatten();
    // The whitelisted relation path is translated to a whereHas subquery.
    expect(qb.find('whereHas')?.args).toEqual(['posts']);
    expect(flat).toContainEqual({ method: 'where', args: ['title', 'hi'] });
    expect(
      flat.find((c) => c.args.includes('secrets.k') || c.args.includes('secrets')),
    ).toBeUndefined();
  });
});

describe('applyFilterFromRequest — allow-listing + throwOnInvalid', () => {
  it('applies allowed base filters and drops disallowed ones', () => {
    const spec = defineFilter({ filterable: ['name'] });
    const qb = new MockQueryBuilder();
    const pag = applyFilterFromRequest(qb, spec, ctxOf({ filter: { name: 'Al', secret: 'x' } }));
    const flat = qb.flatten();
    expect(flat).toContainEqual({ method: 'where', args: ['name', 'Al'] });
    expect(flat.find((c) => c.args.includes('secret'))).toBeUndefined();
    expect(pag).toEqual({ page: 1, size: 25 });
  });

  it('throws InvalidColumnFilterError on a disallowed field when throwOnInvalid', () => {
    const spec = defineFilter({ filterable: ['name'], throwOnInvalid: true });
    const qb = new MockQueryBuilder();
    expect(() => applyFilterFromRequest(qb, spec, ctxOf({ filter: { secret: 'x' } }))).toThrow(
      InvalidColumnFilterError,
    );
  });
});

describe('applyFilterFromRequest — aliases', () => {
  it('resolves an alias before allow-listing and applies the target column', () => {
    const spec = defineFilter({ filterable: ['status'], aliases: { legacyStatus: 'status' } });
    const qb = new MockQueryBuilder();
    applyFilterFromRequest(qb, spec, ctxOf({ filter: { legacyStatus: 'active' } }));
    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['status', 'active'] });
  });

  it('resolves an alias that points at a whitelisted relation path', () => {
    const spec = defineFilter({
      filterable: ['name'],
      relations: { posts: { filterable: ['title'] } },
      aliases: { postTitle: 'posts.title' },
    });
    const qb = new MockQueryBuilder();
    applyFilterFromRequest(qb, spec, ctxOf({ filter: { postTitle: 'hi' } }));
    // The alias resolves to `posts.title`, which is translated to a whereHas subquery.
    expect(qb.find('whereHas')?.args).toEqual(['posts']);
    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['title', 'hi'] });
  });
});

describe('applyFilterFromRequest — tenant scope', () => {
  const spec = defineFilter({
    filterable: ['name'],
    tenant: { column: 'tenantId', resolve: (ctx) => (ctx as { tenantId?: number }).tenantId },
  });

  it('injects the tenant constraint from ctx, un-tamperable by the client', () => {
    const qb = new MockQueryBuilder();
    // The client tries to override tenantId via a filter — it must be dropped
    // (not in the allow-list) while the server scope still applies.
    applyFilterFromRequest(
      qb,
      spec,
      ctxOf({ filter: { name: 'Al', tenantId: 999 } }, { tenantId: 42 }),
    );
    const flat = qb.flatten();
    expect(flat).toContainEqual({ method: 'where', args: ['tenantId', 42] });
    expect(flat.find((c) => c.args.includes(999))).toBeUndefined();
  });

  it('is a no-op when no tenant resolves from ctx (opt-in)', () => {
    const qb = new MockQueryBuilder();
    applyFilterFromRequest(qb, spec, ctxOf({ filter: { name: 'Al' } }));
    expect(qb.flatten().find((c) => c.args.includes('tenantId'))).toBeUndefined();
  });
});

describe('applyFilterFromRequest — defaults', () => {
  it('applies server default filters bypassing the allow-list', () => {
    const spec = defineFilter({
      filterable: ['name'],
      defaultFilters: [{ field: 'deletedAt', operator: 'isNull' }],
    });
    const qb = new MockQueryBuilder();
    applyFilterFromRequest(qb, spec, ctxOf({}));
    expect(qb.flatten()).toContainEqual({ method: 'whereNull', args: ['deletedAt'] });
  });

  it('applies defaultSort when the request supplies none, but not when it does', () => {
    const spec = defineFilter({
      filterable: ['name'],
      sortable: ['name'],
      defaultSort: [{ field: 'createdAt', direction: 'desc' }],
    });

    const qb1 = new MockQueryBuilder();
    applyFilterFromRequest(qb1, spec, ctxOf({}));
    expect(qb1.flatten().filter((c) => c.method === 'orderBy')).toEqual([
      { method: 'orderBy', args: ['createdAt', 'desc'] },
    ]);

    const qb2 = new MockQueryBuilder();
    applyFilterFromRequest(qb2, spec, ctxOf({ sort: 'name' }));
    expect(qb2.flatten().filter((c) => c.method === 'orderBy')).toEqual([
      { method: 'orderBy', args: ['name', 'asc'] },
    ]);
  });
});

describe('applyCursorFromRequest', () => {
  it('applies filters/tenant scope and builds a keyset-limited query', () => {
    const spec = defineFilter({
      filterable: ['name'],
      sortable: ['name'],
      defaultSort: [{ field: 'name', direction: 'asc' }],
      tenant: { column: 'tenantId', resolve: () => 7 },
    });
    const qb = new MockQueryBuilder();
    const resolved = applyCursorFromRequest(
      qb,
      spec,
      ctxOf({ filter: { name: 'Al' }, first: '10' }),
      {
        primaryKey: 'id',
      },
    );
    const flat = qb.flatten();
    expect(flat).toContainEqual({ method: 'where', args: ['name', 'Al'] });
    expect(flat).toContainEqual({ method: 'where', args: ['tenantId', 7] });
    expect(flat).toContainEqual({ method: 'limit', args: [11] }); // size + 1
    expect(resolved.size).toBe(10);
    expect(resolved.keyset.map((k) => k.field)).toEqual(['name', 'id']);
  });
});

describe('specToFilterConfig', () => {
  it('unions defaultSort fields into the sortable predicate', () => {
    const spec = defineFilter({
      filterable: ['name'],
      sortable: ['name'],
      defaultSort: [{ field: 'createdAt', direction: 'desc' }],
    });
    const config = specToFilterConfig(spec);
    const sortable = config.sortable as (f: string) => boolean;
    expect(sortable('name')).toBe(true);
    expect(sortable('createdAt')).toBe(true); // server default, not otherwise sortable
    expect(sortable('secret')).toBe(false);
  });
});
