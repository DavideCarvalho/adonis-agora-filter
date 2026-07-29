import { coerceFilterValue } from './coerce_value.js';
import {
  type CursorParams,
  type ResolvedCursor,
  buildKeyset,
  decodeCursor,
  reverseKeyset,
} from './cursor.js';
import {
  remapDistinctAliases,
  remapFilterAliases,
  remapSortAliases,
  resolveFieldAlias,
} from './field_aliases.js';
import {
  type QueryBuilderLike,
  applyColumnFilters,
  applyComputedField,
  applyComputedSort,
  applyDistinct,
  applyFullTextSearch,
  applyKeyset,
  applySearch,
  applySort,
  applyVectorSimilarity,
  resolveComputedExpression,
} from './lucid_adapter.js';
import type { ColumnFilter } from './operators.js';
import type { ComputedFields, FilterConfig, FilterInput, SortItem } from './types.js';
import type { AllowList } from './types.js';
import { InvalidColumnFilterError, validateColumnFilters } from './validate-column-filter.js';

/** The resolved offset pagination to hand to Lucid's `query.paginate(page, size)`. */
export interface ResolvedPagination {
  page: number;
  size: number;
}

function isAllowed(field: string, allow: AllowList): boolean {
  if (allow === '*') return true;
  if (typeof allow === 'function') return allow(field);
  return allow.includes(field);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Own-property lookup of a declared computed field. A client-supplied field name
 * is never trusted as a bare map key (prototype-pollution guard) — only an
 * OWN, non-inherited key resolves to a computed source.
 */
function computedKey(computed: ComputedFields | undefined, field: string): boolean {
  return (
    computed !== undefined &&
    typeof field === 'string' &&
    field.length > 0 &&
    Object.hasOwn(computed, field)
  );
}

/**
 * A top-level filter that targets a declared computed field: a leaf (has a
 * field, no AND/OR children) whose name is an own key of the computed map.
 * Computed fields are only recognised at the top level of `input.filters` — the
 * shape the client emits — never nested inside a boolean group.
 */
function isComputedLeaf(filter: ColumnFilter, computed: ComputedFields | undefined): boolean {
  return computedKey(computed, filter.field) && filter.AND === undefined && filter.OR === undefined;
}

/**
 * Operators whose value is a LIKE pattern rather than a column-typed value. Their argument stays a
 * string no matter what kind the column is declared as — coercing `contains: '3'` on a numeric
 * column to the number `3` would destroy the pattern the caller asked for.
 */
const PATTERN_OPERATORS = new Set([
  'contains',
  'notContains',
  'iContains',
  'startsWith',
  'endsWith',
]);

/** Operators whose value is a list/tuple — each element is coerced independently. */
const ARRAY_OPERATORS = new Set(['in', 'notIn', 'isAnyOf', 'between', 'notBetween']);

/**
 * Coerce one leaf's value against its declared column kind. Returns `ok` unchanged when the field
 * has no declared type (backwards compatible), when the operator carries a LIKE pattern, or when
 * the kind has no contract to enforce. An array-valued operator fails as a whole if ANY element
 * fails — a partially-coerced list would silently filter on something the client never asked for.
 */
function coerceFilterForField(
  filter: ColumnFilter,
  fieldTypes: FilterConfig['fieldTypes'],
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const kind = fieldTypes?.[filter.field]?.kind;
  if (!kind || PATTERN_OPERATORS.has(String(filter.operator))) {
    return { ok: true, value: filter.value };
  }

  if (ARRAY_OPERATORS.has(String(filter.operator)) && Array.isArray(filter.value)) {
    const out: unknown[] = [];
    for (const element of filter.value) {
      const r = coerceFilterValue(element, kind);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }

  return coerceFilterValue(filter.value, kind);
}

/**
 * Recursively prune a filter against the allow-list. A leaf on a disallowed field
 * is dropped (or throws when `throwOnInvalid`). Group nodes keep only their
 * surviving children; a group left empty is itself dropped (returns `null`).
 */
function prune(
  filter: ColumnFilter,
  allowed: AllowList,
  throwOnInvalid: boolean,
  fieldTypes?: FilterConfig['fieldTypes'],
): ColumnFilter | null {
  const hasField = typeof filter.field === 'string' && filter.field.length > 0;

  if (hasField && !isAllowed(filter.field, allowed)) {
    if (throwOnInvalid) {
      throw new InvalidColumnFilterError(`Field "${filter.field}" is not filterable.`);
    }
    return null;
  }

  const next: ColumnFilter = { field: filter.field, operator: filter.operator };
  if (filter.value !== undefined) {
    // The field passed the allow-list; now guard the VALUE. An uncoercible value is treated
    // exactly like a disallowed field (drop, or throw under `throwOnInvalid`) rather than being
    // handed to the driver, where Postgres would reject it as a 500 from user input.
    const coerced = coerceFilterForField(filter, fieldTypes);
    if (!coerced.ok) {
      if (throwOnInvalid) {
        throw new InvalidColumnFilterError(
          `Value for field "${filter.field}" is invalid: ${coerced.reason}.`,
        );
      }
      return null;
    }
    next.value = coerced.value;
  }

  if (filter.AND) {
    const kept = filter.AND.map((f) => prune(f, allowed, throwOnInvalid, fieldTypes)).filter(
      (f): f is ColumnFilter => f !== null,
    );
    if (kept.length > 0) next.AND = kept;
  }
  if (filter.OR) {
    const kept = filter.OR.map((f) => prune(f, allowed, throwOnInvalid, fieldTypes)).filter(
      (f): f is ColumnFilter => f !== null,
    );
    if (kept.length > 0) next.OR = kept;
  }

  // A pure group node (no field of its own) with no surviving children is empty.
  if (!hasField && next.AND === undefined && next.OR === undefined) {
    return null;
  }
  return next;
}

/**
 * Resolve aliases, structurally validate, and prune `input.filters`/`input.search`
 * against the allow-lists, applying the survivors to the builder. Shared by both
 * {@link applyFilter} (offset) and {@link applyCursor} (keyset) so the security
 * boundary is identical for either pagination style.
 */
function applyFilterConditions(
  qb: QueryBuilderLike,
  input: FilterInput,
  config: FilterConfig,
): void {
  const throwOnInvalid = config.throwOnInvalid ?? false;

  if (input.filters && input.filters.length > 0) {
    // Computed fields are a separate namespace from real columns: a top-level
    // leaf on a declared computed key is routed to the computed hook (its
    // declaration IS its allow-list) and NEVER run through the column
    // alias/validate/allow-list path below. Everything else is a normal column
    // filter. Checked before alias resolution so a computed key is not remapped.
    const columnFilters: ColumnFilter[] = [];
    for (const filter of input.filters) {
      if (isComputedLeaf(filter, config.computed)) {
        const expression = resolveComputedExpression(
          config.computed?.[filter.field] as NonNullable<ComputedFields[string]>,
          config.table ?? '',
        );
        applyComputedField(qb, expression, filter);
      } else {
        columnFilters.push(filter);
      }
    }

    if (columnFilters.length > 0) {
      // Alias resolution runs FIRST — the allow-list, validation and query builder
      // all see the resolved target column, never the client-facing alias key.
      const aliased = config.aliases
        ? columnFilters.map((f) =>
            remapFilterAliases(f, config.aliases as NonNullable<typeof config.aliases>),
          )
        : columnFilters;
      // Structural validation next (operator/value shape, depth, field charset).
      validateColumnFilters(aliased);
      const safe = aliased
        .map((f) => prune(f, config.allowed, throwOnInvalid, config.fieldTypes))
        .filter((f): f is ColumnFilter => f !== null);
      if (safe.length > 0) {
        applyColumnFilters(qb, safe);
      }
    }
  }

  if (input.search) {
    const term = input.search.trim();
    if (term.length > 0) {
      // tsvector full-text search is the primary path when the policy declares
      // it; otherwise fall back to the portable ILIKE scan across `searchable`.
      if (config.fullText) {
        applyFullTextSearch(qb, {
          query: term,
          column: config.fullText.column,
          ...(config.fullText.language !== undefined && { language: config.fullText.language }),
          ...(config.fullText.rank !== undefined && { rank: config.fullText.rank }),
          ...(config.fullText.columnKind !== undefined && {
            columnKind: config.fullText.columnKind,
          }),
        });
      } else if (config.searchable && config.searchable.length > 0) {
        applySearch(qb, term, config.searchable);
      }
    }
  }
}

/**
 * Is this (alias-resolved) field projectable in the outer SELECT?
 *
 * A `where` on a relation path is translated by `applyLeaf` into a nested Lucid
 * `whereHas`, which compiles to a **correlated EXISTS subquery** — the relation
 * is never added to the outer `FROM`. A projection has no such escape hatch: the
 * outer SELECT can only name a column of something the outer FROM holds. So
 * `distinct=posts.title` on a spec that (correctly) whitelists `posts.title` for
 * filtering would emit `select distinct "posts"."title" from "users"` and
 * Postgres answers `missing FROM-clause entry for table "posts"` — a 500 driven
 * by user input.
 *
 * The one qualifier that IS in the outer FROM is the root table itself (Lucid
 * gives the main table no generated alias, so the table name is the alias — the
 * same fact {@link FilterConfig.table} already encodes for computed fields).
 * A single-segment name is a plain root column and always projectable.
 */
function isProjectable(field: string, config: FilterConfig): boolean {
  const dot = field.indexOf('.');
  if (dot === -1) return true;
  return config.table !== undefined && field.slice(0, dot) === config.table;
}

/**
 * Resolve the alias-mapped, allow-listed distinct fields for the request. A
 * distinct field is a projected column, so it is gated by the SAME `allowed`
 * boundary a `where` field is — aliases resolve first, then the allow-list;
 * unknown fields are dropped (or rejected under `throwOnInvalid`).
 *
 * A field that clears the allow-list but is not projectable
 * ({@link isProjectable}) is dropped/rejected too, with its OWN message: it is
 * not an allow-list problem, so pointing the reader at `allowed` would send them
 * to edit the wrong thing.
 */
function resolveSafeDistinct(fields: string[], config: FilterConfig): string[] {
  const throwOnInvalid = config.throwOnInvalid ?? false;
  const aliased = config.aliases
    ? remapDistinctAliases(fields, config.aliases as NonNullable<typeof config.aliases>)
    : fields;

  const safe: string[] = [];
  for (const field of aliased) {
    if (!isAllowed(field, config.allowed)) {
      if (throwOnInvalid) {
        throw new InvalidColumnFilterError(`Field "${field}" is not a distinct-able column.`);
      }
      continue;
    }
    if (!isProjectable(field, config)) {
      if (throwOnInvalid) {
        const relation = field.slice(0, field.indexOf('.'));
        throw new InvalidColumnFilterError(
          `Field "${field}" cannot be used for distinct: it is a relation path, and a relation is filtered through a correlated EXISTS subquery, never joined into the query's FROM — so there is no "${relation}" table whose column the SELECT could project. This is NOT an allow-list problem: filtering on "${field}" works, projecting it does not, and adding it to \`allowed\` will not change that. Use a column of the root table for distinct.`,
        );
      }
      continue;
    }
    if (!safe.includes(field)) safe.push(field);
  }
  return safe;
}

/**
 * Apply the request's sort directives in order, routing each to the right hook:
 * a declared computed field goes to `applyComputedSort` (an appended
 * `orderByRaw`), a real column goes through alias resolution + the `sortable`
 * allow-list to `applySort` (an appended `orderBy`). Both hooks append, so a
 * computed sort and a real-column sort compose in request order — a client can
 * sort by `fullName` then `id` and get exactly that ORDER BY sequence.
 */
function applySortsWithComputed(
  qb: QueryBuilderLike,
  sort: SortItem[],
  config: FilterConfig,
): void {
  const throwOnInvalid = config.throwOnInvalid ?? false;
  const sortable = config.sortable ?? config.allowed;
  for (const item of sort) {
    if (computedKey(config.computed, item.field)) {
      const expression = resolveComputedExpression(
        config.computed?.[item.field] as NonNullable<ComputedFields[string]>,
        config.table ?? '',
      );
      applyComputedSort(qb, expression, item.direction);
      continue;
    }
    const field = config.aliases
      ? resolveFieldAlias(config.aliases as NonNullable<typeof config.aliases>, item.field)
      : item.field;
    if (isAllowed(field, sortable)) {
      applySort(qb, [{ field, direction: item.direction }]);
    } else if (throwOnInvalid) {
      throw new InvalidColumnFilterError(`Field "${item.field}" is not sortable.`);
    }
  }
}

/** Resolve the alias-mapped, allow-listed sort directives for the request. */
function resolveSafeSort(sort: SortItem[], config: FilterConfig): SortItem[] {
  const throwOnInvalid = config.throwOnInvalid ?? false;
  const sortable = config.sortable ?? config.allowed;
  const aliased = config.aliases
    ? remapSortAliases(sort, config.aliases as NonNullable<typeof config.aliases>)
    : sort;

  const safe: SortItem[] = [];
  for (const item of aliased) {
    if (isAllowed(item.field, sortable)) {
      safe.push(item);
    } else if (throwOnInvalid) {
      throw new InvalidColumnFilterError(`Field "${item.field}" is not sortable.`);
    }
  }
  return safe;
}

/**
 * Apply a parsed {@link FilterInput} to a Lucid query builder under a
 * {@link FilterConfig} policy, and return the resolved offset pagination.
 *
 * The allow-lists are the security boundary — fields not in `allowed`/`sortable`/
 * `searchable` are dropped (or rejected with `throwOnInvalid`). Pagination is
 * returned (not applied) so the caller drives Lucid's `query.paginate()`:
 *
 * ```ts
 * const { page, size } = applyFilter(Users.query(), input, { allowed: ['name', 'age'] })
 * const result = await Users.query()... // or: await query.paginate(page, size)
 * ```
 */
export function applyFilter(
  qb: QueryBuilderLike,
  input: FilterInput,
  config: FilterConfig,
): ResolvedPagination {
  applyFilterConditions(qb, input, config);

  // Embedding-similarity ranking (opt-in, additive): only when the policy declares
  // a similarity column AND the request carries a query embedding. Applied before
  // the user sort so nearest-first distance is the primary ordering; any allowed
  // sort then acts as a tiebreaker.
  if (config.vectorSimilarity && input.vectorSimilarity && input.vectorSimilarity.length > 0) {
    applyVectorSimilarity(qb, {
      column: config.vectorSimilarity.column,
      vector: input.vectorSimilarity,
      ...(config.vectorSimilarity.metric !== undefined && {
        metric: config.vectorSimilarity.metric,
      }),
      ...(config.vectorSimilarity.threshold !== undefined && {
        threshold: config.vectorSimilarity.threshold,
      }),
      ...(config.vectorSimilarity.topK !== undefined && { topK: config.vectorSimilarity.topK }),
    });
  }

  if (input.sort && input.sort.length > 0) {
    applySortsWithComputed(qb, input.sort, config);
  }

  if (input.distinct && input.distinct.length > 0) {
    const safeDistinct = resolveSafeDistinct(input.distinct, config);
    if (safeDistinct.length > 0) {
      applyDistinct(qb, safeDistinct);
    }
  }

  const size = clamp(input.size ?? config.defaultSize ?? 25, 1, config.maxSize ?? 100);
  const page = Math.max(1, input.page ?? 1);
  return { page, size };
}

/** Per-call policy for {@link applyCursor} — a {@link FilterConfig} plus the keyset tiebreaker. */
export interface CursorConfig extends FilterConfig {
  /** Primary-key column appended to the keyset as a stable tiebreaker. Default `'id'`. */
  primaryKey?: string;
}

/**
 * Apply a parsed {@link FilterInput} plus {@link CursorParams} to a Lucid query
 * builder as a **keyset (cursor) page** under a {@link CursorConfig} policy.
 *
 * Filters/search go through the same allow-list boundary as {@link applyFilter}.
 * The effective (allow-listed) sort, plus the primary-key tiebreaker, forms the
 * keyset; a supplied `after`/`before` cursor becomes a row-value seek predicate,
 * and the builder is ordered + limited to `size + 1` (one extra row to detect a
 * further page). Feed the fetched rows and the returned {@link ResolvedCursor}
 * to {@link buildCursorPage} to assemble the page and its boundary cursors:
 *
 * ```ts
 * const resolved = applyCursor(Users.query(), input, { allowed: ['name'], primaryKey: 'id' })
 * const rows = await Users.query()...exec()
 * const page = buildCursorPage(rows, resolved)
 * ```
 */
export function applyCursor(
  qb: QueryBuilderLike,
  input: FilterInput & CursorParams,
  config: CursorConfig,
): ResolvedCursor {
  applyFilterConditions(qb, input, config);

  const safeSort = input.sort && input.sort.length > 0 ? resolveSafeSort(input.sort, config) : [];
  const baseKeyset = buildKeyset(safeSort, config.primaryKey ?? 'id');

  const backward = input.before !== undefined && input.after === undefined;
  const cursorStr = input.after ?? input.before;
  const requested = backward ? input.last : input.first;
  const size = clamp(requested ?? config.defaultSize ?? 25, 1, config.maxSize ?? 100);

  // For backward paging, reverse keyset directions so the boundary seek and
  // ordering walk the other way; buildCursorPage re-reverses the rows.
  const queryKeyset = backward ? reverseKeyset(baseKeyset) : baseKeyset;

  if (cursorStr !== undefined) {
    const values = decodeCursor(cursorStr);
    if (values && values.length === queryKeyset.length) {
      applyKeyset(qb, queryKeyset, values);
    }
  }

  applySort(qb, queryKeyset);
  qb.limit(size + 1);

  return { keyset: baseKeyset, size, backward, hasCursor: cursorStr !== undefined };
}
