import { describe, expect, it } from 'vitest';
import { applyColumnFilters, applyKeyset, applySearch, applySort } from '../src/lucid_adapter.js';
import type { ColumnFilter } from '../src/operators.js';
import { MockQueryBuilder } from './mock_query_builder.js';

describe('lucid adapter — applyColumnFilters', () => {
  it('translates equals / comparison operators', () => {
    const qb = new MockQueryBuilder();
    applyColumnFilters(qb, [
      { field: 'name', operator: 'equals', value: 'Al' },
      { field: 'age', operator: 'gte', value: 18 },
    ]);
    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['name', 'Al'] });
    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['age', '>=', 18] });
  });

  it('translates contains to an escaped ILIKE pattern', () => {
    const qb = new MockQueryBuilder();
    applyColumnFilters(qb, [{ field: 'name', operator: 'contains', value: '50%_x' }]);
    const call = qb.find('whereILike');
    expect(call?.args[0]).toBe('name');
    // % and _ are escaped, then wrapped.
    expect(call?.args[1]).toBe('%50\\%\\_x%');
  });

  it('translates notContains to a negated ILIKE on the same pattern as contains, excluding NULLs', () => {
    const qb = new MockQueryBuilder();
    applyColumnFilters(qb, [{ field: 'name', operator: 'notContains', value: '50%' }]);
    // The ILIKE runs inside a negated group; no equality test on the raw value is emitted.
    expect(qb.flatten()).toEqual([
      { method: 'whereNotNull', args: ['name'] },
      { method: 'whereILike', args: ['name', '%50\\%%'] },
    ]);
    expect(JSON.stringify(qb)).toContain('"method":"whereNot","args":["<group>"]');
  });

  it('translates in / between / null operators', () => {
    const qb = new MockQueryBuilder();
    applyColumnFilters(qb, [
      { field: 'id', operator: 'in', value: [1, 2, 3] },
      { field: 'score', operator: 'between', value: [10, 20] },
      { field: 'deletedAt', operator: 'isNull' },
    ]);
    expect(qb.find('whereIn')?.args).toEqual(['id', [1, 2, 3]]);
    expect(qb.find('whereBetween')?.args).toEqual(['score', [10, 20]]);
    expect(qb.find('whereNull')?.args).toEqual(['deletedAt']);
  });

  it('composes OR groups', () => {
    const qb = new MockQueryBuilder();
    const filter: ColumnFilter = {
      field: '',
      operator: 'equals',
      OR: [
        { field: 'status', operator: 'equals', value: 'active' },
        { field: 'status', operator: 'equals', value: 'pending' },
      ],
    };
    applyColumnFilters(qb, [filter]);
    const flat = qb.flatten();
    expect(flat).toContainEqual({ method: 'where', args: ['status', 'active'] });
    expect(flat).toContainEqual({ method: 'where', args: ['status', 'pending'] });
  });
});

describe('lucid adapter — applySort / applySearch', () => {
  it('applies sort directives in order', () => {
    const qb = new MockQueryBuilder();
    applySort(qb, [
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
    expect(qb.flatten()).toEqual([
      { method: 'orderBy', args: ['createdAt', 'desc'] },
      { method: 'orderBy', args: ['name', 'asc'] },
    ]);
  });

  it('applies an OR ILIKE search across columns', () => {
    const qb = new MockQueryBuilder();
    applySearch(qb, 'foo', ['name', 'email']);
    const likes = qb.flatten().filter((c) => c.method === 'orWhereILike');
    expect(likes).toEqual([
      { method: 'orWhereILike', args: ['name', '%foo%'] },
      { method: 'orWhereILike', args: ['email', '%foo%'] },
    ]);
  });

  it('no-ops search with no columns or empty term', () => {
    const qb = new MockQueryBuilder();
    applySearch(qb, '', ['name']);
    applySearch(qb, 'x', []);
    expect(qb.flatten()).toEqual([]);
  });
});

describe('lucid adapter — applyKeyset', () => {
  it('single-column keyset seek uses a > comparison for an asc column', () => {
    const qb = new MockQueryBuilder();
    applyKeyset(qb, [{ field: 'id', direction: 'asc' }], [10]);
    expect(qb.flatten()).toEqual([{ method: 'where', args: ['id', '>', 10] }]);
  });

  it('single-column keyset seek uses a < comparison for a desc column', () => {
    const qb = new MockQueryBuilder();
    applyKeyset(qb, [{ field: 'id', direction: 'desc' }], [10]);
    expect(qb.flatten()).toEqual([{ method: 'where', args: ['id', '<', 10] }]);
  });

  it('two-column keyset expands into OR-of-AND tiers with equality prefixes', () => {
    const qb = new MockQueryBuilder();
    applyKeyset(
      qb,
      [
        { field: 'name', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
      ['Bob', 5],
    );
    const flat = qb.flatten();
    // Tier 0: name > 'Bob'
    expect(flat).toContainEqual({ method: 'where', args: ['name', '>', 'Bob'] });
    // Tier 1: name = 'Bob' AND id > 5
    expect(flat).toContainEqual({ method: 'where', args: ['name', 'Bob'] });
    expect(flat).toContainEqual({ method: 'where', args: ['id', '>', 5] });
  });

  it('bounds the leading column first, so the index can seek to the boundary', () => {
    const asc = new MockQueryBuilder();
    applyKeyset(
      asc,
      [
        { field: 'name', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
      ['Bob', 5],
    );
    expect(asc.calls[0]).toEqual({ method: 'where', args: ['name', '>=', 'Bob'] });

    const desc = new MockQueryBuilder();
    applyKeyset(
      desc,
      [
        { field: 'name', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
      ['Bob', 5],
    );
    expect(desc.calls[0]).toEqual({ method: 'where', args: ['name', '<=', 'Bob'] });
  });

  it('adds no leading bound for a NULL boundary or a single-column keyset', () => {
    const nullLead = new MockQueryBuilder();
    applyKeyset(
      nullLead,
      [
        { field: 'name', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
      [null, 5],
    );
    expect(nullLead.flatten()).not.toContainEqual(
      expect.objectContaining({ args: ['name', '>=', null] }),
    );
    expect(nullLead.calls).toHaveLength(1);

    const single = new MockQueryBuilder();
    applyKeyset(single, [{ field: 'id', direction: 'asc' }], [10]);
    expect(single.calls).toHaveLength(1);
  });

  it('no-ops when values do not line up with the keyset', () => {
    const qb = new MockQueryBuilder();
    applyKeyset(qb, [{ field: 'id', direction: 'asc' }], [1, 2]);
    applyKeyset(qb, [], []);
    expect(qb.flatten()).toEqual([]);
  });
});
