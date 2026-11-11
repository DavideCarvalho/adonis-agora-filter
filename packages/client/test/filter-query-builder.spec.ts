import { describe, expect, it } from 'vitest';
import { FilterQueryBuilder, filterQuery } from '../src/filter-query-builder.js';
import type { FilterOperator } from '../src/types.js';

describe('FilterQueryBuilder', () => {
  describe('factory', () => {
    it('filterQuery() returns a new builder', () => {
      const q = filterQuery();
      expect(q).toBeInstanceOf(FilterQueryBuilder);
    });
  });

  describe('where(field, value) — equals', () => {
    it('builds a single equals filter', () => {
      const result = filterQuery().where('name', 'foo').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'equals', value: 'foo' }],
        },
      });
    });

    it('handles numeric values', () => {
      const result = filterQuery().where('age', 25).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'age', operator: 'equals', value: 25 }],
        },
      });
    });

    it('handles boolean values', () => {
      const result = filterQuery().where('active', true).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'active', operator: 'equals', value: true }],
        },
      });
    });

    it('handles null value', () => {
      const result = filterQuery().where('deletedAt', null).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'deletedAt', operator: 'equals', value: null }],
        },
      });
    });
  });

  describe('where(field, operator, value)', () => {
    it('builds with contains', () => {
      const result = filterQuery().where('name', 'contains', 'fleet').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'contains', value: 'fleet' }],
        },
      });
    });

    it('builds with gte', () => {
      const result = filterQuery().where('age', 'gte', 25).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'age', operator: 'gte', value: 25 }],
        },
      });
    });

    it('builds with lte', () => {
      const result = filterQuery().where('age', 'lte', 65).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'age', operator: 'lte', value: 65 }],
        },
      });
    });

    it('builds with between', () => {
      const result = filterQuery().where('age', 'between', [18, 65]).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'age', operator: 'between', value: [18, 65] }],
        },
      });
    });

    it('builds with in', () => {
      const result = filterQuery().where('status', 'in', ['A', 'B']).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'status', operator: 'in', value: ['A', 'B'] }],
        },
      });
    });

    it('builds with isNull (no value needed)', () => {
      // isNull is a unary operator — use the 2-arg form
      const result = filterQuery().where('deletedAt', 'isNull').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'deletedAt', operator: 'isNull', value: undefined }],
        },
      });
    });

    it('builds with startsWith', () => {
      const result = filterQuery().where('name', 'startsWith', 'Al').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'startsWith', value: 'Al' }],
        },
      });
    });

    it('builds with endsWith', () => {
      const result = filterQuery().where('name', 'endsWith', 'ce').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'endsWith', value: 'ce' }],
        },
      });
    });
  });

  describe('where(field, array) — auto in', () => {
    it('treats array value as in operator', () => {
      const result = filterQuery().where('status', ['A', 'B']).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'status', operator: 'in', value: ['A', 'B'] }],
        },
      });
    });
  });

  describe('multiple conditions', () => {
    it('chains multiple where calls on different fields', () => {
      const result = filterQuery()
        .where('name', 'contains', 'fleet')
        .where('status', ['COMPLETED', 'FAILED'])
        .where('age', 'gte', 18)
        .build();

      expect(result).toEqual({
        filter: {
          where: [
            { field: 'name', operator: 'contains', value: 'fleet' },
            { field: 'status', operator: 'in', value: ['COMPLETED', 'FAILED'] },
            { field: 'age', operator: 'gte', value: 18 },
          ],
        },
      });
    });
  });

  describe('or() composition', () => {
    it('creates OR group', () => {
      const result = filterQuery()
        .where('status', 'in', ['COMPLETED', 'FAILED'])
        .or((q) => q.where('name', 'contains', 'sync').where('email', 'contains', 'sync'))
        .build();

      expect(result.filter.where).toHaveLength(2);
      expect(result.filter.where[0]).toEqual({
        field: 'status',
        operator: 'in',
        value: ['COMPLETED', 'FAILED'],
      });
      expect(result.filter.where[1]!.OR).toHaveLength(2);
      expect(result.filter.where[1]!.OR![0]).toEqual({
        field: 'name',
        operator: 'contains',
        value: 'sync',
      });
      expect(result.filter.where[1]!.OR![1]).toEqual({
        field: 'email',
        operator: 'contains',
        value: 'sync',
      });
    });
  });

  describe('and() composition', () => {
    it('creates AND group', () => {
      const result = filterQuery()
        .and((q) => q.add('age', 'gte', 18).add('age', 'lte', 65))
        .build();

      expect(result.filter.where).toHaveLength(1);
      expect(result.filter.where[0]!.AND).toHaveLength(2);
      expect(result.filter.where[0]!.AND![0]).toEqual({
        field: 'age',
        operator: 'gte',
        value: 18,
      });
      expect(result.filter.where[0]!.AND![1]).toEqual({
        field: 'age',
        operator: 'lte',
        value: 65,
      });
    });
  });

  describe('empty builder', () => {
    it('builds empty where array', () => {
      expect(filterQuery().build()).toEqual({ filter: { where: [] } });
    });
  });

  describe('toFlatObject()', () => {
    it('simple equals → { field: value }', () => {
      const result = filterQuery().where('name', 'foo').toFlatObject();
      expect(result).toEqual({ name: 'foo' });
    });

    it('array (in) → { field: [values] }', () => {
      const result = filterQuery().where('status', ['A', 'B']).toFlatObject();
      expect(result).toEqual({ status: ['A', 'B'] });
    });

    it('operator → { field: { operator: value } }', () => {
      const result = filterQuery().where('age', 'gte', 18).toFlatObject();
      expect(result).toEqual({ age: { gte: 18 } });
    });

    it('multiple operators on same field via add() → merged', () => {
      const result = filterQuery()
        .add('createdAt', 'gte', '2026-01-01')
        .add('createdAt', 'lte', '2026-12-31')
        .toFlatObject();
      expect(result).toEqual({
        createdAt: { gte: '2026-01-01', lte: '2026-12-31' },
      });
    });

    it('mixed fields', () => {
      const result = filterQuery()
        .where('name', 'foo')
        .where('status', ['A', 'B'])
        .where('createdAt', 'gte', '2026-01-01')
        .toFlatObject();
      expect(result).toEqual({
        name: 'foo',
        status: ['A', 'B'],
        createdAt: { gte: '2026-01-01' },
      });
    });
  });

  describe('convenience methods', () => {
    it('equals(field, value)', () => {
      const result = filterQuery().equals('name', 'foo').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'equals', value: 'foo' }],
        },
      });
    });

    it('notEquals(field, value)', () => {
      const result = filterQuery().notEquals('status', 'deleted').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'status', operator: 'notEquals', value: 'deleted' }],
        },
      });
    });

    it('contains(field, value)', () => {
      const result = filterQuery().contains('name', 'fleet').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'contains', value: 'fleet' }],
        },
      });
    });

    it('in(field, values)', () => {
      const result = filterQuery().in('status', ['A', 'B']).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'status', operator: 'in', value: ['A', 'B'] }],
        },
      });
    });

    it('notIn(field, values)', () => {
      const result = filterQuery().notIn('status', ['deleted']).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'status', operator: 'notIn', value: ['deleted'] }],
        },
      });
    });

    it('between(field, low, high)', () => {
      const result = filterQuery().between('age', 18, 65).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'age', operator: 'between', value: [18, 65] }],
        },
      });
    });

    it('gt(field, value)', () => {
      const result = filterQuery().gt('age', 18).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'age', operator: 'gt', value: 18 }],
        },
      });
    });

    it('gte(field, value)', () => {
      const result = filterQuery().gte('age', 18).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'age', operator: 'gte', value: 18 }],
        },
      });
    });

    it('lt(field, value)', () => {
      const result = filterQuery().lt('age', 65).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'age', operator: 'lt', value: 65 }],
        },
      });
    });

    it('lte(field, value)', () => {
      const result = filterQuery().lte('age', 65).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'age', operator: 'lte', value: 65 }],
        },
      });
    });

    it('isNull(field)', () => {
      const result = filterQuery().isNull('deletedAt').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'deletedAt', operator: 'isNull', value: undefined }],
        },
      });
    });

    it('isNotNull(field)', () => {
      const result = filterQuery().isNotNull('email').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'email', operator: 'isNotNull', value: undefined }],
        },
      });
    });

    it('isEmpty(field)', () => {
      const result = filterQuery().isEmpty('notes').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'notes', operator: 'isEmpty', value: undefined }],
        },
      });
    });

    it('isNotEmpty(field)', () => {
      const result = filterQuery().isNotEmpty('notes').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'notes', operator: 'isNotEmpty', value: undefined }],
        },
      });
    });

    it('startsWith(field, value)', () => {
      const result = filterQuery().startsWith('name', 'Al').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'startsWith', value: 'Al' }],
        },
      });
    });

    it('endsWith(field, value)', () => {
      const result = filterQuery().endsWith('name', 'ce').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'endsWith', value: 'ce' }],
        },
      });
    });
  });

  describe('set() extra keys', () => {
    it('adds extra keys to build result', () => {
      const result = filterQuery().where('status', 'active').set('page', 1).set('size', 25).build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'status', operator: 'equals', value: 'active' }],
        },
        page: 1,
        size: 25,
      });
    });

    it('extra keys appear in toQueryString', () => {
      const qs = filterQuery().where('status', 'active').set('page', 1).toQueryString();
      expect(qs).toContain('filter%5Bstatus%5D=active');
      expect(qs).toContain('page=1');
    });

    it('empty builder with set() still includes extra keys', () => {
      const result = filterQuery().set('page', 1).build();
      expect(result).toEqual({ filter: { where: [] }, page: 1 });
    });
  });

  describe('where() replaces semantics', () => {
    it('where() replaces existing filter for same field', () => {
      const result = filterQuery().where('status', 'PENDING').where('status', 'COMPLETED').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'status', operator: 'equals', value: 'COMPLETED' }],
        },
      });
    });

    it('where() after add() replaces all filters for that field', () => {
      const result = filterQuery()
        .add('createdAt', 'gte', '2026-01-01')
        .add('createdAt', 'lte', '2026-12-31')
        .where('createdAt', 'equals', '2026-06-15')
        .build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'createdAt', operator: 'equals', value: '2026-06-15' }],
        },
      });
    });

    it('convenience methods use where() (replace) semantics', () => {
      const result = filterQuery().contains('name', 'alpha').contains('name', 'beta').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'contains', value: 'beta' }],
        },
      });
    });

    it('where() does not affect other fields', () => {
      const result = filterQuery()
        .where('name', 'foo')
        .where('status', 'ACTIVE')
        .where('name', 'bar')
        .build();
      expect(result).toEqual({
        filter: {
          where: [
            { field: 'status', operator: 'equals', value: 'ACTIVE' },
            { field: 'name', operator: 'equals', value: 'bar' },
          ],
        },
      });
    });
  });

  describe('add() accumulates', () => {
    it('add() accumulates multiple filters for same field', () => {
      const result = filterQuery()
        .add('createdAt', 'gte', '2026-01-01')
        .add('createdAt', 'lte', '2026-12-31')
        .build();
      expect(result).toEqual({
        filter: {
          where: [
            { field: 'createdAt', operator: 'gte', value: '2026-01-01' },
            { field: 'createdAt', operator: 'lte', value: '2026-12-31' },
          ],
        },
      });
    });

    it('range pattern: addGte + addLte on same field', () => {
      const result = filterQuery().addGte('age', 18).addLte('age', 65).build();
      expect(result).toEqual({
        filter: {
          where: [
            { field: 'age', operator: 'gte', value: 18 },
            { field: 'age', operator: 'lte', value: 65 },
          ],
        },
      });
    });

    it('range pattern: addGt + addLt on same field', () => {
      const result = filterQuery().addGt('score', 0).addLt('score', 100).build();
      expect(result).toEqual({
        filter: {
          where: [
            { field: 'score', operator: 'gt', value: 0 },
            { field: 'score', operator: 'lt', value: 100 },
          ],
        },
      });
    });

    it('add() mixed with where() on different fields', () => {
      const result = filterQuery()
        .where('status', 'COMPLETED')
        .add('createdAt', 'gte', '2026-01-01')
        .add('createdAt', 'lte', '2026-12-31')
        .build();
      expect(result).toEqual({
        filter: {
          where: [
            { field: 'status', operator: 'equals', value: 'COMPLETED' },
            { field: 'createdAt', operator: 'gte', value: '2026-01-01' },
            { field: 'createdAt', operator: 'lte', value: '2026-12-31' },
          ],
        },
      });
    });
  });

  describe('remove()', () => {
    it('remove() removes all filters for a field', () => {
      const result = filterQuery()
        .where('status', 'COMPLETED')
        .where('name', 'contains', 'fleet')
        .remove('status')
        .build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'contains', value: 'fleet' }],
        },
      });
    });

    it('remove() removes accumulated add() filters too', () => {
      const result = filterQuery()
        .add('createdAt', 'gte', '2026-01-01')
        .add('createdAt', 'lte', '2026-12-31')
        .where('status', 'COMPLETED')
        .remove('createdAt')
        .build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'status', operator: 'equals', value: 'COMPLETED' }],
        },
      });
    });

    it('remove() on non-existent field is a no-op', () => {
      const result = filterQuery().where('status', 'COMPLETED').remove('nonExistent').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'status', operator: 'equals', value: 'COMPLETED' }],
        },
      });
    });
  });

  describe('clear()', () => {
    it('clear() removes all filters and extra', () => {
      const result = filterQuery()
        .where('status', 'COMPLETED')
        .where('name', 'fleet')
        .set('page', 1)
        .set('size', 25)
        .clear()
        .build();
      expect(result).toEqual({ filter: { where: [] } });
    });

    it('clear() resets groups (OR/AND)', () => {
      const q = filterQuery()
        .equals('a', 1)
        .or((sub) => sub.equals('b', 2))
        .clear()
        .equals('c', 3);
      const result = q.build();
      // Should only have 'c', no 'b' from the OR group
      expect(result.filter.where).toHaveLength(1);
      expect(result.filter.where[0]!.field).toBe('c');
    });

    it('clear() allows rebuilding from scratch', () => {
      const builder = filterQuery()
        .where('status', 'COMPLETED')
        .set('page', 1)
        .clear()
        .where('name', 'new-value')
        .set('page', 2);

      expect(builder.build()).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'equals', value: 'new-value' }],
        },
        page: 2,
      });
    });
  });

  describe('fluent chaining', () => {
    it('all methods return this for chaining', () => {
      const builder = filterQuery();
      const result = builder
        .where('a', 'foo')
        .equals('b', 'bar')
        .contains('c', 'baz')
        .in('d', [1, 2])
        .between('e', 0, 10)
        .gt('f', 5)
        .gte('g', 5)
        .lt('h', 10)
        .lte('i', 10)
        .isNull('j')
        .isNotNull('k')
        .isEmpty('l')
        .isNotEmpty('m')
        .startsWith('n', 'A')
        .endsWith('o', 'Z')
        .set('page', 1)
        .or((q) => q.where('p', 'x'))
        .and((q) => q.where('q', 'y'));

      expect(result).toBe(builder);
      expect(result.build().filter.where).toHaveLength(17);
    });

    it('add, remove, clear return this for chaining', () => {
      const builder = filterQuery();
      const result = builder
        .add('a', 'gte', 1)
        .add('a', 'lte', 10)
        .addGte('b', 5)
        .addLte('b', 15)
        .addGt('c', 0)
        .addLt('c', 100)
        .remove('c')
        .clear();

      expect(result).toBe(builder);
      expect(result.build()).toEqual({ filter: { where: [] } });
    });
  });

  describe('build returns FilterQueryResult shape', () => {
    it('has where array and extra keys', () => {
      const result = filterQuery().equals('name', 'foo').set('page', 2).build();
      expect(result.filter.where).toBeInstanceOf(Array);
      expect(result.filter.where).toHaveLength(1);
      expect(result.page).toBe(2);
    });
  });

  describe('build() idempotency', () => {
    it('build() is idempotent', () => {
      const b = filterQuery().equals('name', 'foo').gte('age', 18);
      const r1 = b.build();
      const r2 = b.build();
      expect(r1).toEqual(r2);
    });
  });

  describe('special characters in values', () => {
    it('handles values with special URL characters', () => {
      const result = filterQuery().where('email', 'test+user@example.com').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'email', operator: 'equals', value: 'test+user@example.com' }],
        },
      });
    });

    it('handles values with spaces', () => {
      const result = filterQuery().where('name', 'John Doe').build();
      expect(result).toEqual({
        filter: {
          where: [{ field: 'name', operator: 'equals', value: 'John Doe' }],
        },
      });
    });
  });

  // ─── Safeguards ─────────────────────────────────────────────────────────────

  describe('safeguards — scalar operators reject arrays', () => {
    it('equals throws when value is an array', () => {
      expect(() => filterQuery().equals('x', [1, 2] as any)).toThrow(/scalar/);
    });

    it('notEquals throws when value is an array', () => {
      expect(() => filterQuery().notEquals('x', [1, 2] as any)).toThrow(/scalar/);
    });

    it('gt throws when value is an array', () => {
      expect(() => filterQuery().gt('x', [1] as any)).toThrow(/scalar/);
    });

    it('gte throws when value is an array', () => {
      expect(() => filterQuery().gte('x', [1] as any)).toThrow(/scalar/);
    });

    it('lt throws when value is an array', () => {
      expect(() => filterQuery().lt('x', [1] as any)).toThrow(/scalar/);
    });

    it('lte throws when value is an array', () => {
      expect(() => filterQuery().lte('x', [1] as any)).toThrow(/scalar/);
    });

    it('where with equals and array throws', () => {
      expect(() => filterQuery().where('x', 'equals', [1, 2])).toThrow(/scalar/);
    });
  });

  describe('safeguards — string operators reject non-strings', () => {
    it('contains throws for non-string value', () => {
      expect(() => filterQuery().contains('x', 123 as any)).toThrow(/string/);
    });

    it('where with notContains and number throws', () => {
      expect(() => filterQuery().where('x', 'notContains', 42)).toThrow(/string/);
    });

    it('where with iContains and boolean throws', () => {
      expect(() => filterQuery().where('x', 'iContains', true)).toThrow(/string/);
    });

    it('startsWith throws for non-string value', () => {
      expect(() => filterQuery().startsWith('x', 99 as any)).toThrow(/string/);
    });

    it('endsWith throws for non-string value', () => {
      expect(() => filterQuery().endsWith('x', false as any)).toThrow(/string/);
    });

    it('contains throws for array value', () => {
      expect(() => filterQuery().where('x', 'contains', ['a'])).toThrow(/string/);
    });
  });

  describe('safeguards — array operators reject scalars', () => {
    it('in throws when value is a scalar string', () => {
      expect(() => filterQuery().in('x', 'not-array' as any)).toThrow(/array/);
    });

    it('in throws when value is a number', () => {
      expect(() => filterQuery().in('x', 42 as any)).toThrow(/array/);
    });

    it('notIn throws when value is a scalar', () => {
      expect(() => filterQuery().notIn('x', 'scalar' as any)).toThrow(/array/);
    });

    it('where with isAnyOf and scalar throws', () => {
      expect(() => filterQuery().where('x', 'isAnyOf', 'not-array')).toThrow(/array/);
    });
  });

  describe('safeguards — tuple operators require 2-element array', () => {
    it('between via where() throws for 1-element array', () => {
      expect(() => filterQuery().where('x', 'between', [1])).toThrow(/tuple/);
    });

    it('between via where() throws for 3-element array', () => {
      expect(() => filterQuery().where('x', 'between', [1, 2, 3])).toThrow(/tuple/);
    });

    it('between via where() throws for empty array', () => {
      expect(() => filterQuery().where('x', 'between', [])).toThrow(/tuple/);
    });

    it('notBetween via where() throws for scalar', () => {
      expect(() => filterQuery().where('x', 'notBetween', 42)).toThrow(/tuple/);
    });

    it('between via where() with correct 2-element array works', () => {
      expect(() => filterQuery().where('x', 'between', [1, 10])).not.toThrow();
    });
  });

  describe('safeguards — unary operators reject values', () => {
    it('isNull throws when a non-null value is provided', () => {
      expect(() => filterQuery().where('x', 'isNull', 'something')).toThrow(/does not accept/);
    });

    it('isNotNull throws when a value is provided', () => {
      expect(() => filterQuery().where('x', 'isNotNull', 42)).toThrow(/does not accept/);
    });

    it('isEmpty throws when a value is provided', () => {
      expect(() => filterQuery().where('x', 'isEmpty', 'val')).toThrow(/does not accept/);
    });

    it('isNotEmpty throws when a value is provided', () => {
      expect(() => filterQuery().where('x', 'isNotEmpty', true)).toThrow(/does not accept/);
    });

    it('exists throws when a value is provided', () => {
      expect(() => filterQuery().where('x', 'exists', 1)).toThrow(/does not accept/);
    });

    it('notExists throws when a value is provided', () => {
      expect(() => filterQuery().where('x', 'notExists', 'yes')).toThrow(/does not accept/);
    });

    it('isNull allows null value (treated as absent)', () => {
      expect(() => filterQuery().where('x', 'isNull', null)).not.toThrow();
    });

    it('unary operators work via 2-arg where()', () => {
      expect(() => filterQuery().where('x', 'isNull')).not.toThrow();
      expect(() => filterQuery().where('x', 'isNotNull')).not.toThrow();
      expect(() => filterQuery().where('x', 'isEmpty')).not.toThrow();
      expect(() => filterQuery().where('x', 'isNotEmpty')).not.toThrow();
      expect(() => filterQuery().where('x', 'exists')).not.toThrow();
      expect(() => filterQuery().where('x', 'notExists')).not.toThrow();
    });
  });

  describe('safeguards — add() rejects non-range operators', () => {
    it('add throws for equals operator', () => {
      expect(() => filterQuery().add('x', 'equals', 'v')).toThrow(/where/);
    });

    it('add throws for contains operator', () => {
      expect(() => filterQuery().add('x', 'contains', 'v')).toThrow(/where/);
    });

    it('add throws for in operator', () => {
      expect(() => filterQuery().add('x', 'in', [1, 2])).toThrow(/where/);
    });

    it('add throws for between operator', () => {
      expect(() => filterQuery().add('x', 'between', [1, 10])).toThrow(/where/);
    });

    it('add throws for isNull operator', () => {
      expect(() => filterQuery().add('x', 'isNull')).toThrow(/where/);
    });

    it('add throws for notEquals operator', () => {
      expect(() => filterQuery().add('x', 'notEquals', 'v')).toThrow(/where/);
    });

    it('add throws for startsWith operator', () => {
      expect(() => filterQuery().add('x', 'startsWith', 'v')).toThrow(/where/);
    });

    it('add allows gt', () => {
      expect(() => filterQuery().add('x', 'gt', 1)).not.toThrow();
    });

    it('add allows gte', () => {
      expect(() => filterQuery().add('x', 'gte', 1)).not.toThrow();
    });

    it('add allows lt', () => {
      expect(() => filterQuery().add('x', 'lt', 10)).not.toThrow();
    });

    it('add allows lte', () => {
      expect(() => filterQuery().add('x', 'lte', 10)).not.toThrow();
    });

    it('add with range operator still validates value', () => {
      expect(() => filterQuery().add('x', 'gte', [1] as any)).toThrow(/scalar/);
    });
  });

  describe('safeguards — valid usage does not throw', () => {
    it('equals with string value works', () => {
      expect(() => filterQuery().equals('x', 'hello')).not.toThrow();
    });

    it('equals with number value works', () => {
      expect(() => filterQuery().equals('x', 42)).not.toThrow();
    });

    it('equals with boolean value works', () => {
      expect(() => filterQuery().equals('x', true)).not.toThrow();
    });

    it('equals with null value works', () => {
      expect(() => filterQuery().equals('x', null)).not.toThrow();
    });

    it('in with array works', () => {
      expect(() => filterQuery().in('x', [1, 2, 3])).not.toThrow();
    });

    it('in with empty array works', () => {
      expect(() => filterQuery().in('x', [])).not.toThrow();
    });

    it('contains with string works', () => {
      expect(() => filterQuery().contains('x', 'hello')).not.toThrow();
    });

    it('between with 2-element array works', () => {
      expect(() => filterQuery().between('x', 1, 10)).not.toThrow();
    });

    it('addGte + addLte range pattern works', () => {
      expect(() => filterQuery().addGte('x', 1).addLte('x', 10)).not.toThrow();
    });

    it('addGt + addLt range pattern works', () => {
      expect(() => filterQuery().addGt('x', 0).addLt('x', 100)).not.toThrow();
    });
  });

  // ─── Sort ─────────────────────────────────────────────────────────────────

  describe('sort()', () => {
    it('adds a sort directive to build result', () => {
      const result = filterQuery().sort('createdAt', 'desc').build();
      expect(result.sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
    });

    it('defaults direction to asc', () => {
      const result = filterQuery().sort('name').build();
      expect(result.sort).toEqual([{ field: 'name', direction: 'asc' }]);
    });

    it('replaces existing sort for same field', () => {
      const result = filterQuery().sort('name', 'asc').sort('name', 'desc').build();
      expect(result.sort).toEqual([{ field: 'name', direction: 'desc' }]);
    });

    it('multiple sorts on different fields', () => {
      const result = filterQuery().sort('createdAt', 'desc').sort('name').build();
      expect(result.sort).toEqual([
        { field: 'createdAt', direction: 'desc' },
        { field: 'name', direction: 'asc' },
      ]);
    });

    it('sortDesc shorthand', () => {
      const result = filterQuery().sortDesc('createdAt').build();
      expect(result.sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
    });

    it('sortAsc shorthand', () => {
      const result = filterQuery().sortAsc('name').build();
      expect(result.sort).toEqual([{ field: 'name', direction: 'asc' }]);
    });

    it('no sort in result when none set', () => {
      const result = filterQuery().where('status', 'active').build();
      expect(result.sort).toBeUndefined();
    });

    it('sort returns this for chaining', () => {
      const builder = filterQuery();
      expect(builder.sort('name')).toBe(builder);
      expect(builder.sortDesc('x')).toBe(builder);
      expect(builder.sortAsc('y')).toBe(builder);
    });

    it('clear() resets sorts', () => {
      const result = filterQuery().sort('name').clear().build();
      expect(result.sort).toBeUndefined();
    });
  });

  // ─── Page ─────────────────────────────────────────────────────────────────

  describe('page()', () => {
    it('sets pagination in build result', () => {
      const result = filterQuery().page(1, 25).build();
      expect(result.paginate).toEqual({ page: 1, size: 25 });
    });

    it('defaults size to 25', () => {
      const result = filterQuery().page(2).build();
      expect(result.paginate).toEqual({ page: 2, size: 25 });
    });

    it('replaces previous pagination', () => {
      const result = filterQuery().page(1, 10).page(3, 50).build();
      expect(result.paginate).toEqual({ page: 3, size: 50 });
    });

    it('no paginate in result when not set', () => {
      const result = filterQuery().where('name', 'foo').build();
      expect(result.paginate).toBeUndefined();
    });

    it('is 1-based: page 1 is the first page on the wire', () => {
      expect(filterQuery().page(1, 10).toQueryString()).toBe('page=1&size=10');
    });

    it('rejects a page below 1 or not an integer', () => {
      expect(() => filterQuery().page(0)).toThrow(RangeError);
      expect(() => filterQuery().page(-1)).toThrow(RangeError);
      expect(() => filterQuery().page(1.5)).toThrow(RangeError);
      expect(() => filterQuery().page(Number.NaN)).toThrow(RangeError);
    });

    it('rejects a size below 1 or not an integer', () => {
      expect(() => filterQuery().page(1, 0)).toThrow(RangeError);
      expect(() => filterQuery().page(1, 2.5)).toThrow(RangeError);
    });

    it('page returns this for chaining', () => {
      const builder = filterQuery();
      expect(builder.page(1)).toBe(builder);
    });

    it('clear() resets pagination', () => {
      const result = filterQuery().page(5, 10).clear().build();
      expect(result.paginate).toBeUndefined();
    });
  });

  // ─── toQueryString with sort + pagination ─────────────────────────────────

  describe('toQueryString() with sort and pagination', () => {
    it('includes sort string in query string', () => {
      const qs = filterQuery().sortDesc('createdAt').sort('name').toQueryString();
      expect(qs).toContain('sort=-createdAt%2Cname');
    });

    it('includes page and size in query string', () => {
      const qs = filterQuery().page(2, 10).toQueryString();
      expect(qs).toContain('page=2');
      expect(qs).toContain('size=10');
    });

    it('sort + pagination + filter in query string', () => {
      const qs = filterQuery()
        .where('status', 'active')
        .sortDesc('createdAt')
        .page(1, 25)
        .toQueryString();
      expect(qs).toContain('filter');
      expect(qs).toContain('sort=-createdAt');
      expect(qs).toContain('page=1');
      expect(qs).toContain('size=25');
    });

    it('no sort or pagination params when not set', () => {
      const qs = filterQuery().where('name', 'foo').toQueryString();
      expect(qs).not.toContain('sort=');
      expect(qs).not.toContain('page=');
      expect(qs).not.toContain('size=');
    });
  });

  // ─── build() with sort + pagination ─────────────────────────────────────

  describe('build() with sort and pagination', () => {
    it('complete build with all features', () => {
      const result = filterQuery()
        .where('status', 'active')
        .include('posts')
        .search('fleet')
        .sortDesc('createdAt')
        .page(1, 25)
        .build();

      expect(result.filter.where).toHaveLength(1);
      expect(result.include).toEqual(['posts']);
      expect(result.search).toBe('fleet');
      expect(result.sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
      expect(result.paginate).toEqual({ page: 1, size: 25 });
    });

    it('build() is idempotent with sort and pagination', () => {
      const b = filterQuery().sort('name').page(1, 10);
      const r1 = b.build();
      const r2 = b.build();
      expect(r1).toEqual(r2);
      // Ensure they are different object references (not shared)
      expect(r1.sort).not.toBe(r2.sort);
      expect(r1.paginate).not.toBe(r2.paginate);
    });
  });

  describe('distinct()', () => {
    it('sets a single distinct field', () => {
      const result = filterQuery().distinct('status').build();
      expect(result.distinct).toEqual(['status']);
    });

    it('sets multiple distinct fields', () => {
      const result = filterQuery().distinct('status', 'type').build();
      expect(result.distinct).toEqual(['status', 'type']);
    });

    it('deduplicates repeated fields across calls', () => {
      const result = filterQuery().distinct('status').distinct('status', 'type').build();
      expect(result.distinct).toEqual(['status', 'type']);
    });

    it('omits the distinct key when no distinct field is set', () => {
      const result = filterQuery().where('status', 'active').build();
      expect(result.distinct).toBeUndefined();
    });

    it('composes with where, sort and pagination', () => {
      const result = filterQuery()
        .where('baseId', 'b1')
        .distinct('afsc')
        .sort('afsc')
        .page(1, 20)
        .build();
      expect(result.filter.where).toHaveLength(1);
      expect(result.distinct).toEqual(['afsc']);
      expect(result.sort).toEqual([{ field: 'afsc', direction: 'asc' }]);
      expect(result.paginate).toEqual({ page: 1, size: 20 });
    });

    it('serializes to a query string', () => {
      const qs = filterQuery().distinct('status', 'type').toQueryString();
      expect(qs).toContain('distinct=status%2Ctype');
    });

    it('clear() resets distinct', () => {
      const result = filterQuery().distinct('status').clear().build();
      expect(result.distinct).toBeUndefined();
    });
  });

  describe('whereDynamic / sortDynamic — runtime escape hatches', () => {
    it('applies a filter on a runtime field name (3-arg)', () => {
      const result = filterQuery().whereDynamic('runtimeCol', 'gte', 5).build();
      expect(result.filter.where).toEqual([{ field: 'runtimeCol', operator: 'gte', value: 5 }]);
    });

    it('accepts the 2-arg unary form and strips any value', () => {
      const result = filterQuery().whereDynamic('deletedAt', 'isNull').build();
      expect(result.filter.where).toEqual([
        { field: 'deletedAt', operator: 'isNull', value: undefined },
      ]);
    });

    it('replaces a prior filter on the same field (where semantics)', () => {
      const result = filterQuery()
        .where('status', 'active')
        .whereDynamic('status', 'notEquals', 'archived')
        .build();
      expect(result.filter.where).toEqual([
        { field: 'status', operator: 'notEquals', value: 'archived' },
      ]);
    });

    it('throws on an unknown operator', () => {
      // 'nope' is intentionally not a valid operator (asserted through to hit the runtime guard).
      expect(() => filterQuery().whereDynamic('x', 'nope' as unknown as FilterOperator, 1)).toThrow(
        /Unknown filter operator/,
      );
    });

    it('sortDynamic adds a directional sort on a runtime field', () => {
      const result = filterQuery().sortDynamic('runtimeCol', 'desc').sortDynamic('other').build();
      expect(result.sort).toEqual([
        { field: 'runtimeCol', direction: 'desc' },
        { field: 'other', direction: 'asc' },
      ]);
    });

    it('notifies subscribers (reactivity) on whereDynamic', () => {
      const q = filterQuery();
      let calls = 0;
      q.subscribe(() => calls++);
      q.whereDynamic('x', 'equals', 1);
      expect(calls).toBe(1);
    });
  });
});
