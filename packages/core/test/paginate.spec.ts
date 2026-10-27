import { ModelPaginator, SnakeCaseNamingStrategy } from '@adonisjs/lucid/orm';
import { describe, expect, it } from 'vitest';
import { paginate } from '../src/paginate.js';

/**
 * A stand-in for Lucid's `ModelQueryBuilder` over `total` rows that records every statement it
 * would send: `count` for the total, `page` for a `forPage` read, `lucid` when the call is handed
 * to Lucid's own `paginate`. The real-database version lives in `query_path_pg.spec.ts`.
 */
class FakeModelQuery {
  statements: string[] = [];
  hasGroupBy = false;
  wrapResultsToModelInstances = true;
  knexQuery: { _method: string; _statements: unknown[] } = {
    _method: 'select',
    _statements: [{ grouping: 'columns', value: ['*'] }],
  };
  model = {
    namingStrategy: new SnakeCaseNamingStrategy(),
    hooks: new Set<string>(),
    $hooks: {
      has: (event: string) => this.model.hooks.has(event),
      runner: () => ({ run: async () => {} }),
    },
  };
  private window: [number, number] = [1, 20];

  constructor(private readonly total: number) {}

  paginate(page: number, perPage: number) {
    this.statements.push('lucid');
    return { page, perPage };
  }
  clone() {
    const count = new FakeModelQuery(this.total);
    count.statements = this.statements;
    count.exec = async () => {
      this.statements.push('count');
      return [{ total: String(this.total) }];
    };
    return count;
  }
  clearOrder() {
    return this;
  }
  clearLimit() {
    return this;
  }
  clearOffset() {
    return this;
  }
  clearSelect() {
    return this;
  }
  count() {
    return this;
  }
  pojo() {
    return this;
  }
  forPage(page: number, perPage: number) {
    this.window = [page, perPage];
    return this;
  }
  async exec(): Promise<Array<{ total: unknown }>> {
    throw new Error('not a count query');
  }
  async execQuery() {
    this.statements.push('page');
    const [page, perPage] = this.window;
    const from = (page - 1) * perPage;
    const n = Math.max(0, Math.min(perPage, this.total - from));
    return Array.from({ length: n }, (_, i) => ({ id: from + i + 1 }));
  }
}

/** Lucid's own paginator for the same numbers, to compare meta against. */
function expected(total: number, perPage: number, page: number) {
  const paginator = new ModelPaginator(total, perPage, page);
  paginator.namingStrategy = new SnakeCaseNamingStrategy();
  return paginator.getMeta();
}

async function run(total: number, page: number, perPage: number) {
  const query = new FakeModelQuery(total);
  const paginator = (await paginate(query, page, perPage)) as ModelPaginator;
  return { query, paginator };
}

describe('paginate', () => {
  it('a short page is its own total — no count', async () => {
    const { query, paginator } = await run(23, 3, 10);
    expect(query.statements).toEqual(['page']);
    expect(paginator).toBeInstanceOf(ModelPaginator);
    expect(paginator.getMeta()).toEqual(expected(23, 10, 3));
    expect(paginator.all()).toHaveLength(3);
  });

  it('an empty first page is a total of 0 — no count', async () => {
    const { query, paginator } = await run(0, 1, 10);
    expect(query.statements).toEqual(['page']);
    expect(paginator.total).toBe(0);
  });

  it('a full page, or an empty page past the first, counts', async () => {
    const full = await run(23, 2, 10);
    expect(full.query.statements).toEqual(['page', 'count']);
    expect(full.paginator.total).toBe(23);

    const past = await run(23, 9, 10);
    expect(past.query.statements).toEqual(['page', 'count']);
    expect(past.paginator.getMeta()).toEqual(expected(23, 10, 9));
  });

  it('leaves hooked models, row-count-changing selects and odd page numbers to Lucid', async () => {
    for (const hook of ['before:paginate', 'before:fetch']) {
      const query = new FakeModelQuery(23);
      query.model.hooks.add(hook);
      await paginate(query, 3, 10);
      expect(query.statements).toEqual(['lucid']);
    }
    for (const statement of [
      { grouping: 'columns', value: ['rank'], distinct: true },
      { grouping: 'columns', value: ['rank'], distinctOn: true },
      { grouping: 'columns', type: 'aggregate', value: '*' },
      { grouping: 'columns', value: [{ isRawInstance: true }] },
      { grouping: 'union', value: {} },
    ]) {
      const query = new FakeModelQuery(23);
      query.knexQuery._statements.push(statement);
      await paginate(query, 3, 10);
      expect(query.statements).toEqual(['lucid']);
    }
    const zero = new FakeModelQuery(23);
    await paginate(zero, 0, 10);
    expect(zero.statements).toEqual(['lucid']);
  });

  it('pages a builder without the Lucid internals through its own paginate', () => {
    const plain = { paginate: (page: number, perPage: number) => ({ page, perPage }) };
    expect(paginate(plain, 2, 10)).toEqual({ page: 2, perPage: 10 });
  });
});
