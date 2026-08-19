import { columnFiltersToQueryString, flatObjectToQueryString } from './to-query-string.js';
import { FILTER_OPERATORS } from './types.js';
import type { ColumnFilter, FilterOperator } from './types.js';
import {
  UNARY_OPERATORS,
  validateAddOperator,
  validateOperatorValue,
} from './validate-operator-value.js';

/**
 * A single sort directive: field name and direction.
 */
export interface SortItem {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Offset-based pagination parameters.
 */
export interface OffsetPagination {
  page: number;
  size: number;
}

/**
 * Internal representation of a condition added via `where()`.
 */
interface Condition {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

/**
 * Internal representation of an OR/AND group.
 */
interface Group {
  type: 'OR' | 'AND';
  conditions: Condition[];
}

/**
 * The result shape returned by `build()`.
 *
 * Uses the structured input format: `{ filter, include, search, sort, paginate }`.
 */
export interface FilterQueryResult {
  filter: {
    where: ColumnFilter[];
    [key: string]: unknown;
  };
  include?: string[];
  search?: string;
  sort?: SortItem[];
  distinct?: string[];
  paginate?: OffsetPagination;
  [key: string]: unknown;
}

/**
 * Client-side query builder for @adonis-agora/filter.
 * Zero dependencies. Runs in browser + Node.
 */
export class FilterQueryBuilder {
  private conditions: Condition[] = [];
  private readonly groups: Group[] = [];
  private extra: Record<string, unknown> = {};
  private includes: string[] = [];
  private searchTerm: string | undefined;
  private sorts: SortItem[] = [];
  private distinctFields: string[] = [];
  private pagination: OffsetPagination | undefined;

  // ─── Reactivity (framework-agnostic store contract) ──────────────────────
  // The builder doubles as an observable store so framework adapters
  // (React's useSyncExternalStore, Vue refs, Svelte stores) can react to
  // mutations. `version` increments on every mutation; `snapshot` caches the
  // last `build()` so `getSnapshot()` returns a stable reference until the
  // next mutation — required by useSyncExternalStore to avoid render loops.
  private version = 0;
  private snapshot: FilterQueryResult | null = null;
  private readonly listeners = new Set<() => void>();

  /**
   * Adds a filter condition, **replacing** any existing filter(s) for the same field.
   * Each field has at most one filter via `where()`. This is the natural mode for
   * React UIs where a dropdown/input replaces the previous selection.
   *
   * Use `add()` when you need multiple filters on the same field (e.g. ranges).
   *
   * @example
   * // Equals
   * where('name', 'foo')
   *
   * // With operator
   * where('age', 'gte', 25)
   *
   * // Array → auto in
   * where('status', ['A', 'B'])
   *
   * // Replaces previous status filter
   * where('status', ['C'])
   */
  // Scalar operators
  where(
    field: string,
    operator: 'equals' | 'notEquals' | 'gt' | 'gte' | 'lt' | 'lte',
    value: string | number | boolean | Date,
  ): this;
  // String operators
  where(
    field: string,
    operator: 'contains' | 'notContains' | 'iContains' | 'startsWith' | 'endsWith',
    value: string,
  ): this;
  // Array operators
  where(field: string, operator: 'in' | 'notIn' | 'isAnyOf', value: unknown[]): this;
  // Tuple operators
  where(field: string, operator: 'between' | 'notBetween', value: [unknown, unknown]): this;
  // Unary operators
  where(
    field: string,
    operator: 'isNull' | 'isNotNull' | 'isEmpty' | 'isNotEmpty' | 'exists' | 'notExists',
  ): this;
  // Two-arg shorthand: value or array
  where(field: string, value: unknown): this;
  // General fallback
  where(field: string, operator: FilterOperator, value?: unknown): this;
  where(field: string, operatorOrValue: unknown, maybeValue?: unknown): this {
    // Remove any existing filter(s) for this field
    this.conditions = this.conditions.filter((c) => c.field !== field);

    if (maybeValue !== undefined) {
      // Three-arg form: where(field, operator, value)
      const op = operatorOrValue as FilterOperator;
      validateOperatorValue(op, maybeValue);
      this.conditions.push({
        field,
        operator: op,
        value: maybeValue,
      });
    } else if (Array.isArray(operatorOrValue)) {
      // Array value → auto in
      this.conditions.push({
        field,
        operator: 'in',
        value: operatorOrValue,
      });
    } else if (
      typeof operatorOrValue === 'string' &&
      ['isNull', 'isNotNull', 'isEmpty', 'isNotEmpty', 'exists', 'notExists'].includes(
        operatorOrValue,
      )
    ) {
      // Two-arg form with unary operator: where(field, 'isNull')
      validateOperatorValue(operatorOrValue as FilterOperator, undefined);
      this.conditions.push({
        field,
        operator: operatorOrValue as FilterOperator,
        value: undefined,
      });
    } else {
      // Simple value → equals
      this.conditions.push({
        field,
        operator: 'equals',
        value: operatorOrValue,
      });
    }
    this.notify();
    return this;
  }

