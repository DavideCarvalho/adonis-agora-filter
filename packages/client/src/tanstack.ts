import type { ColumnFiltersState, PaginationState, SortingState } from '@tanstack/table-core';
import type { FilterQueryResult } from './filter-query-builder.js';
import { FilterQueryBuilder } from './filter-query-builder.js';
import type { FilterOperator } from './types.js';

/**
 * Resolves the @adonis-agora/filter operator for a vanilla TanStack column filter.
 *
 * Vanilla TanStack column filters are `{ id, value }` with **no operator** —
 * the operator lives in the column's `filterFn`. @adonis-agora/filter needs one, so
 * this is the seam: supply your own to read `column.meta`, map a symbol
 * vocabulary, etc.
 */
export type ResolveOperator = (columnId: string, value: unknown) => FilterOperator;

export interface TanstackTableStateOptions {
  /** Vanilla TanStack `ColumnFiltersState` — `{ id, value }[]`. */
  columnFilters?: ColumnFiltersState;
  /** Vanilla TanStack `SortingState` — `{ id, desc }[]`. */
  sorting?: SortingState;
  /** Vanilla TanStack `PaginationState` — `{ pageIndex (0-based), pageSize }`. */
  pagination?: PaginationState;
  /**
   * Maps each column filter to an operator. Defaults to: array → `in`,
   * string → `iContains` (mirrors TanStack's `auto` substring filtering),
   * everything else → `equals`.
   */
  resolveOperator?: ResolveOperator;
  /** Optional allowlist; filters/sorts whose column id isn't here are dropped. */
  fields?: Iterable<string>;
}

const defaultResolveOperator: ResolveOperator = (_columnId, value) => {
  if (Array.isArray(value)) return 'in';
  if (typeof value === 'string') return 'iContains';
  return 'equals';
};

/**
 * Applies vanilla TanStack Table state (column filters, sorting, pagination)
 * onto an existing `FilterQueryBuilder`, then returns the same builder so you
 * can chain `include`/`search`/extra `where` calls before `build()`.
 *
 * Framework-agnostic — works with any TanStack Table adapter (React, Vue,
 * Svelte, Solid). `@tanstack/table-core` is a types-only peer.
 *
 * @example
 * import { filterQuery } from '@adonis-agora/filter-client';
 * import { applyTanstackTableState } from '@adonis-agora/filter-client/tanstack';
 *
 * const body = applyTanstackTableState(filterQuery(), {
 *   columnFilters: table.getState().columnFilters,
 *   sorting: table.getState().sorting,
 *   pagination: table.getState().pagination,
 *   resolveOperator: (id) => (id === 'createdAt' ? 'gte' : 'iContains'),
 * })
 *   .include('author')
 *   .build();
 */
export function applyTanstackTableState(
  builder: FilterQueryBuilder,
  options: TanstackTableStateOptions = {},
): FilterQueryBuilder {
  const {
    columnFilters = [],
    sorting = [],
    pagination,
    resolveOperator = defaultResolveOperator,
    fields,
  } = options;
  const allowed = fields ? new Set(fields) : null;

  for (const { id, value } of columnFilters) {
    if (value === null || value === undefined || value === '') continue;
    if (allowed && !allowed.has(id)) continue;
    builder.where(id, resolveOperator(id, value), value);
  }

  for (const { id, desc } of sorting) {
    if (allowed && !allowed.has(id)) continue;
    builder.sort(id, desc ? 'desc' : 'asc');
  }

  if (pagination) {
    builder.page(pagination.pageIndex, pagination.pageSize);
  }

  return builder;
}

/**
 * One-shot convenience: builds a `FilterQueryResult` straight from vanilla
 * TanStack Table state. Equivalent to
 * `applyTanstackTableState(filterQuery(), options).build()`.
 */
export function tanstackTableToFilterQuery(
  options: TanstackTableStateOptions = {},
): FilterQueryResult {
  return applyTanstackTableState(new FilterQueryBuilder(), options).build();
}
