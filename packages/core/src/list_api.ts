import type { CursorPage, CursorParams } from './cursor.js';
import { parseSort } from './parse_request.js';
import type { SortItem } from './types.js';
import { InvalidColumnFilterError } from './validate-column-filter.js';

// ─── Response envelopes ─────────────────────────────────────────────────────

/** The `meta` of an offset page — the fields of a serialized Lucid paginator (camelCase). */
export interface OffsetPageMeta {
  total: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  firstPage: number;
}

/** An offset-paged list response: `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }`. */
export interface OffsetPage<T> {
  data: T[];
  meta: OffsetPageMeta;
}

/** The `meta` of a cursor page. A cursor is `null` when there is no page in that direction. */
export interface CursorPageMeta {
  nextCursor: string | null;
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

/** A cursor-paged list response: `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. */
export interface CursorPageResponse<T> {
  data: T[];
  meta: CursorPageMeta;
}

/** What {@link offsetPage} needs besides the rows. */
export interface OffsetPageInit {
  /** Number of rows matching the request across every page. */
  total: number;
  /** The 1-based page these rows are. */
  page: number;
  /** The page size the rows were fetched with. */
  size: number;
}

/**
 * What {@link cursorPage} needs besides the rows. `hasNext` / `hasPrev` default to whether the
 * matching cursor is present.
 */
export interface CursorPageInit {
  nextCursor?: string | null | undefined;
  prevCursor?: string | null | undefined;
  hasNext?: boolean | undefined;
  hasPrev?: boolean | undefined;
}

const toCount = (n: number, min: number): number =>
  Number.isFinite(n) ? Math.max(min, Math.floor(n)) : min;

/**
 * Wraps one page of rows in the offset list envelope.
 *
 * ```ts
 * const { page, size } = parsePageParams(request.qs(), { defaultSize: 50, maxSize: 200 })
 * const { rows, total } = await store.list(draft, { offset: (page - 1) * size, limit: size })
 * return offsetPage(rows, { total, page, size })
 * ```
 */
export function offsetPage<T>(data: T[], init: OffsetPageInit): OffsetPage<T> {
  const total = toCount(init.total, 0);
  const perPage = toCount(init.size, 1);
  return {
    data,
    meta: {
      total,
      perPage,
      currentPage: toCount(init.page, 1),
      lastPage: Math.max(1, Math.ceil(total / perPage)),
      firstPage: 1,
    },
  };
}

/**
 * Wraps one page of rows in the cursor list envelope. Two forms:
 *
 * - `cursorPage(rows, { nextCursor, prevCursor, hasNext, hasPrev })` — for a store that produces
 *   its own cursors.
 * - `cursorPage(page, map?)` — from the {@link CursorPage} `buildCursorPage` (or `filterInMemory…`)
 *   returns, optionally mapping each item (e.g. to serialize it).
 */
export function cursorPage<T>(data: T[], init: CursorPageInit): CursorPageResponse<T>;
export function cursorPage<T, U = T>(
  page: CursorPage<T>,
  map?: (item: T, index: number) => U,
): CursorPageResponse<U>;
export function cursorPage<T, U = T>(
  dataOrPage: T[] | CursorPage<T>,
  initOrMap?: CursorPageInit | ((item: T, index: number) => U),
): CursorPageResponse<T> | CursorPageResponse<U> {
  if (Array.isArray(dataOrPage)) {
    const init = (initOrMap ?? {}) as CursorPageInit;
    const nextCursor = init.nextCursor ?? null;
    const prevCursor = init.prevCursor ?? null;
    return {
      data: dataOrPage,
      meta: {
        nextCursor,
        prevCursor,
        hasNext: init.hasNext ?? nextCursor !== null,
        hasPrev: init.hasPrev ?? prevCursor !== null,
      },
    };
  }
  const page = dataOrPage;
  const map = typeof initOrMap === 'function' ? initOrMap : undefined;
  return {
    data: map ? page.items.map(map) : (page.items as unknown as U[]),
    meta: {
      nextCursor: page.nextCursor,
      prevCursor: page.prevCursor,
      hasNext: page.hasNext,
      hasPrev: page.hasPrev,
    },
  };
}

// ─── Request params ─────────────────────────────────────────────────────────

/** Size policy shared by {@link parsePageParams} and {@link parseCursorParams}. */
export interface PageSizeOptions {
  /** Size used when the request sends none (or junk). Default `25`, capped at `maxSize`. */
  defaultSize?: number;
  /** Largest size a request may ask for; bigger values are clamped down. Default `100`. */
  maxSize?: number;
}

/** Offset paging params resolved by {@link parsePageParams}. `page` is 1-based. */
export interface PageParams {
  page: number;
  size: number;
}

/** Cursor paging params resolved by {@link parseCursorParams}. */
export interface ParsedCursorParams {
  /** Return the page after this cursor (forward). Wins over `before` when both are sent. */
  after?: string;
  /** Return the page before this cursor (backward). */
  before?: string;
  /** Page size: `first` going forward, `last` going backward, clamped to `[1, maxSize]`. */
  size: number;
  /** True when paging backward (`before` given without `after`). */
  backward: boolean;
}

/** A positive-or-zero integer read from a query value, or `undefined` for anything else. */
function toInt(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function resolveSizePolicy(options: PageSizeOptions): { defaultSize: number; maxSize: number } {
  const maxSize = Math.max(1, Math.floor(options.maxSize ?? 100));
  const defaultSize = Math.min(maxSize, Math.max(1, Math.floor(options.defaultSize ?? 25)));
  return { defaultSize, maxSize };
}

function clampSize(
  requested: number | undefined,
  policy: { defaultSize: number; maxSize: number },
) {
  if (requested === undefined) return policy.defaultSize;
  return Math.min(policy.maxSize, Math.max(1, requested));
}

/**
 * Reads offset paging params (`page`, `size`) from a decoded query string. `page` is 1-based;
 * missing or non-numeric values fall back to page 1 / `defaultSize`, and out-of-range values are
 * clamped (`page` to at least 1, `size` to `[1, maxSize]`).
 *
 * ```ts
 * const { page, size } = parsePageParams(request.qs(), { defaultSize: 50, maxSize: 200 })
 * ```
 */
export function parsePageParams(
  qs: Record<string, unknown>,
  options: PageSizeOptions = {},
): PageParams {
  const policy = resolveSizePolicy(options);
  const page = toInt(qs.page);
  return {
    page: page === undefined ? 1 : Math.max(1, page),
    size: clampSize(toInt(qs.size), policy),
  };
}

/**
 * Reads the raw cursor params (`after` / `before` / `first` / `last`, or the JSON:API
 * `page[after]` … shapes) from a decoded query string, without applying a size policy. `after`
 * wins over `before`. This is the shape `applyCursor` takes.
 */
export function readCursorParams(qs: Record<string, unknown>): CursorParams {
  const out: CursorParams = {};
  const page =
    qs.page != null && typeof qs.page === 'object' && !Array.isArray(qs.page)
      ? (qs.page as Record<string, unknown>)
      : undefined;

  const after = qs.after ?? page?.after;
  const before = qs.before ?? page?.before;
  if (typeof after === 'string' && after.length > 0) out.after = after;
  else if (typeof before === 'string' && before.length > 0) out.before = before;

  const first = toInt(qs.first ?? page?.first);
  const last = toInt(qs.last ?? page?.last);
  if (first !== undefined) out.first = first;
  if (last !== undefined) out.last = last;

  return out;
}

/**
 * Reads cursor paging params from a decoded query string: `after` / `before` (opaque cursors) and
 * `first` / `last` (sizes). `after` wins when both cursors are sent. The size is `first` going
 * forward and `last` going backward — when only the other one is sent it is used instead — clamped
 * to `[1, maxSize]`, `defaultSize` when absent or junk.
 *
 * ```ts
 * const { after, before, size, backward } = parseCursorParams(request.qs(), { defaultSize: 50 })
 * ```
 */
export function parseCursorParams(
  qs: Record<string, unknown>,
  options: PageSizeOptions = {},
): ParsedCursorParams {
  const policy = resolveSizePolicy(options);
  const raw = readCursorParams(qs);
  const backward = raw.before !== undefined;
  const requested = backward ? (raw.last ?? raw.first) : (raw.first ?? raw.last);
  return {
    ...(raw.after !== undefined && { after: raw.after }),
    ...(raw.before !== undefined && { before: raw.before }),
    size: clampSize(requested, policy),
    backward,
  };
}

// ─── Sort ───────────────────────────────────────────────────────────────────

/** A sort directive whose field is one of the endpoint's sortable fields. */
export interface ResolvedSortItem<F extends string = string> {
  field: F;
  direction: 'asc' | 'desc';
}

/** Options for {@link resolveSort}. */
export interface ResolveSortOptions<F extends string> {
  /** The fields this endpoint can sort by. Anything else is rejected. */
  sortable: readonly F[];
  /** The order used when the request sends no sort: `'-createdAt'` or sort items. Default none. */
  default?: string | readonly ResolvedSortItem<F>[];
}

/**
 * Checks a request's sort against the endpoint's sortable allow-list. Accepts the parsed
 * `input.sort` (from `parseFilterRequest`) or the raw `sort` query value (`'-createdAt,name'`).
 * Returns the default order when the request has no sort, and throws
 * {@link InvalidColumnFilterError} (map it to a 400) for a field outside `sortable`.
 *
 * ```ts
 * const sort = resolveSort(input.sort, { sortable: ['createdAt', 'name'], default: '-createdAt' })
 * ```
 */
export function resolveSort<F extends string>(
  sort: readonly SortItem[] | string | readonly string[] | null | undefined,
  options: ResolveSortOptions<F>,
): ResolvedSortItem<F>[] {
  const items = parseSort(sort);
  if (items.length === 0) {
    const fallback = options.default;
    if (fallback === undefined) return [];
    return typeof fallback === 'string'
      ? (parseSort(fallback) as ResolvedSortItem<F>[])
      : fallback.map((s) => ({ field: s.field, direction: s.direction }));
  }
  const allowed = new Set<string>(options.sortable);
  for (const item of items) {
    if (!allowed.has(item.field)) {
      const list = options.sortable.length > 0 ? options.sortable.join(', ') : '(none)';
      throw new InvalidColumnFilterError(
        `Unknown sort field: "${item.field}". Sortable fields: ${list}.`,
      );
    }
  }
  return items as ResolvedSortItem<F>[];
}