  /**
   * Runtime-driven escape hatch for applying a filter whose field name comes
   * from state you don't control at compile time — e.g. an AG-Grid column id, a
   * user-built query, or any field the codegen'd typed builder doesn't know
   * about. Unlike {@link where}, the field is a plain `string` (the typed
   * builder narrows `where` to the generated field union, but keeps
   * `whereDynamic` open), so it deliberately steps outside the type-level
   * allow-list — the SERVER's allow-list is still the real security boundary.
   *
   * Same **replace** semantics as {@link where} (one filter per field). The
   * operator is validated against the known operator set and its value shape.
   *
   * @example
   * // field name only known at runtime
   * builder.whereDynamic(column.id, filterModel.operator, filterModel.value)
   *
   * // Unary operators accept the 2-arg form
   * builder.whereDynamic('deletedAt', 'isNull')
   */
  whereDynamic(field: string, operator: FilterOperator, value?: unknown): this {
    if (!FILTER_OPERATORS.includes(operator)) {
      throw new Error(`Unknown filter operator "${String(operator)}".`);
    }
    validateOperatorValue(operator, value);
    // Replace any existing filter(s) for this field — same semantics as where().
    this.conditions = this.conditions.filter((c) => c.field !== field);
    this.conditions.push({
      field,
      operator,
      // Unary operators carry no value — strip any (commonly stale) value the
      // caller passed so the emitted condition stays canonical.
      value: UNARY_OPERATORS.has(operator) ? undefined : value,
    });
    this.notify();
    return this;
  }

  /**
   * Adds a filter condition, **accumulating** with any existing filters for the
   * same field. Use for range queries where you need multiple operators on one field.
   *
   * Only range operators (`gt`, `gte`, `lt`, `lte`) are allowed. For other
   * operators, use `where()` which replaces the previous filter for the field.
   *
   * @example
   * filterQuery()
   *   .add('createdAt', 'gte', '2026-01-01')
   *   .add('createdAt', 'lte', '2026-12-31')
   */
  add(
    field: string,
    operator: 'gt' | 'gte' | 'lt' | 'lte',
    value: string | number | boolean | Date,
  ): this;
  add(field: string, operator: FilterOperator, value?: unknown): this;
  add(field: string, operator: FilterOperator, value?: unknown): this {
    validateAddOperator(operator);
    validateOperatorValue(operator, value);
    this.conditions.push({ field, operator, value });
    this.notify();
    return this;
  }

  /**
   * Removes ALL filters for a given field (both from `where()` and `add()`).
   *
   * @example
   * filterQuery()
   *   .equals('status', 'COMPLETED')
   *   .contains('name', 'fleet')
   *   .remove('status')
   *   .build();
   * // → { where: [{ field: 'name', operator: 'contains', value: 'fleet' }] }
   */
  remove(field: string): this {
    this.conditions = this.conditions.filter((c) => c.field !== field);
    this.notify();
    return this;
  }

  /**
   * Removes all filters and extra keys, resetting the builder to its initial state.
   */
  clear(): this {
    this.conditions = [];
    this.groups.length = 0;
    this.extra = {};
    this.includes = [];
    this.searchTerm = undefined;
    this.sorts = [];
    this.distinctFields = [];
    this.pagination = undefined;
    this.notify();
    return this;
  }

