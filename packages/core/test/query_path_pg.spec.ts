import { BaseModel, column, ModelQueryBuilder } from '@adonisjs/lucid/orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineFilter } from '../src/filter_spec.js';
import { applyColumnFilters, applyKeyset } from '../src/lucid_adapter.js';
import { registerFilterMacros } from '../src/lucid_macros.js';
import { createPgHarness, type PgHarness, probePgReachable } from './support/pg.js';

const pgUp = await probePgReachable();

/**
 * The SQL the adapter and the `filterPaginate` macro emit, executed by real Lucid against real
 * Postgres: `notContains`, the keyset seek, and how many statements a page costs.
 */

let harness: PgHarness;

class Heron extends BaseModel {
  static table = 'qp_herons';
  declare id: number;
  declare name: string | null;
  declare rank: number | null;
}
column({ isPrimary: true })(Heron.prototype, 'id');
column()(Heron.prototype, 'name');
column()(Heron.prototype, 'rank');

/** Rows ids 1..23; rank = id % 5 (so it repeats), NULL for every 7th id; name NULL for id 4. */
const ROWS = Array.from({ length: 23 }, (_, i) => {
  const id = i + 1;
  return { id, rank: id % 7 === 0 ? null : id % 5, name: id === 4 ? null : `Heron ${id}` };
});

beforeAll(async () => {
  if (!pgUp) return;
  harness = createPgHarness();
  registerFilterMacros(ModelQueryBuilder as never);
  await harness.raw('drop table if exists qp_herons');
  await harness.raw('create table qp_herons (id int primary key, name text, rank int)');
  await harness.raw('create index qp_herons_rank_id on qp_herons (rank, id)');
  for (const row of ROWS) {
    await harness.raw('insert into qp_herons (id, name, rank) values (?, ?, ?)', [
      row.id,
      row.name,
      row.rank,
    ]);
  }
});

afterAll(async () => {
  if (harness) {
    await harness.raw('drop table if exists qp_herons').catch(() => {});
    await harness.close();
  }
});

describe.skipIf(!pgUp)('notContains against real Postgres', () => {
  it('keeps the non-NULL rows that do not contain the value, case-insensitively', async () => {
    await harness.raw("update qp_herons set name = 'Great Blue' where id = 1");
    await harness.raw("update qp_herons set name = 'great white' where id = 2");
    try {
      const query = Heron.query().orderBy('id', 'asc');
      applyColumnFilters(query as never, [
        { field: 'name', operator: 'notContains', value: 'GREAT' },
      ]);
      const ids = (await query).map((r) => r.id);
      expect(ids).toEqual(ROWS.filter((r) => r.id > 2 && r.name !== null).map((r) => r.id));
    } finally {
      await harness.raw("update qp_herons set name = 'Heron 1' where id = 1");
      await harness.raw("update qp_herons set name = 'Heron 2' where id = 2");
    }
  });

  it('treats LIKE wildcards in the value as literals', async () => {
    const query = Heron.query();
    applyColumnFilters(query as never, [{ field: 'name', operator: 'notContains', value: '%' }]);
    expect(await query).toHaveLength(ROWS.filter((r) => r.name !== null).length);
  });
});

