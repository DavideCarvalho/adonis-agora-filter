import type { ColumnFilter, FilterOperatorInput } from './operators.js';
import type { FilterInput, SortItem } from './types.js';

function toInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Map one `filter[field]=…` entry to `ColumnFilter[]` (Spatie/JSON:API shapes). */
export function toColumnFilters(field: string, value: unknown): ColumnFilter[] {
  // Array (`filter[id][]=1&filter[id][]=2`) → IN.
  if (Array.isArray(value)) {
    return [{ field, operator: 'in', value }];
  }
  // Operator object (`filter[age][gte]=18`) → one filter per operator key.
  if (value != null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([operator, opValue]) => ({
      field,
      operator: operator as FilterOperatorInput,
      value: opValue,
    }));
  }
  // Comma-separated scalar (Spatie multi-value convention) → IN.
  if (typeof value === 'string' && value.includes(',')) {
    return [
      {
        field,
        operator: 'in',
        value: value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      },
    ];
  }
  // Bare scalar → equals.
  return [{ field, operator: 'equals', value }];
}

/**
 * True when `value` is an already-structured `ColumnFilter[]` rather than the
 * `filter[field]=…` shape `toColumnFilters` reshapes.
 *
 * Two wire forms produce it. A POST body carrying the client builder's
 * `build()` output nests it under `filter.where`; a GET whose query string was
 * serialized from OR/AND groups decodes to the same array of
 * `{ field, operator, value }` records. Both used to fall through to the
 * scalar path, where an array becomes a single `in` filter on a field literally
 * named `where` — dropped by the allow-list, leaving the query unfiltered.
 *
 * A real column named `where` arrives as `filter[where]=x` (a string) or
 * `filter[where][gte]=1` (an operator object), so neither is mistaken for this.
 */
function isStructuredFilterList(value: unknown): value is ColumnFilter[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry != null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as ColumnFilter).field === 'string' &&
        typeof (entry as ColumnFilter).operator === 'string',
    )
  );
}

/**
 * Parse the `distinct` param into a de-duplicated list of field names. Accepts a
 * comma-separated string (`distinct=afsc,base`) or a repeated/array form
 * (`distinct[]=afsc&distinct[]=base`) — the shapes the client's `toQueryString()`
 * and structured `build()` emit. Non-string entries are ignored.
 */
export function parseDistinct(distinct: unknown): string[] {
  let raw: string[] = [];
  if (typeof distinct === 'string') raw = distinct.split(',');
  else if (Array.isArray(distinct))
    raw = distinct.filter((s): s is string => typeof s === 'string');

  const out: string[] = [];
  for (const entry of raw) {
    const field = entry.trim();
    if (field.length > 0 && !out.includes(field)) out.push(field);
  }
  return out;
}

/**
 * Parse the `sort` param into ordered {@link SortItem}s. Accepts the string form
 * (`-createdAt,name` or `sort[]=name`) and the already-structured
 * `[{ field, direction }]` form the client builder's `build()` emits — the
 * latter used to be filtered out entirely as "not a string", silently dropping
 * the ordering.
 */
export function parseSort(sort: unknown): SortItem[] {
  if (Array.isArray(sort) && sort.some((s) => s != null && typeof s === 'object')) {
    const items: SortItem[] = [];
    for (const entry of sort) {
      if (entry == null || typeof entry !== 'object') continue;
      const { field, direction } = entry as Partial<SortItem>;
      if (typeof field !== 'string' || field.length === 0) continue;
      items.push({ field, direction: direction === 'desc' ? 'desc' : 'asc' });
    }
    return items;
  }

  let raw: string[] = [];
  if (typeof sort === 'string') raw = sort.split(',');
  else if (Array.isArray(sort)) raw = sort.filter((s): s is string => typeof s === 'string');

  const items: SortItem[] = [];
  for (const entry of raw) {
    const field = entry.trim();
    if (field.length === 0) continue;
    if (field.startsWith('-')) items.push({ field: field.slice(1), direction: 'desc' });
    else items.push({ field, direction: 'asc' });
  }
  return items;
}

function parsePagination(qs: Record<string, unknown>): { page?: number; size?: number } {
  let page = toInt(qs.page);
  let size = toInt(qs.size);
  // JSON:API nested form: page[number] / page[size].
  if (qs.page != null && typeof qs.page === 'object' && !Array.isArray(qs.page)) {
    const p = qs.page as Record<string, unknown>;
    page = toInt(p.number) ?? page;
    size = toInt(p.size) ?? size;
  }
  // The client builder's `build()` nests the same two numbers under `paginate`,
  // which is what a POST search body carries.
  if (qs.paginate != null && typeof qs.paginate === 'object' && !Array.isArray(qs.paginate)) {
    const p = qs.paginate as Record<string, unknown>;
    page = toInt(p.page) ?? page;
    size = toInt(p.size) ?? size;
  }
  return { ...(page !== undefined && { page }), ...(size !== undefined && { size }) };
}

/**
 * Parse a decoded request query object — e.g. AdonisJS `ctx.request.qs()` — into
 * a structured {@link FilterInput}. Understands the Spatie / JSON:API shapes the
 * `@adonis-agora/filter-client` builder emits:
 *
 * - `filter[status]=active` → equals
 * - `filter[id]=1,2,3` / `filter[id][]=1&filter[id][]=2` → IN
 * - `filter[age][gte]=18` → operator filter
 * - `sort=-createdAt,name` → sort items
 * - `distinct=afsc,base` / `distinct[]=afsc&distinct[]=base` → distinct fields
 * - `search=term`, `page`/`size` (or `page[number]`/`page[size]`)
 *
 * It also accepts the structured shape the client builder's `build()` returns —
 * `{ filter: { where: [...] }, sort: [{ field, direction }], paginate: { page, size } }`
 * — so a POST search body can be handed straight in, and so OR/AND groups (which
 * serialize to a top-level `where[0][field]=…`) survive the round trip.
 * `include` is not consumed here: eager-loading is the caller's `preload` call.
 *
 * Pure reshape — no validation or allow-listing here; that happens in
 * {@link applyFilter} against the {@link FilterConfig}.
 */
export function parseFilterRequest(qs: Record<string, unknown>): FilterInput {
  const out: FilterInput = {};

  const filters: ColumnFilter[] = [];
  if (qs.filter != null && typeof qs.filter === 'object' && !Array.isArray(qs.filter)) {
    for (const [field, value] of Object.entries(qs.filter as Record<string, unknown>)) {
      if (field === 'where' && isStructuredFilterList(value)) {
        filters.push(...value);
        continue;
      }
      filters.push(...toColumnFilters(field, value));
    }
  }
  // OR/AND groups serialize to a top-level `where[0][field]=…`, with no `filter`
  // wrapper, so they decode beside `filter` rather than inside it.
  if (isStructuredFilterList(qs.where)) filters.push(...qs.where);
  if (filters.length > 0) out.filters = filters;

  const sort = parseSort(qs.sort);
  if (sort.length > 0) out.sort = sort;

  const distinct = parseDistinct(qs.distinct);
  if (distinct.length > 0) out.distinct = distinct;

  if (typeof qs.search === 'string' && qs.search.length > 0) out.search = qs.search;

  const { page, size } = parsePagination(qs);
  if (page !== undefined) out.page = page;
  if (size !== undefined) out.size = size;

  return out;
}
