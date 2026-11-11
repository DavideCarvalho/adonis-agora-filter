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
  /**
   * Vanilla TanStack `PaginationState` — `{ pageIndex (0-based), pageSize }`. It is sent as the
   * server's 1-based `page`: `pageIndex: 0` requests `page=1`.
   */
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
    builder.page(pagination.pageIndex + 1, pagination.pageSize);
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

/**
 * The pagination meta of a paginated listing, as Lucid serializes it. Both the default camelCase
 * keys and the snake_case ones (a model with a snake_case naming strategy) are read.
 */
export interface PaginationMeta {
  currentPage?: number;
  current_page?: number;
  perPage?: number;
  per_page?: number;
  lastPage?: number;
  last_page?: number;
  total?: number;
}

/** TanStack pagination state derived from a server response. */
export interface TanstackPaginationFromMeta {
  /** `{ pageIndex (0-based), pageSize }`, ready for `table.setPagination` / `state.pagination`. */
  pagination: PaginationState;
  /** Total number of pages, for `pageCount` with `manualPagination: true`. */
  pageCount: number;
  /** Total number of rows, for `rowCount`. */
  rowCount: number;
}

/**
 * Maps the `meta` of a paginated response (`page` is 1-based on the server) back to TanStack's
 * 0-based `pageIndex`: `currentPage: 1` becomes `pageIndex: 0`.
 *
 * @example
 * const { data, meta } = await fetch(`/users?${qs}`).then((r) => r.json());
 * const { pagination, pageCount, rowCount } = tanstackPaginationFromMeta(meta);
 */
export function tanstackPaginationFromMeta(meta: PaginationMeta): TanstackPaginationFromMeta {
  const currentPage = meta.currentPage ?? meta.current_page ?? 1;
  const perPage = meta.perPage ?? meta.per_page ?? 0;
  const lastPage = meta.lastPage ?? meta.last_page ?? 1;
  return {
    pagination: { pageIndex: Math.max(0, currentPage - 1), pageSize: perPage },
    pageCount: lastPage,
    rowCount: meta.total ?? 0,
  };
}