describe.skipIf(!pgUp)('keyset seek against real Postgres', () => {
  const order = (dir: 'asc' | 'desc') => {
    const nonNull = ROWS.filter((r) => r.rank !== null);
    return nonNull.sort((a, b) =>
      a.rank === b.rank ? a.id - b.id : dir === 'asc' ? a.rank! - b.rank! : b.rank! - a.rank!,
    );
  };

  for (const dir of ['asc', 'desc'] as const) {
    it(`returns exactly the rows after the boundary (${dir} lead, asc id)`, async () => {
      const expected = order(dir);
      for (let i = 0; i < expected.length; i++) {
        const boundary = expected[i]!;
        const query = Heron.query().whereNotNull('rank').orderBy('rank', dir).orderBy('id', 'asc');
        applyKeyset(
          query as never,
          [
            { field: 'rank', direction: dir },
            { field: 'id', direction: 'asc' },
          ],
          [boundary.rank, boundary.id],
        );
        expect((await query).map((r) => r.id)).toEqual(expected.slice(i + 1).map((r) => r.id));
      }
    });
  }

  it('a NULL leading boundary keeps matching what the tier predicate matches', async () => {
    const query = Heron.query().orderBy('id', 'asc');
    applyKeyset(
      query as never,
      [
        { field: 'rank', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
      [null, 7],
    );
    // `rank > NULL` is never true, `rank IS NULL AND id > 7` keeps the later NULL-rank rows.
    expect((await query).map((r) => r.id)).toEqual([14, 21]);
  });

  it('gives the planner an index bound on the leading column', async () => {
    const query = Heron.query().orderBy('rank', 'asc').orderBy('id', 'asc').limit(5);
    applyKeyset(
      query as never,
      [
        { field: 'rank', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
      [3, 8],
    );
    const { sql, bindings } = query.toSQL();
    const plan = (await harness.db.transaction(async (trx) => {
      await trx.rawQuery('set local enable_seqscan = off');
      return trx.rawQuery(`explain ${sql}`, bindings as never);
    })) as { rows: Array<{ 'QUERY PLAN': string }> };
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index Cond: \(rank >= 3\)/);
  });
});

describe.skipIf(!pgUp)('filterPaginate against real Postgres', () => {
  const spec = defineFilter({ filterable: ['rank'], sortable: ['id'], defaultSize: 10 });
  const ctxFor = (qs: Record<string, unknown>) => ({ request: { qs: () => qs } });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The page through the macro, the same page through Lucid's own `paginate`, and the statements the macro ran. */
  async function both(qs: Record<string, unknown>) {
    const spy = vi.spyOn(ModelQueryBuilder.prototype, 'execQuery');
    const ours = await (Heron.query() as any).filterPaginate(spec, ctxFor({ sort: 'id', ...qs }));
    const statements = spy.mock.calls.length;
    spy.mockRestore();
    const page = Number(qs.page ?? 1);
    const size = Number(qs.size ?? 10);
    const query = Heron.query().orderBy('id', 'asc');
    if (qs.filter) query.where('rank', (qs.filter as { rank: unknown }).rank as number);
    const lucid = await query.paginate(page, size);
    return { ours, lucid, statements };
  }

  const shape = (p: any) => ({ meta: p.getMeta(), ids: p.all().map((r: Heron) => r.id) });

  it('a short page carries its own total — one statement, same paginator', async () => {
    const { ours, lucid, statements } = await both({ page: 3 });
    expect(shape(ours)).toEqual(shape(lucid));
    expect(ours.total).toBe(23);
    expect(ours.constructor).toBe(lucid.constructor);
    expect(statements).toBe(1);
  });

  it('a short first page (a narrow filter) needs no count either', async () => {
    const { ours, lucid, statements } = await both({ filter: { rank: 1 } });
    expect(shape(ours)).toEqual(shape(lucid));
    expect(statements).toBe(1);
  });

  it('an empty first page is a total of 0 — one statement', async () => {
    const { ours, lucid, statements } = await both({ filter: { rank: 99 } });
    expect(shape(ours)).toEqual(shape(lucid));
    expect(ours.total).toBe(0);
    expect(statements).toBe(1);
  });

  it('a full page still counts', async () => {
    const { ours, lucid, statements } = await both({ page: 2 });
    expect(shape(ours)).toEqual(shape(lucid));
    expect(statements).toBe(2);
  });

  it('a page past the end still counts', async () => {
    const { ours, lucid, statements } = await both({ page: 9 });
    expect(shape(ours)).toEqual(shape(lucid));
    expect(ours.total).toBe(23);
    expect(statements).toBe(2);
  });

  it('a last page that is exactly full counts, and the meta matches', async () => {
    await harness.raw('delete from qp_herons where id > 20');
    try {
      const { ours, lucid, statements } = await both({ page: 2 });
      expect(shape(ours)).toEqual(shape(lucid));
      expect(ours.lastPage).toBe(2);
      expect(statements).toBe(2);
    } finally {
      for (const row of ROWS.filter((r) => r.id > 20)) {
        await harness.raw('insert into qp_herons (id, name, rank) values (?, ?, ?)', [
          row.id,
          row.name,
          row.rank,
        ]);
      }
    }
  });

  it('a select list that dedupes rows is paged by Lucid itself, total and all', async () => {
    const lucid = await Heron.query().distinct('rank').orderBy('rank', 'asc').paginate(1, 10);
    const spy = vi.spyOn(ModelQueryBuilder.prototype, 'paginate');
    const query = Heron.query().distinct('rank').orderBy('rank', 'asc');
    const ours = await (query as any).filterPaginate(spec, ctxFor({}));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ours.getMeta()).toEqual(lucid.getMeta());
    // Lucid's count ignores the DISTINCT: 23 rows counted, 6 on the page.
    expect(ours.total).toBe(23);
    expect(ours.all()).toHaveLength(6);
  });

  it('a raw select is paged by Lucid itself', async () => {
    const spy = vi.spyOn(ModelQueryBuilder.prototype, 'paginate');
    const query = Heron.query().select(harness.db.raw('count(*) as n'));
    const ours = await (query as any).filterPaginate(spec, ctxFor({}));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ours.total).toBe(23);
  });

  it('a scalar subquery in the select list keeps the short-page total', async () => {
    const spy = vi.spyOn(ModelQueryBuilder.prototype, 'execQuery');
    const sub = harness.db.from('qp_herons as h2').count('*').whereRaw('h2.rank = qp_herons.rank');
    const ours = await (Heron.query().select('*').select(sub.as('peers')) as any).filterPaginate(
      spec,
      ctxFor({ sort: 'id', page: 3 }),
    );
    expect(spy.mock.calls.length).toBe(1);
    expect(ours.total).toBe(23);
    expect(ours.all().map((r: Heron) => r.id)).toEqual([21, 22, 23]);
  });

  it('a model with a before:fetch hook is paged by Lucid itself', async () => {
    class HookedHeron extends Heron {
      static table = 'qp_herons';
    }
    HookedHeron.boot();
    HookedHeron.before('fetch', (q) => {
      q.where('id', '<=', 15);
    });
    const spy = vi.spyOn(ModelQueryBuilder.prototype, 'paginate');
    const ours = await (HookedHeron.query() as any).filterPaginate(
      spec,
      ctxFor({ sort: 'id', page: 2 }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    // Lucid's count does not see the before:fetch scope; the page does.
    expect(ours.total).toBe(23);
    expect(ours.all()).toHaveLength(5);
  });
});
