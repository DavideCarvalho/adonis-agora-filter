import { filterQuery, filterQueryTyped } from '@adonis-agora/filter-client';
import { describe, expect, it } from 'vitest';
import { BaseFilter } from '../src/base_filter.js';
import { buildCursorPage, encodeCursor } from '../src/cursor.js';
import { applyCustomFilter } from '../src/custom_filter.js';
import { parseQueryString } from '../src/dev_tools/query_string.js';
import { cursorInMemory, defineCollection } from '../src/in_memory.js';
import {
  cursorPage,
  offsetPage,
  parseCursorParams,
  parsePageParams,
  readCursorParams,
  resolveSort,
} from '../src/list_api.js';
import { parseFilterRequest } from '../src/parse_request.js';
import { InvalidColumnFilterError } from '../src/validate-column-filter.js';

describe('offsetPage', () => {
  it('builds the Lucid-shaped envelope', () => {
    expect(offsetPage([1, 2, 3], { total: 120, page: 1, size: 50 })).toEqual({
      data: [1, 2, 3],
      meta: { total: 120, perPage: 50, currentPage: 1, lastPage: 3, firstPage: 1 },
    });
  });

  it('keeps lastPage at least 1 on an empty set', () => {
    expect(offsetPage([], { total: 0, page: 1, size: 25 }).meta).toEqual({
      total: 0,
      perPage: 25,
      currentPage: 1,
      lastPage: 1,
      firstPage: 1,
    });
  });

  it('guards against nonsense numbers', () => {
    const { meta } = offsetPage([], { total: Number.NaN, page: 0, size: 0 });
    expect(meta).toEqual({ total: 0, perPage: 1, currentPage: 1, lastPage: 1, firstPage: 1 });
  });
});

