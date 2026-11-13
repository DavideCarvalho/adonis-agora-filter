import { describe, expect, it } from 'vitest';
import type { CursorPageResponse, OffsetPage } from '../src/index.js';
import { filterQuery, filterQueryTyped } from '../src/index.js';

describe('cursor pagination on the builder', () => {
  it('serializes after/first', () => {
    expect(filterQuery().after('abc').first(20).toQueryString()).toBe('after=abc&first=20');
  });

  it('serializes before/last and encodes the cursor', () => {
    expect(filterQuery().before('a+b/=').last(5).toQueryString()).toBe('before=a%2Bb%2F%3D&last=5');
  });

  it('after and before replace each other; first and last too', () => {
    expect(filterQuery().after('a').before('b').toQueryString()).toBe('before=b');
    expect(filterQuery().before('b').after('a').first(3).last(4).toQueryString()).toBe(
      'after=a&last=4',
    );
  });

  it('a first-page request is just first(n)', () => {
    expect(filterQuery().first(10).build()).toEqual({ filter: { where: [] }, first: 10 });
  });

  it('cursor and page() are mutually exclusive: the last one set wins', () => {
    expect(filterQuery().page(2, 10).after('c').toQueryString()).toBe('after=c');
    expect(filterQuery().after('c').first(5).page(2, 10).toQueryString()).toBe('page=2&size=10');
    expect(filterQuery().page(2, 10).first(5).build()).toEqual({
      filter: { where: [] },
      first: 5,
    });
  });

  it('build() carries cursor params at the top level', () => {
    expect(filterQuery().where('status', 'open').after('x').first(2).build()).toEqual({
      filter: { where: [{ field: 'status', operator: 'equals', value: 'open' }] },
      after: 'x',
      first: 2,
    });
  });

  it('composes with filter and sort', () => {
    expect(
      filterQuery().where('status', 'open').sortDesc('createdAt').after('x').toQueryString(),
    ).toBe('filter%5Bstatus%5D=open&sort=-createdAt&after=x');
  });

  it('clear() drops cursor params', () => {
    expect(filterQuery().after('x').first(2).clear().toQueryString()).toBe('');
  });

  it('validates inputs', () => {
    expect(() => filterQuery().after('')).toThrow(TypeError);
    expect(() => filterQuery().first(0)).toThrow(RangeError);
    expect(() => filterQuery().last(1.5)).toThrow(RangeError);
  });

  it('notifies subscribers', () => {
    const q = filterQuery();
    let calls = 0;
    q.subscribe(() => calls++);
    q.after('a').first(2);
    expect(calls).toBe(2);
  });

  it('is available on the typed builder', () => {
    const qs = filterQueryTyped<'name'>().sortAsc('name').before('c').last(3).toQueryString();
    expect(qs).toBe('sort=name&before=c&last=3');
  });

  it('feeds the next request straight from a cursor response', () => {
    const res: CursorPageResponse<{ id: number }> = {
      data: [{ id: 1 }],
      meta: { nextCursor: 'n1', prevCursor: null, hasNext: true, hasPrev: false },
    };
    const q = filterQuery().first(1);
    if (res.meta.nextCursor) q.after(res.meta.nextCursor);
    expect(q.toQueryString()).toBe('after=n1&first=1');
    const offset: OffsetPage<number> = {
      data: [],
      meta: { total: 0, perPage: 25, currentPage: 1, lastPage: 1, firstPage: 1 },
    };
    expect(offset.meta.lastPage).toBe(1);
  });
});
