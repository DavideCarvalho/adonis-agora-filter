import { describe, expect, it } from 'vitest';
import { parseDistinct, parseFilterRequest } from '../src/parse_request.js';

describe('parseFilterRequest', () => {
  it('parses scalar, operator-object, and comma-list filters', () => {
    const input = parseFilterRequest({
      filter: { status: 'active', age: { gte: '18' }, id: '1,2,3' },
    });
    expect(input.filters).toEqual([
      { field: 'status', operator: 'equals', value: 'active' },
      { field: 'age', operator: 'gte', value: '18' },
      { field: 'id', operator: 'in', value: ['1', '2', '3'] },
    ]);
  });

  it('parses array filter values as IN', () => {
    const input = parseFilterRequest({ filter: { id: ['1', '2'] } });
    expect(input.filters).toEqual([{ field: 'id', operator: 'in', value: ['1', '2'] }]);
  });

  it('parses sort with direction prefixes', () => {
    const input = parseFilterRequest({ sort: '-createdAt,name' });
    expect(input.sort).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
  });

  it('parses flat and nested pagination + search', () => {
    expect(parseFilterRequest({ page: '2', size: '10', search: 'foo' })).toEqual({
      page: 2,
      size: 10,
      search: 'foo',
    });
    expect(parseFilterRequest({ page: { number: '3', size: '20' } })).toEqual({
      page: 3,
      size: 20,
    });
  });

  it('parses distinct from a comma string and an array, de-duping', () => {
    expect(parseFilterRequest({ distinct: 'afsc,base' }).distinct).toEqual(['afsc', 'base']);
    expect(parseFilterRequest({ distinct: ['afsc', 'base', 'afsc'] }).distinct).toEqual([
      'afsc',
      'base',
    ]);
    // No distinct key → the field is absent (not an empty array).
    expect(parseFilterRequest({}).distinct).toBeUndefined();
  });

  it('returns an empty input for an empty query', () => {
    expect(parseFilterRequest({})).toEqual({});
  });
});

describe('parseDistinct', () => {
  it('splits a comma string, trims, drops empties and dups', () => {
    expect(parseDistinct(' a , b ,a, ,c')).toEqual(['a', 'b', 'c']);
  });
  it('filters non-strings out of an array', () => {
    expect(parseDistinct(['a', 2, null, 'b'])).toEqual(['a', 'b']);
  });
  it('returns [] for nullish/non-string scalars', () => {
    expect(parseDistinct(undefined)).toEqual([]);
    expect(parseDistinct(42)).toEqual([]);
  });
});

/**
 * The client builder's `build()` output is documented as an interchangeable
 * request shape — a POST search endpoint hands the body to `parseFilterRequest`.
 * It was not: the whole `where` array collapsed into one bogus `in` filter on a
 * field named `where`, which the allow-list then pruned, and `sort`/`paginate`
 * were dropped on the floor. The endpoint answered with unfiltered, unsorted,
 * unpaginated rows and reported no error.
 */
describe('parseFilterRequest — structured `build()` shape', () => {
  const built = {
    filter: {
      where: [
        { field: 'status', operator: 'in', value: ['active', 'pending'] },
        { field: 'age', operator: 'gte', value: 18 },
      ],
    },
    sort: [{ field: 'createdAt', direction: 'desc' }],
    distinct: ['city'],
    paginate: { page: 2, size: 25 },
  };

  it('takes `filter.where` as the column filters, not as one `in` on `where`', () => {
    const out = parseFilterRequest(built);

    expect(out.filters).toEqual([
      { field: 'status', operator: 'in', value: ['active', 'pending'] },
      { field: 'age', operator: 'gte', value: 18 },
    ]);
  });

  it('keeps the sort items', () => {
    expect(parseFilterRequest(built).sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
  });

  it('maps `paginate` onto page/size', () => {
    const out = parseFilterRequest(built);

    expect(out.page).toBe(2);
    expect(out.size).toBe(25);
  });

  it('carries nested OR groups through untouched', () => {
    const out = parseFilterRequest({
      filter: {
        where: [
          { field: 'a', operator: 'equals', value: 1 },
          {
            field: '',
            operator: 'equals',
            OR: [
              { field: 'b', operator: 'equals', value: 2 },
              { field: 'c', operator: 'equals', value: 3 },
            ],
          },
        ],
      },
    });

    expect(out.filters?.[1]?.OR).toEqual([
      { field: 'b', operator: 'equals', value: 2 },
      { field: 'c', operator: 'equals', value: 3 },
    ]);
  });

  it('reads a top-level `where` list, the form OR/AND groups serialize to', () => {
    const out = parseFilterRequest({
      where: [{ field: 'a', operator: 'equals', value: '1' }],
    });

    expect(out.filters).toEqual([{ field: 'a', operator: 'equals', value: '1' }]);
  });

  it('merges a structured list with sibling `filter[field]` entries', () => {
    const out = parseFilterRequest({
      filter: { where: [{ field: 'a', operator: 'equals', value: 1 }], status: 'active' },
    });

    expect(out.filters).toEqual([
      { field: 'a', operator: 'equals', value: 1 },
      { field: 'status', operator: 'equals', value: 'active' },
    ]);
  });

  it('still treats a real column named `where` as a column', () => {
    expect(parseFilterRequest({ filter: { where: 'lobby' } }).filters).toEqual([
      { field: 'where', operator: 'equals', value: 'lobby' },
    ]);
    expect(parseFilterRequest({ filter: { where: { contains: 'lob' } } }).filters).toEqual([
      { field: 'where', operator: 'contains', value: 'lob' },
    ]);
    expect(parseFilterRequest({ filter: { where: ['a', 'b'] } }).filters).toEqual([
      { field: 'where', operator: 'in', value: ['a', 'b'] },
    ]);
  });

  it('leaves the plain query-string shape exactly as before', () => {
    const out = parseFilterRequest({
      filter: { status: 'active', age: { gte: '18' } },
      sort: '-createdAt,name',
      page: '2',
      size: '25',
    });

    expect(out.filters).toEqual([
      { field: 'status', operator: 'equals', value: 'active' },
      { field: 'age', operator: 'gte', value: '18' },
    ]);
    expect(out.sort).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
    expect(out.page).toBe(2);
    expect(out.size).toBe(25);
  });
});