  /**
   * Adds an OR group. Conditions inside the callback are OR-ed together.
   *
   * @example
   * filterQuery()
   *   .where('status', 'active')
   *   .or(q => q
   *     .where('name', 'contains', 'sync')
   *     .where('email', 'contains', 'sync')
   *   )
   */
  or(fn: (q: FilterQueryBuilder) => void): this {
    const sub = new FilterQueryBuilder();
    fn(sub);
    this.groups.push({ type: 'OR', conditions: sub.conditions });
    this.notify();
    return this;
  }

  /**
   * Adds an AND group. Conditions inside the callback are AND-ed together.
   *
   * @example
   * filterQuery()
   *   .and(q => q
   *     .where('age', 'gte', 18)
   *     .where('age', 'lte', 65)
   *   )
   */
  and(fn: (q: FilterQueryBuilder) => void): this {
    const sub = new FilterQueryBuilder();
    fn(sub);
    this.groups.push({ type: 'AND', conditions: sub.conditions });
    this.notify();
    return this;
  }

  // ─── Convenience methods ─────────────────────────────────────────────────

  equals(field: string, value: unknown): this {
    return this.where(field, 'equals', value);
  }

  notEquals(field: string, value: unknown): this {
    return this.where(field, 'notEquals', value);
  }

  contains(field: string, value: string): this {
    return this.where(field, 'contains', value);
  }

  in(field: string, values: unknown[]): this {
    return this.where(field, 'in', values);
  }

  notIn(field: string, values: unknown[]): this {
    return this.where(field, 'notIn', values);
  }

  between(field: string, low: unknown, high: unknown): this {
    return this.where(field, 'between', [low, high]);
  }

  gt(field: string, value: unknown): this {
    return this.where(field, 'gt', value);
  }

  gte(field: string, value: unknown): this {
    return this.where(field, 'gte', value);
  }

  lt(field: string, value: unknown): this {
    return this.where(field, 'lt', value);
  }

  lte(field: string, value: unknown): this {
    return this.where(field, 'lte', value);
  }

  isNull(field: string): this {
    return this.where(field, 'isNull');
  }

  isNotNull(field: string): this {
    return this.where(field, 'isNotNull');
  }

  isEmpty(field: string): this {
    return this.where(field, 'isEmpty');
  }

  isNotEmpty(field: string): this {
    return this.where(field, 'isNotEmpty');
  }

  startsWith(field: string, value: string): this {
    return this.where(field, 'startsWith', value);
  }

  endsWith(field: string, value: string): this {
    return this.where(field, 'endsWith', value);
  }

  // ─── Range helpers (use add — accumulate) ───────────────────────────────

  /**
   * Adds a `gte` filter using `add()` (accumulating).
   * Useful for range queries where you also need an `lte` on the same field.
   */
  addGte(field: string, value: unknown): this {
    return this.add(field, 'gte', value);
  }

  /**
   * Adds a `lte` filter using `add()` (accumulating).
   * Useful for range queries where you also need a `gte` on the same field.
   */
  addLte(field: string, value: unknown): this {
    return this.add(field, 'lte', value);
  }

  /**
   * Adds a `gt` filter using `add()` (accumulating).
   */
  addGt(field: string, value: unknown): this {
    return this.add(field, 'gt', value);
  }

  /**
   * Adds a `lt` filter using `add()` (accumulating).
   */
  addLt(field: string, value: unknown): this {
    return this.add(field, 'lt', value);
  }

  // ─── Extra keys ─────────────────────────────────────────────────────────

  /**
   * Adds an extra key/value pair to the query result (e.g. page, size).
   *
   * @example
   * filterQuery()
   *   .where('status', 'active')
   *   .set('page', 1)
   *   .set('size', 25)
   *   .build();
   * // → { where: [...], page: 1, size: 25 }
   */
  set(key: string, value: unknown): this {
    this.extra[key] = value;
    this.notify();
    return this;
  }

  // ─── Include & Search ────────────────────────────────────────────────────

  /**
   * Adds relation paths to eagerly load.
   *
   * @example
   * filterQuery().include('role', 'posts').build()
   * // → { filter: { where: [] }, include: ['role', 'posts'] }
   */
  include(...relations: string[]): this {
    for (const rel of relations) {
      if (typeof rel !== 'string') continue;
      if (!this.includes.includes(rel)) {
        this.includes.push(rel);
      }
    }
    this.notify();
    return this;
  }

