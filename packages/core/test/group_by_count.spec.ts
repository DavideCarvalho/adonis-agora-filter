import { describe, expect, it } from 'vitest';
import { BaseFilter } from '../src/base_filter.js';
import { applyCustomFilter } from '../src/custom_filter.js';
import { defineFilter } from '../src/filter_spec.js';
import { type GroupByCountAdapter, groupByCountFromRequest } from '../src/group_by_count.js';
import type { QueryBuilderLike } from '../src/lucid_adapter.js';
import { applyGroupByCount } from '../src/lucid_adapter.js';
import { parseFilterRequest, parseGroupByCount } from '../src/parse_request.js';
import { InvalidColumnFilterError } from '../src/validate-column-filter.js';
import { MockQueryBuilder } from './mock_query_builder.js';

/** A draft built by a custom filter class — the custom-backend counterpart of a builder. */
interface Bag {
  tags?: string[] | undefined;
  log: string[];
}

class BagFilter extends BaseFilter<Bag> {
  declare $query: Bag;

  tag(value: unknown) {
    this.$query.log.push('tag');
    this.$query.tags = (Array.isArray(value) ? value : [value]).map(String);
  }
}

/** A mock that also executes: `await` resolves canned rows instead of running SQL. */
class ExecMock extends MockQueryBuilder {
  rows: Array<{ value: unknown; count: number | string }> = [];
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable standing in for Lucid.
  then(resolve: (value: Array<{ value: unknown; count: number | string }>) => void): void {
    resolve(this.rows);
  }
}

const ctxWith = (qs: Record<string, unknown>) => ({ request: { qs: () => qs } });

describe('groupByCount — one enumeration style over Lucid and custom backends', () => {
  it('parses the groupByCount block off the envelope', () => {
    expect(
      parseFilterRequest({
        groupByCount: { field: 'tag', limit: '20', offset: '5', search: 'et' },
      }),
    ).toMatchObject({ groupByCount: { field: 'tag', limit: 20, offset: 5, search: 'et' } });
    expect(parseGroupByCount(undefined)).toBeUndefined();
    expect(parseGroupByCount({ limit: '20' })).toBeUndefined();
  });

  it('emits SELECT value/COUNT with the fixed pageable ordering on a Lucid builder', () => {
    const qb = new MockQueryBuilder();
    applyGroupByCount(qb, 'city', { limit: 20, offset: 5, search: 'NeW' });
    expect(qb.find('select')?.args).toEqual(['city AS value']);
    expect(qb.find('count')?.args).toEqual(['* AS count']);
    expect(qb.find('groupBy')?.args).toEqual(['city']);
    expect(qb.flatten().filter((c) => c.method === 'orderBy')).toEqual([
      { method: 'orderBy', args: ['count', 'desc'] },
      { method: 'orderBy', args: ['city', 'asc'] },
    ]);
    expect(qb.find('limit')?.args).toEqual([20]);
    expect(qb.find('offset')?.args).toEqual([5]);
    // Value search is a bound LIKE, escaped — never interpolated.
    expect(qb.find('whereRaw')?.args).toEqual(['LOWER(??) LIKE ?', ['city', '%new%']]);
  });

  it('refuses to aggregate on a builder without the seam, loudly', () => {
    expect(() => applyGroupByCount({} as unknown as QueryBuilderLike, 'city', {})).toThrow(
      /select\/count\/groupBy\/offset/,
    );
  });

  it('Lucid mode: scopes by the request filters, ignores the listing sort, maps the rows', async () => {
    const spec = defineFilter({ filterable: ['city', 'species'] });
    const qb = new ExecMock();
    qb.rows = [
      { value: 'NYC', count: '3' },
      { value: 'LA', count: 2 },
    ];
    const rows = await groupByCountFromRequest(
      qb,
      spec,
      ctxWith({ filter: { species: 'robin' } }),
      {
        field: 'city',
      },
    );
    // Scope applied…
    expect(qb.find('where')?.args).toEqual(['species', 'robin']);
    // …listing sort ignored (the aggregation owns the ordering)…
    expect(qb.flatten().filter((c) => c.method === 'orderBy')).toEqual([
      { method: 'orderBy', args: ['count', 'desc'] },
      { method: 'orderBy', args: ['city', 'asc'] },
    ]);
    // …counts arrive numeric.
    expect(rows).toEqual([
      { value: 'NYC', count: 3 },
      { value: 'LA', count: 2 },
    ]);
  });

  it('Lucid mode: reads field and bounds off the envelope, rejects unknowns loudly', async () => {
    const spec = defineFilter({ filterable: ['city'] });
    const qb = new ExecMock();
    const rows = await groupByCountFromRequest(
      qb,
      spec,
      ctxWith({ groupByCount: { field: 'city', limit: '1' } }),
    );
    expect(qb.find('limit')?.args).toEqual([1]);
    expect(rows).toHaveLength(0);

    await expect(groupByCountFromRequest(new ExecMock(), spec, ctxWith({}))).rejects.toThrow(
      InvalidColumnFilterError,
    );
    await expect(
      groupByCountFromRequest(new ExecMock(), spec, ctxWith({ groupByCount: { field: 'nope' } })),
    ).rejects.toThrow(InvalidColumnFilterError);
  });

  it('custom mode: the class narrows the draft, the adapter counts it', async () => {
    const seen: Array<{ field: string; draft: Bag; opts: unknown }> = [];
    const adapter: GroupByCountAdapter<Bag> = {
      groupByCount: async (field, draft, opts) => {
        seen.push({ field, draft, opts });
        return [{ value: 'etl', count: 2 }];
      },
    };
    const draft: Bag = { log: [] };
    const rows = await groupByCountFromRequest(draft, BagFilter, ctxWith({ tag: ['a', 'b'] }), {
      adapter,
      field: 'tag',
      limit: 50,
    });
    expect(rows).toEqual([{ value: 'etl', count: 2 }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.field).toBe('tag');
    // Scope reached the adapter as a narrowed draft — not a query string.
    expect(seen[0]?.draft.tags).toEqual(['a', 'b']);
    expect(seen[0]?.opts).toEqual({ limit: 50 });
  });

  it('custom mode: an unknown scope field fails in the class, before the adapter runs', async () => {
    let counted = false;
    const adapter: GroupByCountAdapter<Bag> = {
      groupByCount: async () => {
        counted = true;
        return [];
      },
    };
    await expect(
      groupByCountFromRequest({ log: [] }, BagFilter, ctxWith({ filter: { nope: 'x' } }), {
        adapter,
        field: 'tag',
      }),
    ).rejects.toThrow(InvalidColumnFilterError);
    expect(counted).toBe(false);
  });

  it('custom mode: a missing field fails before counting', async () => {
    const adapter: GroupByCountAdapter<Bag> = { groupByCount: async () => [] };
    await expect(
      groupByCountFromRequest({ log: [] }, BagFilter, ctxWith({}), { adapter }),
    ).rejects.toThrow(InvalidColumnFilterError);
  });

  it('shares the scope machinery with the listing path (no second parser)', async () => {
    // applyCustomFilter is the scope both paths run — the helper only adds the axis.
    const draft: Bag = { log: [] };
    await applyCustomFilter(draft, BagFilter, ctxWith({ tag: 'etl' }));
    expect(draft.tags).toEqual(['etl']);
  });
});