describe('cursorPage', () => {
  it('wraps rows with explicit cursors', () => {
    expect(
      cursorPage(['a'], { nextCursor: 'n', prevCursor: null, hasNext: true, hasPrev: false }),
    ).toEqual({
      data: ['a'],
      meta: { nextCursor: 'n', prevCursor: null, hasNext: true, hasPrev: false },
    });
  });

  it('derives hasNext/hasPrev from the cursors when omitted', () => {
    expect(cursorPage([], { nextCursor: 'n' }).meta).toEqual({
      nextCursor: 'n',
      prevCursor: null,
      hasNext: true,
      hasPrev: false,
    });
    expect(cursorPage([], {}).meta).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasNext: false,
      hasPrev: false,
    });
  });

  it('accepts a CursorPage from buildCursorPage, optionally mapping items', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const page = buildCursorPage(rows, {
      keyset: [{ field: 'id', direction: 'asc' }],
      size: 2,
      backward: false,
      hasCursor: false,
    });
    const response = cursorPage(page, (row) => row.id);
    expect(response).toEqual({
      data: [1, 2],
      meta: { nextCursor: encodeCursor([2]), prevCursor: null, hasNext: true, hasPrev: false },
    });
    expect(cursorPage(page).data).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe('parsePageParams', () => {
  const opts = { defaultSize: 20, maxSize: 50 };

  it('reads page and size', () => {
    expect(parsePageParams({ page: '3', size: '10' }, opts)).toEqual({ page: 3, size: 10 });
    expect(parsePageParams({ page: 2, size: 5 }, opts)).toEqual({ page: 2, size: 5 });
  });

  it('defaults when absent', () => {
    expect(parsePageParams({}, opts)).toEqual({ page: 1, size: 20 });
    expect(parsePageParams({})).toEqual({ page: 1, size: 25 });
  });

  it('falls back to defaults on junk', () => {
    expect(parsePageParams({ page: 'abc', size: ['x'] }, opts)).toEqual({ page: 1, size: 20 });
    expect(parsePageParams({ page: '', size: { a: 1 } }, opts)).toEqual({ page: 1, size: 20 });
  });

  it('clamps out-of-range values', () => {
    expect(parsePageParams({ page: '0', size: '0' }, opts)).toEqual({ page: 1, size: 1 });
    expect(parsePageParams({ page: '-4', size: '9999' }, opts)).toEqual({ page: 1, size: 50 });
    expect(parsePageParams({ page: '2.7', size: '7.9' }, opts)).toEqual({ page: 2, size: 7 });
  });

  it('caps the default at maxSize', () => {
    expect(parsePageParams({}, { defaultSize: 500, maxSize: 100 })).toEqual({ page: 1, size: 100 });
  });
});

describe('parseCursorParams', () => {
  const opts = { defaultSize: 20, maxSize: 50 };

  it('defaults to a forward first page', () => {
    expect(parseCursorParams({}, opts)).toEqual({ size: 20, backward: false });
  });

  it('reads after + first', () => {
    expect(parseCursorParams({ after: 'abc', first: '10' }, opts)).toEqual({
      after: 'abc',
      size: 10,
      backward: false,
    });
  });

  it('reads before + last as a backward page', () => {
    expect(parseCursorParams({ before: 'abc', last: '5' }, opts)).toEqual({
      before: 'abc',
      size: 5,
      backward: true,
    });
  });

  it('lets after win over before', () => {
    expect(parseCursorParams({ after: 'a', before: 'b' }, opts)).toEqual({
      after: 'a',
      size: 20,
      backward: false,
    });
  });

  it('uses the other size when only that one is sent', () => {
    expect(parseCursorParams({ before: 'b', first: '7' }, opts).size).toBe(7);
    expect(parseCursorParams({ last: '7' }, opts).size).toBe(7);
  });

  it('clamps sizes and ignores junk', () => {
    expect(parseCursorParams({ first: '999' }, opts).size).toBe(50);
    expect(parseCursorParams({ first: '0' }, opts).size).toBe(1);
    expect(parseCursorParams({ first: 'x', after: '' }, opts)).toEqual({
      size: 20,
      backward: false,
    });
    expect(parseCursorParams({ after: ['a', 'b'] }, opts)).toEqual({ size: 20, backward: false });
  });

  it('reads the JSON:API page[...] shapes', () => {
    expect(readCursorParams({ page: { after: 'a', first: '3' } })).toEqual({
      after: 'a',
      first: 3,
    });
  });
});

describe('resolveSort', () => {
  const opts = { sortable: ['createdAt', 'name'] as const, default: '-createdAt' };

  it('returns the default when the request has no sort', () => {
    expect(resolveSort(undefined, opts)).toEqual([{ field: 'createdAt', direction: 'desc' }]);
    expect(resolveSort([], opts)).toEqual([{ field: 'createdAt', direction: 'desc' }]);
    expect(
      resolveSort(undefined, {
        sortable: ['name'],
        default: [{ field: 'name', direction: 'asc' }],
      }),
    ).toEqual([{ field: 'name', direction: 'asc' }]);
    expect(resolveSort(undefined, { sortable: ['name'] })).toEqual([]);
  });

  it('accepts parsed items and raw strings', () => {
    const parsed = parseFilterRequest({ sort: '-name,createdAt' }).sort;
    expect(resolveSort(parsed, opts)).toEqual([
      { field: 'name', direction: 'desc' },
      { field: 'createdAt', direction: 'asc' },
    ]);
    expect(resolveSort('name', opts)).toEqual([{ field: 'name', direction: 'asc' }]);
  });

  it('throws InvalidColumnFilterError for a field outside sortable', () => {
    expect(() => resolveSort('-password', opts)).toThrow(InvalidColumnFilterError);
    expect(() => resolveSort('-password', opts)).toThrow(/Unknown sort field: "password"/);
  });
});

describe('client → query string → server round trips', () => {
  it('offset: page/size', () => {
    const qs = parseQueryString(filterQuery().page(3, 40).toQueryString());
    expect(parsePageParams(qs, { maxSize: 100 })).toEqual({ page: 3, size: 40 });
  });

  it('cursor forward: after/first', () => {
    const cursor = encodeCursor([new Date('2026-01-01T00:00:00Z'), 42]);
    const qs = parseQueryString(filterQuery().after(cursor).first(15).toQueryString());
    expect(parseCursorParams(qs)).toEqual({ after: cursor, size: 15, backward: false });
  });

  it('cursor backward: before/last on the typed builder', () => {
    const qs = parseQueryString(
      filterQueryTyped<'name'>().sortDesc('name').before('b+/=').last(5).toQueryString(),
    );
    expect(parseCursorParams(qs)).toEqual({ before: 'b+/=', size: 5, backward: true });
    expect(resolveSort(parseFilterRequest(qs).sort, { sortable: ['name'] })).toEqual([
      { field: 'name', direction: 'desc' },
    ]);
  });

  it('build() output carries the cursor params too', () => {
    const built = filterQuery().after('c').first(3).build();
    expect(parseCursorParams(built)).toEqual({ after: 'c', size: 3, backward: false });
  });

  it('a full cursor walk over an in-memory collection, through the client', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const collection = defineCollection<{ id: number }>({ fields: { id: 'number' } });
    const fetchPage = (queryString: string) => {
      const qs = parseQueryString(queryString);
      const { after, before, size } = parseCursorParams(qs, { defaultSize: 2 });
      const page = cursorInMemory(
        collection,
        rows,
        {
          ...(after !== undefined && { after }),
          ...(before !== undefined && { before }),
          first: size,
          last: size,
        },
        { allowed: [], sortable: ['id'] },
      );
      return cursorPage(page);
    };
    const p1 = fetchPage(filterQuery().toQueryString());
    expect(p1.data.map((r) => r.id)).toEqual([1, 2]);
    const p2 = fetchPage(
      filterQuery()
        .after(p1.meta.nextCursor as string)
        .toQueryString(),
    );
    expect(p2.data.map((r) => r.id)).toEqual([3, 4]);
    expect(p2.meta.hasPrev).toBe(true);
    const back = fetchPage(
      filterQuery()
        .before(p2.meta.prevCursor as string)
        .toQueryString(),
    );
    expect(back.data.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('custom backend end to end', () => {
  interface Draft {
    status?: string;
  }
  class JobFilter extends BaseFilter<Draft> {
    status(value: unknown) {
      this.$query.status = String(value);
    }
  }
  const jobs = Array.from({ length: 7 }, (_, i) => ({
    id: i + 1,
    status: i % 2 === 0 ? 'done' : 'failed',
  }));

  async function list(queryString: string) {
    const qs = parseQueryString(queryString);
    const ctx = { request: { qs: () => qs } };
    const draft: Draft = {};
    await applyCustomFilter(draft, JobFilter, ctx);
    const sort = resolveSort(parseFilterRequest(qs).sort, { sortable: ['id'], default: '-id' });
    const { page, size } = parsePageParams(qs, { defaultSize: 2, maxSize: 10 });
    let matching = jobs.filter((j) => draft.status === undefined || j.status === draft.status);
    if (sort[0]?.direction === 'desc') matching = matching.slice().reverse();
    return offsetPage(matching.slice((page - 1) * size, page * size), {
      total: matching.length,
      page,
      size,
    });
  }

  it('filters, sorts and pages', async () => {
    const res = await list(filterQuery().where('status', 'done').page(2, 2).toQueryString());
    expect(res).toEqual({
      data: [
        { id: 3, status: 'done' },
        { id: 1, status: 'done' },
      ],
      meta: { total: 4, perPage: 2, currentPage: 2, lastPage: 2, firstPage: 1 },
    });
  });

  it('rejects an unknown field and an unknown sort', async () => {
    await expect(list(filterQuery().where('nope', 'x').toQueryString())).rejects.toThrow(
      InvalidColumnFilterError,
    );
    await expect(list(filterQuery().sort('status').toQueryString())).rejects.toThrow(
      InvalidColumnFilterError,
    );
  });
});