  /**
   * Sets the global search term.
   *
   * @example
   * filterQuery().search('fleet').build()
   * // → { filter: { where: [] }, search: 'fleet' }
   */
  search(term: string): this {
    if (typeof term !== 'string') return this;
    this.searchTerm = term;
    this.notify();
    return this;
  }

  /**
   * Selects DISTINCT values of the given field(s) — the active where/search/
   * sort/pagination still apply. Useful for populating a filter dropdown with
   * the distinct values of a column. Repeated fields are deduplicated.
   *
   * @example
   * filterQuery().where('baseId', 'b1').distinct('afsc').page(0, 20).build()
   * // → { filter: { where: [...] }, distinct: ['afsc'], paginate: { page: 0, size: 20 } }
   */
  distinct(...fields: string[]): this {
    for (const field of fields) {
      if (typeof field !== 'string') continue;
      if (!this.distinctFields.includes(field)) {
        this.distinctFields.push(field);
      }
    }
    this.notify();
    return this;
  }

  // ─── Sort & Pagination ──────────────────────────────────────────────────

  /**
   * Adds or replaces a sort directive for the given field.
   * If a sort for the same field already exists, it is replaced.
   *
   * @example
   * filterQuery().sort('createdAt', 'desc').sort('name').build()
   * // → { ..., sort: [{ field: 'createdAt', direction: 'desc' }, { field: 'name', direction: 'asc' }] }
   */
  sort(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.sorts = this.sorts.filter((s) => s.field !== field);
    this.sorts.push({ field, direction });
    this.notify();
    return this;
  }

  /**
   * Runtime-driven escape hatch for a sort whose field name comes from state you
   * don't control at compile time (the sort counterpart of
   * {@link whereDynamic}). Identical to {@link sort} at runtime — it exists so
   * the typed builder can keep `sort` narrowed to the generated field union
   * while still offering an explicit, untyped `string` entry point.
   *
   * @example
   * builder.sortDynamic(column.id, sortModel.direction)
   */
  sortDynamic(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    return this.sort(field, direction);
  }

  /**
   * Shorthand for `sort(field, 'desc')`.
   */
  sortDesc(field: string): this {
    return this.sort(field, 'desc');
  }

  /**
   * Shorthand for `sort(field, 'asc')`.
   */
  sortAsc(field: string): this {
    return this.sort(field, 'asc');
  }

  /**
   * Sets offset-based pagination.
   *
   * @param page - Zero-based page number.
   * @param size - Number of records per page (default 25).
   *
   * @example
   * filterQuery().page(0, 25).build()
   * // → { ..., paginate: { page: 0, size: 25 } }
   */
  page(page: number, size = 25): this {
    this.pagination = { page, size };
    this.notify();
    return this;
  }

  // ─── Reactivity ───────────────────────────────────────────────────────────

  /**
   * Bumps the version, invalidates the cached snapshot, and notifies every
   * subscriber. Called internally by every mutating method. Convenience
   * methods (`equals`, `sortAsc`, `addGte`, …) delegate to a primitive
   * mutator, so they notify transitively — never call `notify()` from them.
   */
  private notify(): void {
    this.version++;
    this.snapshot = null;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Subscribes to mutations. Returns an unsubscribe function.
   *
   * Bound so it can be passed directly to `useSyncExternalStore` /
   * Svelte's store contract without wrapping in an arrow.
   *
   * @example
   * const unsubscribe = qb.subscribe(() => rerender());
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Returns the current built result, cached until the next mutation.
   *
   * The reference is stable across calls while the builder is unchanged, which
   * is what `useSyncExternalStore` requires to avoid infinite render loops.
   *
   * Bound for the same reason as `subscribe`.
   */
  getSnapshot = (): FilterQueryResult => {
    if (this.snapshot === null) {
      this.snapshot = this.build();
    }
    return this.snapshot;
  };

  /**
   * Monotonic mutation counter. Useful as a cheap dependency/key for adapters
   * that prefer an integer over reference comparison.
   */
  getVersion(): number {
    return this.version;
  }

  // ─── Build ──────────────────────────────────────────────────────────────

  /**
   * Builds the query as a `FilterQueryResult` object.
   *
   * Returns the structured format: `{ filter: { where: [...] }, include: [...], search: '...' }`
   */
  build(): FilterQueryResult {
    const filters: ColumnFilter[] = [];

    for (const cond of this.conditions) {
      filters.push({
        field: cond.field,
        operator: cond.operator,
        value: cond.value,
      });
    }

    for (const group of this.groups) {
      const groupFilters: ColumnFilter[] = group.conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.value,
      }));

