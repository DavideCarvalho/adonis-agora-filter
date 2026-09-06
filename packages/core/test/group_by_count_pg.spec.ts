import { BaseModel, column } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaseModelFilter } from '../src/base_model_filter.js';
import { defineFilter } from '../src/filter_spec.js';
import { groupByCountFromRequest } from '../src/group_by_count.js';
import { InvalidColumnFilterError } from '../src/validate-column-filter.js';
import { createPgHarness, type PgHarness, probePgReachable } from './support/pg.js';

// Resolved at collection time so the pg-backed blocks skip (not fail) when no
// Postgres is reachable.
const pgUp = await probePgReachable();

let harness: PgHarness;

// Columns are applied programmatically (rather than with `@column` decorator
// syntax) so the test suite does not depend on SWC legacy-decorator transform
// config — see distinct_pg.spec.ts.
class Stock extends BaseModel {
  static table = 'gbc_stock';
  declare id: number;
  declare tenant: string;
  declare tier: string;
}
column({ isPrimary: true })(Stock.prototype, 'id');
column()(Stock.prototype, 'tenant');
column()(Stock.prototype, 'tier');

class StockFilter extends BaseModelFilter {
  static filterable = ['tenant', 'tier'];
}

beforeAll(async () => {
  if (!pgUp) return;
  harness = createPgHarness();
  await harness.raw('drop table if exists gbc_stock');
  await harness.raw(
    'create table gbc_stock (id serial primary key, tenant text not null, tier text)',
  );
  // 5 rows: pro x3 (acme x2, globex x1), free x1, NULL x1.
  await harness.raw(
    "insert into gbc_stock (tenant, tier) values ('acme','pro'),('acme','pro'),('globex','pro'),('acme','free'),('acme',NULL)",
  );
});

afterAll(async () => {
  if (harness) await harness.close();
});

const ctxWith = (qs: Record<string, unknown>) => ({ request: { qs: () => qs } });

describe.skipIf(!pgUp)('groupByCount against real Postgres', () => {
  it('counts the whole axis, most groups first', async () => {
    const rows = await groupByCountFromRequest(Stock.query(), StockFilter, ctxWith({}), {
      field: 'tier',
    });
    expect(rows).toEqual([
      { value: 'pro', count: 3 },
      { value: 'free', count: 1 },
      { value: null, count: 1 },
    ]);
  });

  it('scopes by the request filters', async () => {
    const rows = await groupByCountFromRequest(
      Stock.query(),
      StockFilter,
      ctxWith({ filter: { tenant: 'globex' } }),
      { field: 'tier' },
    );
    expect(rows).toEqual([{ value: 'pro', count: 1 }]);
  });

  it('narrows values by search and pages the fixed ordering', async () => {
    const searched = await groupByCountFromRequest(Stock.query(), StockFilter, ctxWith({}), {
      field: 'tier',
      search: 'R',
    });
    expect(searched).toEqual([
      { value: 'pro', count: 3 },
      { value: 'free', count: 1 },
    ]);
    const paged = await groupByCountFromRequest(Stock.query(), StockFilter, ctxWith({}), {
      field: 'tier',
      limit: 1,
      offset: 1,
    });
    expect(paged).toEqual([{ value: 'free', count: 1 }]);
  });

  it('reads field and bounds off the envelope', async () => {
    const rows = await groupByCountFromRequest(
      Stock.query(),
      StockFilter,
      ctxWith({ groupByCount: { field: 'tier', limit: '2' } }),
    );
    expect(rows).toEqual([
      { value: 'pro', count: 3 },
      { value: 'free', count: 1 },
    ]);
  });

  it('rejects an unknown or missing field instead of grouping by client text', async () => {
    await expect(
      groupByCountFromRequest(Stock.query(), StockFilter, ctxWith({}), { field: 'nope' }),
    ).rejects.toThrow(InvalidColumnFilterError);
    await expect(groupByCountFromRequest(Stock.query(), StockFilter, ctxWith({}))).rejects.toThrow(
      InvalidColumnFilterError,
    );
  });

  it('applies the server scope (default filters) before counting', async () => {
    const spec = defineFilter({
      filterable: ['tenant', 'tier'],
      defaultFilters: [{ field: 'tenant', operator: 'equals', value: 'acme' }],
    });
    const rows = await groupByCountFromRequest(Stock.query(), spec, ctxWith({}), {
      field: 'tier',
    });
    expect(rows).toEqual([
      { value: 'pro', count: 2 },
      { value: 'free', count: 1 },
      { value: null, count: 1 },
    ]);
  });
});
