/**
 * Pure, ORM-agnostic parser for to-many aggregate field paths — a verbatim port
 * of the NestJS `nestjs-filter` `aggregate/aggregate-path.ts` (commit 3f21e1f).
 * It only parses the client-facing field *string* into a structured
 * {@link AggregatePath}; turning that into SQL (a correlated subquery) is the
 * Lucid-specific compiler's job (see `filter_spec.ts` aggregate discovery).
 */

export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export interface AggregatePath {
  relation: string;
  fn: AggregateFn;
  column?: string;
}

const COLUMN_FNS = new Set<AggregateFn>(['sum', 'avg', 'min', 'max']);

/**
 * Parses a to-many aggregate field path.
 *
 * Grammar (single relation hop only):
 * - `<relation>.$count`              → { relation, fn: 'count' }
 * - `<relation>.$<fn>.<childColumn>` → { relation, fn, column } for fn in sum|avg|min|max
 *
 * Returns `null` for anything else so callers can fall through to
 * non-aggregate field handling instead of throwing.
 */
export function parseAggregatePath(path: string): AggregatePath | null {
  const parts = path.split('.');
  // <rel>.$<fn>            → 2 parts, $count
  // <rel>.$<fn>.<col>      → 3 parts, column fns
  if (parts.length < 2 || parts.length > 3) return null;
  const [relation, token, column] = parts;
  if (!relation || !token?.startsWith('$')) return null;
  const fn = token.slice(1) as AggregateFn;
  if (fn === 'count') return parts.length === 2 ? { relation, fn } : null;
  if (COLUMN_FNS.has(fn)) return parts.length === 3 && column ? { relation, fn, column } : null;
  return null;
}
