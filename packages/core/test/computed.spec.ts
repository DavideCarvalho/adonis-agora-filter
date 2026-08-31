import { describe, expect, it } from 'vitest';
import { applyComputedField, applyComputedSort } from '../src/lucid_adapter.js';
import { applyFilter } from '../src/runner.js';
import type { ComputedFields, FilterConfig } from '../src/types.js';
import { MockQueryBuilder } from './mock_query_builder.js';

describe('applyComputedField — raw predicate with bound value', () => {
  it('inlines the expression and binds the value (equals)', () => {
    const qb = new MockQueryBuilder();
    applyComputedField(qb, "first || ' ' || last", {
      field: 'x',
      operator: 'equals',
      value: 'Ada Lovelace',
    });
    expect(qb.find('whereRaw')?.args).toEqual(["(first || ' ' || last) = ?", ['Ada Lovelace']]);
  });

  it('binds each element of an IN list, never concatenating', () => {
    const qb = new MockQueryBuilder();
    applyComputedField(qb, 'expr', { field: 'x', operator: 'in', value: [1, 2, 3] });
    expect(qb.find('whereRaw')?.args).toEqual(['(expr) in (?, ?, ?)', [1, 2, 3]]);
  });

  it('emits an always-false predicate for an empty IN list', () => {
    const qb = new MockQueryBuilder();
    applyComputedField(qb, 'expr', { field: 'x', operator: 'in', value: [] });
    expect(qb.find('whereRaw')?.args).toEqual(['1 = 0', []]);
  });

  it('translates a LIKE operator with an escaped, bound pattern', () => {
    const qb = new MockQueryBuilder();
    applyComputedField(qb, 'expr', { field: 'x', operator: 'contains', value: 'a%b' });
    const call = qb.find('whereRaw');
    expect(call?.args[0]).toBe('(expr) ilike ?');
    expect((call!.args[1] as string[])[0]).toBe('%a\\%b%');
  });
});

describe('applyComputedSort — appended raw ordering', () => {
  it('emits orderByRaw with the parenthesized expression and direction', () => {
    const qb = new MockQueryBuilder();
    applyComputedSort(qb, 'expr', 'desc');
    expect(qb.find('orderByRaw')?.args).toEqual(['(expr) desc', []]);
  });
});

describe('runner routing of computed fields', () => {
  const computed: ComputedFields = {
    fullName: "first || ' ' || last",
    postCount: ({ alias }) => `(SELECT COUNT(*) FROM posts WHERE posts.author_id = ${alias}.id)`,
  };
  const config: FilterConfig = { allowed: ['first'], computed, table: 'authors' };

  it('routes a computed filter to whereRaw (bypassing the column allow-list)', () => {
    const qb = new MockQueryBuilder();
    // `fullName` is not in `allowed`, but it IS a computed key → applied, not dropped.
    applyFilter(qb, { filters: [{ field: 'fullName', operator: 'equals', value: 'x' }] }, config);
    expect(qb.find('whereRaw')?.args).toEqual(["(first || ' ' || last) = ?", ['x']]);
  });

  it('surfaces the configured table as the alias to a function source', () => {
    const qb = new MockQueryBuilder();
    applyFilter(qb, { filters: [{ field: 'postCount', operator: 'gt', value: 1 }] }, config);
    expect(qb.find('whereRaw')?.args).toEqual([
      '((SELECT COUNT(*) FROM posts WHERE posts.author_id = authors.id)) > ?',
      [1],
    ]);
  });

  it('routes a computed sort to orderByRaw, composing with a real-column sort in order', () => {
    const qb = new MockQueryBuilder();
    applyFilter(
      qb,
      {
        sort: [
          { field: 'postCount', direction: 'desc' },
          { field: 'first', direction: 'asc' },
        ],
      },
      config,
    );
    const orderings = qb
      .flatten()
      .filter((c) => c.method === 'orderByRaw' || c.method === 'orderBy');
    expect(orderings).toEqual([
      {
        method: 'orderByRaw',
        args: ['((SELECT COUNT(*) FROM posts WHERE posts.author_id = authors.id)) desc', []],
      },
      { method: 'orderBy', args: ['first', 'asc'] },
    ]);
  });

  it('does not treat a real column matching no computed key as computed', () => {
    const qb = new MockQueryBuilder();
    applyFilter(qb, { filters: [{ field: 'first', operator: 'equals', value: 'Ada' }] }, config);
    expect(qb.find('whereRaw')).toBeUndefined();
    expect(qb.find('where')?.args).toEqual(['first', 'Ada']);
  });

  it('never resolves an inherited object key as a computed field', () => {
    const qb = new MockQueryBuilder();
    // `constructor` is on Object.prototype — must not be treated as computed.
    applyFilter(
      qb,
      { filters: [{ field: 'constructor', operator: 'equals', value: 'x' }] },
      {
        allowed: '*',
        computed,
        table: 'authors',
      },
    );
    // Falls through to the normal column path (no raw computed predicate).
    expect(qb.flatten().some((c) => c.method === 'whereRaw')).toBe(false);
  });
});
