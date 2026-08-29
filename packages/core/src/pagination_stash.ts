import type { ResolvedPagination } from './runner.js';

/**
 * Where a filtered query remembers the pagination the request resolved to.
 *
 * The builder is handed back to the caller so the endpoint can keep composing on it; the page and
 * size it already resolved ride along on this symbol, so a later `filterPaginate()` needs no
 * arguments and no second read of the request.
 */
const PAGINATION = Symbol.for('@adonis-agora/filter:pagination');

export function stashPagination(query: unknown, pagination: ResolvedPagination): void {
  if (query !== null && typeof query === 'object') {
    (query as Record<symbol, unknown>)[PAGINATION] = pagination;
  }
}

export function readPagination(query: unknown): ResolvedPagination | undefined {
  if (query === null || typeof query !== 'object') return undefined;
  return (query as Record<symbol, ResolvedPagination | undefined>)[PAGINATION];
}
