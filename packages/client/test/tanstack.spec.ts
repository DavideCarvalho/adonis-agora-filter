import { describe, expect, it } from 'vitest';
import { filterQuery } from '../src/filter-query-builder.js';
import {
  applyTanstackTableState,
  tanstackPaginationFromMeta,
  tanstackTableToFilterQuery,
} from '../src/tanstack.js';

describe('tanstack adapter', () => {
  describe('default resolveOperator', () => {
    it('string → iContains', () => {
      const result = tanstackTableToFilterQuery({
        columnFilters: [{ id: 'name', value: 'al' }],
      });
      expect(result.filter.where).toEqual([{ field: 'name', operator: 'iContains', value: 'al' }]);
    });

    it('array → in', () => {
      const result = tanstackTableToFilterQuery({
        columnFilters: [{ id: 'status', value: ['A', 'B'] }],
      });
      expect(result.filter.where).toEqual([{ field: 'status', operator: 'in', value: ['A', 'B'] }]);
    });

    it('other (number/boolean) → equals', () => {
      const result = tanstackTableToFilterQuery({
        columnFilters: [
          { id: 'age', value: 25 },
          { id: 'active', value: true },
        ],
      });
      expect(result.filter.where).toEqual([
        { field: 'age', operator: 'equals', value: 25 },
        { field: 'active', operator: 'equals', value: true },
      ]);
    });
  });

  describe('custom resolveOperator', () => {
    it('uses the supplied operator per column', () => {
      const result = tanstackTableToFilterQuery({
        columnFilters: [
          { id: 'createdAt', value: '2026-01-01' },
          { id: 'name', value: 'al' },
        ],
        resolveOperator: (id) => (id === 'createdAt' ? 'gte' : 'iContains'),
      });
      expect(result.filter.where).toEqual([
        { field: 'createdAt', operator: 'gte', value: '2026-01-01' },
        { field: 'name', operator: 'iContains', value: 'al' },
      ]);
    });
  });

  describe('sorting', () => {
    it('maps desc flag to direction', () => {
      const result = tanstackTableToFilterQuery({
        sorting: [
          { id: 'createdAt', desc: true },
          { id: 'name', desc: false },
        ],
      });
      expect(result.sort).toEqual([
        { field: 'createdAt', direction: 'desc' },
        { field: 'name', direction: 'asc' },
      ]);
    });
  });

  describe('pagination', () => {
    it('sends the 0-based pageIndex as the 1-based page', () => {
      expect(
        tanstackTableToFilterQuery({ pagination: { pageIndex: 0, pageSize: 25 } }).paginate,
      ).toEqual({ page: 1, size: 25 });
      expect(
        tanstackTableToFilterQuery({ pagination: { pageIndex: 2, pageSize: 25 } }).paginate,
      ).toEqual({ page: 3, size: 25 });
    });

    it('maps a response meta back to the 0-based pageIndex', () => {
      expect(
        tanstackPaginationFromMeta({ currentPage: 1, perPage: 25, lastPage: 4, total: 90 }),
      ).toEqual({ pagination: { pageIndex: 0, pageSize: 25 }, pageCount: 4, rowCount: 90 });
      expect(
        tanstackPaginationFromMeta({ current_page: 4, per_page: 25, last_page: 4, total: 90 }),
      ).toEqual({ pagination: { pageIndex: 3, pageSize: 25 }, pageCount: 4, rowCount: 90 });
    });
  });

  describe('fields allowlist', () => {
    it('drops filters and sorts whose id is not allowed', () => {
      const result = tanstackTableToFilterQuery({
        columnFilters: [
          { id: 'name', value: 'al' },
          { id: 'secret', value: 'x' },
        ],
        sorting: [
          { id: 'name', desc: false },
          { id: 'secret', desc: true },
        ],
        fields: ['name'],
      });
      expect(result.filter.where).toEqual([{ field: 'name', operator: 'iContains', value: 'al' }]);
      expect(result.sort).toEqual([{ field: 'name', direction: 'asc' }]);
    });
  });

  describe('empty values', () => {
    it('skips null, undefined, and empty-string filters', () => {
      const result = tanstackTableToFilterQuery({
        columnFilters: [
          { id: 'a', value: null },
          { id: 'b', value: undefined },
          { id: 'c', value: '' },
          { id: 'd', value: 'keep' },
        ],
      });
      expect(result.filter.where).toEqual([{ field: 'd', operator: 'iContains', value: 'keep' }]);
    });
  });

  describe('applyTanstackTableState', () => {
    it('applies onto an existing builder and stays chainable', () => {
      const body = applyTanstackTableState(filterQuery(), {
        columnFilters: [{ id: 'name', value: 'al' }],
        pagination: { pageIndex: 0, pageSize: 10 },
      })
        .include('author')
        .build();

      expect(body.include).toEqual(['author']);
      expect(body.filter.where).toEqual([{ field: 'name', operator: 'iContains', value: 'al' }]);
      expect(body.paginate).toEqual({ page: 1, size: 10 });
    });
  });
});
