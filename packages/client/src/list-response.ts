/**
 * Response shapes of an `@adonis-agora/filter` HTTP list endpoint. Re-declared here (not imported
 * from the server package) to keep this package zero-dependency; they match the server's
 * `offsetPage` / `cursorPage` output exactly.
 */

/** The `meta` of an offset page — a serialized Lucid paginator (camelCase). */
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
