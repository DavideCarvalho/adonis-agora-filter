import { describe, expect, it } from 'vitest';
import { applyFilterFromRequest } from '../src/apply_from_request.js';
import { BaseModelFilter } from '../src/base_model_filter.js';
import { dispatchKeys, isFilterClass, specFromFilterClass } from '../src/filter_class.js';
import { MockQueryBuilder } from './mock_query_builder.js';

/** A ctx shaped like the slice the library reads off an HttpContext. */
function ctxWith(qs: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { request: { qs: () => qs }, ...extra };
}

class UserFilter extends BaseModelFilter {
  static filterable = ['name', 'status'];
  static sortable = ['createdAt'];
  static searchable = ['name', 'email'];

  setup() {
    this.$query.whereNull('deletedAt');
  }

  fullName(value: unknown) {
    this.$query.whereILike('full_name', `%${String(value)}%`);
  }

  minAge(value: unknown) {
    this.$query.where('age', '>=', value);
  }
}

describe('filter classes — recognition and compilation', () => {
  it('recognises a class extending BaseModelFilter, and nothing else', () => {
    expect(isFilterClass(UserFilter)).toBe(true);
    expect(isFilterClass(class Other {})).toBe(false);
    expect(isFilterClass({ filterable: ['name'] })).toBe(false);
  });

  it('collects the request keys the class owns, excluding machinery', () => {
    const keys = dispatchKeys(UserFilter);
    expect([...keys].sort()).toEqual(['fullName', 'minAge']);
  });

  it('honours the blacklist', () => {
    class Blacklisted extends BaseModelFilter {
      static filterable = [];
      static blacklist = ['secret'];
      visible() {}
      secret() {}
    }
    expect([...dispatchKeys(Blacklisted)]).toEqual(['visible']);
  });

  it('compiles the statics into the same spec defineFilter would build', () => {
    const spec = specFromFilterClass(UserFilter);
    expect(spec.filterable).toEqual(['name', 'status']);
    expect(spec.sortable).toEqual(['createdAt']);
    expect(spec.searchable).toEqual(['name', 'email']);
    expect(spec.isFilterable('name')).toBe(true);
    expect(spec.isFilterable('passwordHash')).toBe(false);
  });

  it('memoises the compiled spec per class', () => {
    expect(specFromFilterClass(UserFilter)).toBe(specFromFilterClass(UserFilter));
  });
});

describe('filter classes — applying', () => {
  it('runs setup() before the request filters', async () => {
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(qb, UserFilter, ctxWith({ filter: { status: 'active' } }));

    const calls = qb.flatten();
    expect(calls[0]).toEqual({ method: 'whereNull', args: ['deletedAt'] });
    expect(calls).toContainEqual({ method: 'where', args: ['status', 'active'] });
  });

  it('dispatches a key the class owns to its method, not the column path', async () => {
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(qb, UserFilter, ctxWith({ filter: { fullName: 'silva' } }));

    const calls = qb.flatten();
    expect(calls).toContainEqual({ method: 'whereILike', args: ['full_name', '%silva%'] });
    // the declarative path never saw it — no `where fullName = …` reached the builder
    expect(calls.find((call) => call.args.includes('fullName'))).toBeUndefined();
  });

  it('a method key needs no allow-list entry — writing the method is the decision', async () => {
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(qb, UserFilter, ctxWith({ filter: { minAge: '18' } }));

    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['age', '>=', '18'] });
  });

  it('still drops a column the class never declared', async () => {
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(
      qb,
      UserFilter,
      ctxWith({ filter: { name: 'Al', passwordHash: 'x' } }),
    );

    const calls = qb.flatten();
    expect(calls).toContainEqual({ method: 'where', args: ['name', 'Al'] });
    expect(calls.find((call) => call.args.includes('passwordHash'))).toBeUndefined();
  });

  it('dispatches a bare top-level key too (?minAge=21)', async () => {
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(qb, UserFilter, ctxWith({ minAge: '21' }));

    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['age', '>=', '21'] });
  });

  it('never dispatches a reserved wire-format key to a method of the same name', async () => {
    class Sneaky extends BaseModelFilter {
      static filterable = [];
      called = false;
      sort() {
        this.called = true;
      }
    }
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(qb, Sneaky, ctxWith({ sort: '-createdAt' }));

    expect(qb.flatten().find((call) => call.method === 'orderBy')).toBeUndefined();
  });

  it('resolves the class through the container when the ctx carries one', async () => {
    class Injected extends BaseModelFilter {
      static filterable = [];
      constructor(private tenantId: number) {
        super();
      }
      setup() {
        this.$query.where('tenantId', this.tenantId);
      }
    }
    const qb = new MockQueryBuilder();
    const ctx = ctxWith({}, { containerResolver: { make: async () => new Injected(42) } });

    await applyFilterFromRequest(qb, Injected, ctx);

    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['tenantId', 42] });
  });

  it('resolves the pagination the request asked for, clamped', async () => {
    class Paged extends BaseModelFilter {
      static filterable = '*' as const;
      static defaultSize = 25;
      static maxSize = 100;
    }
    const qb = new MockQueryBuilder();

    expect(await applyFilterFromRequest(qb, Paged, ctxWith({}))).toEqual({ page: 1, size: 25 });
    expect(await applyFilterFromRequest(qb, Paged, ctxWith({ page: '3', size: '500' }))).toEqual({
      page: 3,
      size: 100,
    });
  });

  it('applies search and sort through the declarative half', async () => {
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(qb, UserFilter, ctxWith({ search: 'ana', sort: '-createdAt' }));

    const calls = qb.flatten();
    expect(calls).toContainEqual({ method: 'orWhereILike', args: ['name', '%ana%'] });
    expect(calls).toContainEqual({ method: 'orderBy', args: ['createdAt', 'desc'] });
  });

  it('a method-only class exposes nothing but its methods', async () => {
    class MethodOnly extends BaseModelFilter {
      code(value: unknown) {
        this.$query.where('code', value);
      }
    }
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(qb, MethodOnly, ctxWith({ filter: { code: 'AB', name: 'Al' } }));

    const calls = qb.flatten();
    expect(calls).toContainEqual({ method: 'where', args: ['code', 'AB'] });
    expect(calls.find((call) => call.args.includes('Al'))).toBeUndefined();
  });

  it('matches a snake_case key against a camelCase method', async () => {
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(qb, UserFilter, ctxWith({ filter: { full_name: 'silva' } }));

    expect(qb.flatten()).toContainEqual({ method: 'whereILike', args: ['full_name', '%silva%'] });
  });

  it('strips a trailing Id when the class asks for it', async () => {
    class Dropping extends BaseModelFilter {
      static dropId = true;
      company(value: unknown) {
        this.$query.where('company_id', value);
      }
    }
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(qb, Dropping, ctxWith({ filter: { companyId: '7' } }));

    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['company_id', '7'] });
  });
});
