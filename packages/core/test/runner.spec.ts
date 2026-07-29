import { describe, expect, it } from 'vitest';
import { applyFilter } from '../src/runner.js';
import { InvalidColumnFilterError } from '../src/validate-column-filter.js';
import { MockQueryBuilder } from './mock_query_builder.js';

describe('applyFilter — allow-listing', () => {
  it('applies filters on allowed fields and drops disallowed ones', () => {
    const qb = new MockQueryBuilder();
    applyFilter(
      qb,
      {
        filters: [
          { field: 'name', operator: 'equals', value: 'Al' },
          { field: 'secret', operator: 'equals', value: 'x' },
        ],
      },
      { allowed: ['name'] },
    );
    const flat = qb.flatten();
    expect(flat).toContainEqual({ method: 'where', args: ['name', 'Al'] });
    expect(flat.find((c) => c.args.includes('secret'))).toBeUndefined();
  });

  it('throws on a disallowed field when throwOnInvalid', () => {
    const qb = new MockQueryBuilder();
    expect(() =>
      applyFilter(
        qb,
        { filters: [{ field: 'secret', operator: 'equals', value: 'x' }] },
        { allowed: ['name'], throwOnInvalid: true },
      ),
    ).toThrow(InvalidColumnFilterError);
  });

  it('drops disallowed sort fields, keeps allowed', () => {
    const qb = new MockQueryBuilder();
    applyFilter(
      qb,
      {
        sort: [
          { field: 'name', direction: 'asc' },
          { field: 'secret', direction: 'desc' },
        ],
      },
      { allowed: ['name'] },
    );
    const orderBys = qb.flatten().filter((c) => c.method === 'orderBy');
    expect(orderBys).toEqual([{ method: 'orderBy', args: ['name', 'asc'] }]);
  });

  it('applies search only across searchable columns', () => {
    const qb = new MockQueryBuilder();
    applyFilter(qb, { search: 'foo' }, { allowed: '*', searchable: ['name'] });
    expect(qb.find('orWhereILike')?.args).toEqual(['name', '%foo%']);
  });

  it('applies distinct on allowed fields and drops disallowed ones', () => {
    const qb = new MockQueryBuilder();
    applyFilter(qb, { distinct: ['city', 'secret'] }, { allowed: ['city'] });
    expect(qb.find('distinct')?.args).toEqual(['city']);
  });

  it('resolves a distinct alias before allow-listing', () => {
    const qb = new MockQueryBuilder();
    applyFilter(qb, { distinct: ['town'] }, { allowed: ['city'], aliases: { town: 'city' } });
    expect(qb.find('distinct')?.args).toEqual(['city']);
  });

  it('throws on a disallowed distinct field when throwOnInvalid', () => {
    const qb = new MockQueryBuilder();
    expect(() =>
      applyFilter(qb, { distinct: ['secret'] }, { allowed: ['city'], throwOnInvalid: true }),
    ).toThrow(InvalidColumnFilterError);
  });

  it('drops a relation-path distinct even when the path is filterable', () => {
    const qb = new MockQueryBuilder();
    // `posts.title` is filterable (relation filtering whitelists it), but Lucid
    // compiles relation filters to a correlated EXISTS — the relation never
    // enters the outer FROM, so there is no `posts` alias to project.
    applyFilter(qb, { distinct: ['posts.title', 'city'] }, { allowed: '*' });
    expect(qb.find('distinct')?.args).toEqual(['city']);
  });

  it('adds no distinct at all when every requested field is a relation path', () => {
    const qb = new MockQueryBuilder();
    applyFilter(qb, { distinct: ['posts.title'] }, { allowed: '*' });
    expect(qb.find('distinct')).toBeUndefined();
  });

  it('throws with the join as the stated cause on a relation-path distinct', () => {
    const qb = new MockQueryBuilder();
    expect(() =>
      applyFilter(qb, { distinct: ['posts.title'] }, { allowed: '*', throwOnInvalid: true }),
    ).toThrow(InvalidColumnFilterError);
    // Not an allow-list message — it must send the reader to the join, not to
    // `allowed`.
    expect(() =>
      applyFilter(qb, { distinct: ['posts.title'] }, { allowed: '*', throwOnInvalid: true }),
    ).toThrow(/relation path/i);
  });

  it('keeps a distinct qualified by the ROOT table — that alias is in the FROM', () => {
    const qb = new MockQueryBuilder();
    applyFilter(qb, { distinct: ['users.city'] }, { allowed: '*', table: 'users' });
    expect(qb.find('distinct')?.args).toEqual(['users.city']);
  });

  it('drops a to-many aggregate path from distinct (also not in the FROM)', () => {
    const qb = new MockQueryBuilder();
    applyFilter(qb, { distinct: ['posts.$count'] }, { allowed: '*' });
    expect(qb.find('distinct')).toBeUndefined();
  });

  it('adds no distinct when none is requested', () => {
    const qb = new MockQueryBuilder();
    applyFilter(
      qb,
      { filters: [{ field: 'city', operator: 'equals', value: 'x' }] },
      { allowed: '*' },
    );
    expect(qb.find('distinct')).toBeUndefined();
  });
});

describe('applyFilter — pagination resolution', () => {
  it('resolves defaults and clamps to maxSize', () => {
    const qb = new MockQueryBuilder();
    expect(applyFilter(qb, {}, { allowed: '*' })).toEqual({ page: 1, size: 25 });
    expect(applyFilter(qb, { page: 3, size: 500 }, { allowed: '*', maxSize: 100 })).toEqual({
      page: 3,
      size: 100,
    });
    expect(applyFilter(qb, { size: 10 }, { allowed: '*', defaultSize: 50 })).toEqual({
      page: 1,
      size: 10,
    });
  });
});