      if (group.type === 'OR') {
        filters.push({
          field: '',
          operator: 'equals',
          value: undefined,
          OR: groupFilters,
        });
      } else {
        filters.push({
          field: '',
          operator: 'equals',
          value: undefined,
          AND: groupFilters,
        });
      }
    }

    const result: FilterQueryResult = {
      ...this.extra,
      filter: { where: filters },
    };
    if (this.includes.length > 0) {
      result.include = [...this.includes];
    }
    if (this.searchTerm !== undefined) {
      result.search = this.searchTerm;
    }
    if (this.sorts.length > 0) {
      result.sort = [...this.sorts];
    }
    if (this.distinctFields.length > 0) {
      result.distinct = [...this.distinctFields];
    }
    if (this.pagination !== undefined) {
      result.paginate = { ...this.pagination };
    }
    return result;
  }

  /**
   * Serializes to a query string suitable for GET requests.
   *
   * Uses the structured format:
   * - Simple conditions → `filter[field]=value&filter[field][op]=value`
   * - OR/AND groups → `filter[where][i][field]=...`
   * - Includes → `include=role,posts`
   * - Search → `search=term`
   */
  toQueryString(): string {
    const parts: string[] = [];

    // Build filter portion
    let filterQs: string;
    if (this.groups.length === 0) {
      const flat = this.toFlatObject();
      filterQs = flatObjectToQueryString(
        Object.fromEntries(Object.entries(flat).map(([k, v]) => [`filter[${k}]`, v])),
      );
    } else {
      filterQs = columnFiltersToQueryString(this.build().filter.where);
    }
    if (filterQs) parts.push(filterQs);

    // Build include
    if (this.includes.length > 0) {
      parts.push(`include=${encodeURIComponent(this.includes.join(','))}`);
    }

    // Build search
    if (this.searchTerm !== undefined) {
      parts.push(`search=${encodeURIComponent(this.searchTerm)}`);
    }

    // Build sort
    if (this.sorts.length > 0) {
      const sortStr = this.sorts
        .map((s) => (s.direction === 'desc' ? `-${s.field}` : s.field))
        .join(',');
      parts.push(`sort=${encodeURIComponent(sortStr)}`);
    }

    // Build distinct
    if (this.distinctFields.length > 0) {
      parts.push(`distinct=${encodeURIComponent(this.distinctFields.join(','))}`);
    }

    // Build pagination
    if (this.pagination !== undefined) {
      parts.push(`page=${encodeURIComponent(String(this.pagination.page))}`);
      parts.push(`size=${encodeURIComponent(String(this.pagination.size))}`);
    }

    // Build extra keys
    const extraQs = flatObjectToQueryString(this.extra);
    if (extraQs) parts.push(extraQs);

    return parts.join('&');
  }

  /**
   * Converts to a flat object suitable for auto-fields.
   *
   * Simple equals → `{ field: value }`
   * Array (in) → `{ field: [values] }`
   * Other operators → `{ field: { operator: value } }`
   * Multiple operators on same field → merged into one object.
   *
   * Note: OR/AND groups are NOT representable as flat objects.
   * Use `build()` for complex queries.
   */
  toFlatObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const cond of this.conditions) {
      if (cond.operator === 'equals') {
        result[cond.field] = cond.value;
      } else if (cond.operator === 'in') {
        result[cond.field] = cond.value;
      } else {
        // Operator → bracket notation object
        const existing = result[cond.field];
        if (existing != null && typeof existing === 'object' && !Array.isArray(existing)) {
          // Merge operators on same field
          (existing as Record<string, unknown>)[cond.operator] = cond.value;
        } else {
          result[cond.field] = { [cond.operator]: cond.value };
        }
      }
    }

    return result;
  }
}

/**
 * Creates a new FilterQueryBuilder instance.
 *
 * @example
 * import { filterQuery } from '@adonis-agora/filter-client';
 *
 * const q = filterQuery()
 *   .where('name', 'contains', 'fleet')
 *   .where('status', ['COMPLETED', 'FAILED'])
 *   .build();
 */
export function filterQuery(): FilterQueryBuilder {
  return new FilterQueryBuilder();
}
