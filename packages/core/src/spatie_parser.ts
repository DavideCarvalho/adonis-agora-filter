import type { CursorParams } from './cursor.js';
import type { ColumnFilter } from './operators.js';
import { parseDistinct, parseSort, toColumnFilters } from './parse_request.js';
import type { FilterInput } from './types.js';

/**
 * The richer Spatie / JSON:API input shape produced by {@link parseSpatieRequest}.
 * A superset of {@link FilterInput}: it adds cursor pagination
 * ({@link CursorParams}), JSON:API sparse fieldsets (`select`) and relation
 * includes (`include`). Ready to hand to `applyFilter` (offset) or `applyCursor`
 * (keyset) — the extra fields are ignored by whichever runner does not use them.
 */
export interface SpatieInput extends FilterInput, CursorParams {
  /** JSON:API sparse fieldsets (`fields[resource]=a,b`), flattened + de-duped. */
  select?: string[];
  /** Relation includes (`include=posts,comments`). */
  include?: string[];
}

function toInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Parse a decoded, Spatie-laravel-query-builder / JSON:API-style query object
 * into a {@link SpatieInput}. This is the richer, additive counterpart to
 * {@link parseFilterRequest}: it understands the same `filter`/`sort`/`search`
 * shapes plus JSON:API `include`, sparse `fields[resource]` sets, and cursor
 * pagination (`page[after]`/`page[before]`).
 *
 * | Query string                    | Decoded input                        | Mapped to                                  |
 * | ------------------------------- | ------------------------------------ | ------------------------------------------ |
 * | `filter[name]=Al`               | `{ filter: { name: 'Al' } }`         | `equals` column filter                     |
 * | `filter[id]=1,2,3`              | `{ filter: { id: '1,2,3' } }`        | `in` column filter                         |
 * | `filter[age][gte]=18`          | `{ filter: { age: { gte: '18' } } }` | operator column filter                     |
 * | `sort=-createdAt,name`         | `{ sort: '-createdAt,name' }`        | sort items                                 |
 * | `distinct=city,tier`           | `{ distinct: 'city,tier' }`          | `distinct: ['city', 'tier']`               |
 * | `include=posts,comments`       | `{ include: 'posts,comments' }`      | `include: ['posts', 'comments']`           |
 * | `fields[users]=id,name`        | `{ fields: { users: 'id,name' } }`   | `select: ['id', 'name']`                   |
 * | `page[number]=2&page[size]=10` | `{ page: { number, size } }`         | offset (`page`/`size`)                     |
 * | `page[after]=cur&page[size]=10`| `{ page: { after, size } }`          | cursor (`after`/`first`)                   |
 *
 * A pure reshape — no validation or allow-listing here; that happens downstream
 * in `applyFilter` / `applyCursor` against the `FilterConfig`.
 */
export function parseSpatieRequest(qs: unknown): SpatieInput {
  if (qs == null || typeof qs !== 'object') return {};
  const src = qs as Record<string, unknown>;
  const out: SpatieInput = {};

  if (src.filter != null && typeof src.filter === 'object' && !Array.isArray(src.filter)) {
    const filters: ColumnFilter[] = [];
    for (const [field, value] of Object.entries(src.filter as Record<string, unknown>)) {
      filters.push(...toColumnFilters(field, value));
    }
    if (filters.length > 0) out.filters = filters;
  }

  const sort = parseSort(src.sort);
  if (sort.length > 0) out.sort = sort;

  const distinct = parseDistinct(src.distinct);
  if (distinct.length > 0) out.distinct = distinct;

  if (typeof src.search === 'string' && src.search.length > 0) out.search = src.search;

  const include = parseInclude(src.include);
  if (include.length > 0) out.include = include;

  const select = parseSparseFieldsets(src.fields);
  if (select.length > 0) out.select = select;

  applyPage(src.page, out);

  return out;
}

/** Parse `include=posts,comments` (string or array) into a relation-name list. */
function parseInclude(include: unknown): string[] {
  if (typeof include === 'string') {
    return include
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(include)) {
    return include.filter((s): s is string => typeof s === 'string' && s.length > 0);
  }
  return [];
}

/**
 * Flatten JSON:API sparse fieldsets (`fields[resource]=a,b`) into a single
 * order-preserving, de-duplicated list of column names. Per-resource keys are
 * collapsed because a single SELECT applies to the primary entity.
 */
function parseSparseFieldsets(fields: unknown): string[] {
  if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of Object.values(fields as Record<string, unknown>)) {
    const cols =
      typeof value === 'string'
        ? value.split(',')
        : Array.isArray(value)
          ? value.filter((s): s is string => typeof s === 'string')
          : [];
    for (const raw of cols) {
      const col = raw.trim();
      if (col.length > 0 && !seen.has(col)) {
        seen.add(col);
        out.push(col);
      }
    }
  }
  return out;
}

/**
 * Map a JSON:API `page` object onto `out`: `page[after]`/`page[before]` →
 * cursor (`after`/`first`, `before`/`last`); otherwise `page[number]`/`page[size]`
 * → offset (`page`/`size`). `after` wins if both cursor bounds are present.
 */
function applyPage(page: unknown, out: SpatieInput): void {
  if (page == null || typeof page !== 'object' || Array.isArray(page)) return;
  const p = page as Record<string, unknown>;

  const after = typeof p.after === 'string' ? p.after : undefined;
  const before = typeof p.before === 'string' ? p.before : undefined;
  const size = toInt(p.size);

  if (after !== undefined || before !== undefined) {
    if (after !== undefined) {
      out.after = after;
      if (size !== undefined) out.first = size;
    } else if (before !== undefined) {
      out.before = before;
      if (size !== undefined) out.last = size;
    }
    return;
  }

  const number = toInt(p.number);
  if (number !== undefined) out.page = number;
  if (size !== undefined) out.size = size;
}
