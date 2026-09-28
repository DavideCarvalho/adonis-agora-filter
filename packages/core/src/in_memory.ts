import {
  buildCursorPage,
  type CursorPage,
  type CursorParams,
  type ResolvedCursor,
} from './cursor.js';
import type { QueryBuilderLike } from './lucid_adapter.js';
import { applyCursor, applyFilter, type CursorConfig } from './runner.js';
import type { FilterConfig, FilterFieldKind, FilterInput, SortItem } from './types.js';

/**
 * The in-memory adapter: a {@link QueryBuilderLike} that evaluates against a plain JS array.
 *
 * The runner (`applyFilter`, `applyCursor`, `applyFilterFromRequest`, `groupByCountFromRequest`)
 * does exactly what it does for a Lucid query — parse, alias-resolve, validate, allow-list, coerce —
 * and then drives the same builder calls it would hand Lucid. This builder records those calls and
 * evaluates them over rows instead of compiling SQL, so an in-memory listing speaks the same wire
 * format, operators and error shapes as a database one, and a filter spec written for a model
 * works unchanged over rows assembled in memory (several sources merged, a static catalog, a
 * remote API page).
 *
 * The evaluation mirrors what Postgres does with the SQL the Lucid adapter emits — including the
 * places that surprise people: three-valued NULL logic (a NULL value fails `notEquals`/`notIn`/
 * `notBetween`, `NOT IN` a list holding NULL matches nothing), ILIKE for every LIKE-style operator,
 * and NULLS LAST on ascending / NULLS FIRST on descending order.
 */

/** A scalar array kind — an in-memory extension; see {@link InMemoryFieldType}. */
export type InMemoryArrayKind = 'string[]' | 'number[]' | 'boolean[]' | 'date[]';

/**
 * A declared field type. The scalar kinds are the lib's own {@link FilterFieldKind}; the array
 * kinds declare a list-valued field, on which a scalar operator matches when ANY element matches
 * and a negated operator (`notEquals`, `notIn`, `notBetween`) matches when NO element does.
 */
export type InMemoryFieldType = FilterFieldKind | InMemoryArrayKind;

/** A virtual field: a value computed from the row — the in-memory counterpart of `computed`. */
export interface InMemoryVirtualField<T> {
  type: InMemoryFieldType;
  get: (row: T) => unknown;
}

/** One entry of {@link DefineCollectionOptions.fields}: a stored field's type, or a virtual field. */
export type InMemoryFieldDeclaration<T> = InMemoryFieldType | InMemoryVirtualField<T>;

/** Relation cardinality. `*-to-one` reads a row (or null); `*-to-many` reads an array. */
export type InMemoryRelationKind = 'one-to-one' | 'many-to-one' | 'one-to-many' | 'many-to-many';

/**
 * A relation a dotted filter path (`posts.title`) can cross. The runner turns such a path into a
 * `whereHas`, evaluated here with EXISTS semantics: the row matches when at least one related row
 * satisfies the nested conditions.
 */
export interface InMemoryRelation<T> {
  kind: InMemoryRelationKind;
  /** The related collection — a thunk so two collections can reference each other. */
  // biome-ignore lint/suspicious/noExplicitAny: a relation targets a collection of any row type; `unknown` makes every concrete collection unassignable (its row type is used contravariantly).
  target: () => InMemoryCollection<any>;
  /** Read the related row(s) off a row. `null`/`undefined` means no related row. */
  get: (row: T) => unknown;
}

/** Options for {@link defineCollection}. */
export interface DefineCollectionOptions<T> {
  /**
   * The field declarations — what each field is, so filter values are compared as that kind
   * (`'3'` equals `3` on a `number` field, `'true'` equals `true` on a `boolean`, ISO strings
   * compare as instants on a `date`). A field that is not declared is read as an own property and
   * compared by the kind its value has at runtime.
   */
  fields: Record<string, InMemoryFieldDeclaration<T>>;
  /** The keyset tiebreaker for cursor pagination. Default `'id'`. */
  primaryKey?: string;
  /** Relations dotted filter paths may cross. */
  relations?: Record<string, InMemoryRelation<T>>;
  /**
   * The collection's "table" name. A `distinct`/sort field qualified with it (`users.name`, the
   * form {@link FilterConfig.table} makes projectable) reads the root field `name`.
   */
  name?: string;
}

interface ResolvedField<T> {
  kind: FilterFieldKind;
  array: boolean;
  get: ((row: T) => unknown) | undefined;
}

/** A declared, reusable row source. Create one with {@link defineCollection}. */
export interface InMemoryCollection<T extends object> {
  readonly name: string | undefined;
  readonly primaryKey: string;
  /**
   * The declared fields as the colocated `filterable` map `defineFilter` accepts
   * (`defineFilter({ filterable: users.filterable })`) — array kinds map to their element kind,
   * which is what the runner coerces a filter value to.
   */
  readonly filterable: Readonly<Record<string, FilterFieldKind>>;
  /** The declared fields as {@link FilterConfig.fieldTypes}, for `applyFilter` callers. */
  readonly fieldTypes: Readonly<Record<string, { kind: FilterFieldKind }>>;
  /** Start a query over `rows` — hand the builder to the runner like a Lucid query. */
  query(rows: Iterable<T>): InMemoryQueryBuilder<T>;
  /** @internal */
  readonly $fields: Readonly<Record<string, ResolvedField<T>>>;
  /** @internal */
  readonly $relations: Readonly<Record<string, InMemoryRelation<T>>>;
}

/**
 * Thrown when the runner asks the in-memory builder for something only SQL can do: a raw
 * predicate or ordering (policy `computed` fields, `fullText`, `vectorSimilarity`) — declare a
 * virtual field instead — or a relation/field path the collection does not declare.
 */
export class InMemoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InMemoryQueryError';
  }
}

const ARRAY_KINDS: Record<InMemoryArrayKind, FilterFieldKind> = {
  'string[]': 'string',
  'number[]': 'number',
  'boolean[]': 'boolean',
  'date[]': 'date',
};

function resolveType(type: InMemoryFieldType): { kind: FilterFieldKind; array: boolean } {
  const element = (ARRAY_KINDS as Record<string, FilterFieldKind | undefined>)[type];
  return element ? { kind: element, array: true } : { kind: type as FilterFieldKind, array: false };
}

/**
 * Declare a collection: its fields (and their types), virtual fields, primary key and relations.
 *
 * ```ts
 * const posts = defineCollection<Post>({ fields: { id: 'number', title: 'string' } })
 * const users = defineCollection<User>({
 *   fields: {
 *     id: 'number',
 *     name: 'string',
 *     age: 'number',
 *     tags: 'string[]',
 *     fullName: { type: 'string', get: (u) => `${u.first} ${u.last}` },
 *   },
 *   relations: { posts: { kind: 'one-to-many', target: () => posts, get: (u) => u.posts } },
 * })
 *
 * const qb = users.query(rows)
 * const { page, size } = applyFilter(qb, input, { allowed: ['name', 'posts.title'] })
 * return qb.paginate(page, size)
 * ```
 */
export function defineCollection<T extends object>(
  options: DefineCollectionOptions<T>,
): InMemoryCollection<T> {
  const fields: Record<string, ResolvedField<T>> = Object.create(null);
  const filterable: Record<string, FilterFieldKind> = {};
  const fieldTypes: Record<string, { kind: FilterFieldKind }> = {};
  for (const [name, declaration] of Object.entries(options.fields)) {
    const virtual = typeof declaration === 'object' ? declaration : undefined;
    const { kind, array } = resolveType(
      virtual ? virtual.type : (declaration as InMemoryFieldType),
    );
    fields[name] = { kind, array, get: virtual?.get };
    filterable[name] = kind;
    fieldTypes[name] = { kind };
  }
  const relations: Record<string, InMemoryRelation<T>> = Object.create(null);
  for (const [name, relation] of Object.entries(options.relations ?? {})) {
    relations[name] = relation;
  }

  const collection: InMemoryCollection<T> = {
    name: options.name,
    primaryKey: options.primaryKey ?? 'id',
    filterable,
    fieldTypes,
    $fields: fields,
    $relations: relations,
    query: (rows) => new InMemoryQueryBuilder(collection, [...rows]),
  };
  return collection;
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

type Predicate<T> = (row: T) => boolean;

function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function hasToMillis(value: unknown): value is { toMillis(): number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  );
}

/** The kind a runtime value has — used for undeclared (`unknown`/`json`) fields. */
function inferKind(value: unknown): FilterFieldKind {
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (value instanceof Date || hasToMillis(value)) return 'date';
  return 'json';
}

/**
 * Normalize a value to a comparable primitive of `kind`, the way Postgres casts a bound literal to
 * the column type. `undefined` means "cannot be cast" — the comparison is then false, where
 * Postgres would have rejected the query outright.
 */
function normalize(value: unknown, kind: FilterFieldKind): unknown {
  if (isNil(value)) return undefined;
  switch (kind) {
    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 0) return value === 1;
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'true' || v === '1') return true;
        if (v === 'false' || v === '0') return false;
      }
      return undefined;
    }
    case 'date': {
      if (value instanceof Date) {
        const t = value.getTime();
        return Number.isNaN(t) ? undefined : t;
      }
      if (hasToMillis(value)) return value.toMillis();
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      if (typeof value === 'string') {
        const t = Date.parse(value);
        return Number.isNaN(t) ? undefined : t;
      }
      return undefined;
    }
    case 'string':
      return typeof value === 'string' ? value : stringify(value);
    default:
      // json / unknown: structural equality only.
      return typeof value === 'object' ? JSON.stringify(value) : value;
  }
}

/** Text form of a value — what a LIKE on a non-text column matches against. */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (hasToMillis(value)) return new Date(value.toMillis()).toISOString();
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

/**
 * Compare a row value to a comparand under `kind` (`json`/`unknown` → the row value's own kind).
 * `undefined` when either side cannot be cast or the kind has no ordering.
 */
function compare(
  rowValue: unknown,
  comparand: unknown,
  declared: FilterFieldKind,
): number | undefined {
  const kind = declared === 'json' || declared === 'unknown' ? inferKind(rowValue) : declared;
  const a = normalize(rowValue, kind);
  const b = normalize(comparand, kind);
  if (a === undefined || b === undefined) return undefined;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'string' && typeof b === 'string') {
    // Code-unit order — Postgres' "C" collation. Deterministic and locale-free, which a keyset
    // cursor needs: the seek predicate and the ORDER BY must agree on every pair of values.
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return a === b ? 0 : undefined;
}

/** Compile a LIKE pattern (backslash escapes, `%`, `_`) into an anchored RegExp. */
function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '\\' && i + 1 < pattern.length) {
      source += escapeRegExp(pattern[++i] as string);
    } else if (ch === '%') {
      source += '.*';
    } else if (ch === '_') {
      source += '.';
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`, caseInsensitive ? 'is' : 's');
}

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Relation targets normalized to a list (a to-one relation yields zero or one row). */
function relatedRows(value: unknown): object[] {
  if (isNil(value)) return [];
  if (Array.isArray(value)) return value.filter((v): v is object => !isNil(v));
  return [value as object];
}

/** Parse a `expr AS alias` select/count argument. */
function parseAlias(expression: string): { expr: string; alias: string } {
  const match = /^\s*(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(expression);
  return match
    ? { expr: (match[1] as string).trim(), alias: match[2] as string }
    : { expr: expression.trim(), alias: expression.trim() };
}

/** The raw predicate the group-by-count search emits — the only raw SQL this adapter understands. */
const GROUP_SEARCH_SQL = /^\s*LOWER\(\?\?\)\s+LIKE\s+\?\s*$/i;

// ---------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------

interface Clause<T> {
  or: boolean;
  test: Predicate<T>;
}

/** The pagination meta {@link InMemoryQueryBuilder.paginate} returns — Lucid's paginator fields. */
export interface InMemoryPageMeta {
  total: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  firstPage: number;
}

/** One offset page — the shape of a serialized Lucid paginator (`{ meta, data }`). */
export interface InMemoryPage<T> {
  data: T[];
  meta: InMemoryPageMeta;
}

/**
 * A {@link QueryBuilderLike} over an array. Created by {@link InMemoryCollection.query}; hand it to
 * any runner entry point exactly as you would a Lucid query, then read the result with
 * {@link all}, {@link paginate}, or by awaiting it (it is thenable, like a Lucid query — which is
 * what lets `groupByCountFromRequest` run over it unchanged).
 */
export class InMemoryQueryBuilder<T extends object> implements QueryBuilderLike {
  private readonly clauses: Clause<T>[] = [];
  private readonly sorts: SortItem[] = [];
  private readonly selects: { expr: string; alias: string }[] = [];
  private readonly groups: string[] = [];
  private readonly groupSearches: { field: string; pattern: RegExp }[] = [];
  private distinctFields: string[] = [];
  private countAlias: string | undefined;
  private limitCount: number | undefined;
  private offsetCount: number | undefined;

  constructor(
    readonly collection: InMemoryCollection<T>,
    private readonly rows: readonly T[] = [],
  ) {}

  // -- field access -----------------------------------------------------------------------------

  private field(name: string): ResolvedField<T> | undefined {
    return this.collection.$fields[name];
  }

  /** Strip a leading `<collection name>.` qualifier. */
  private unqualify(path: string): string {
    const name = this.collection.name;
    return name !== undefined && path.startsWith(`${name}.`) ? path.slice(name.length + 1) : path;
  }

  /**
   * Read a (possibly dotted) path off a row. A dotted path crosses a to-one relation; crossing a
   * to-many relation is ambiguous outside a `whereHas` (which the runner uses for filters) and is
   * rejected.
   */
  read(row: T, rawPath: string): unknown {
    const path = this.unqualify(rawPath);
    const dot = path.indexOf('.');
    if (dot === -1) {
      const declared = this.field(path);
      if (declared?.get) return declared.get(row);
      return Object.hasOwn(row, path) ? (row as Record<string, unknown>)[path] : undefined;
    }
    const head = path.slice(0, dot);
    const relation = this.collection.$relations[head];
    if (!relation) {
      throw new InMemoryQueryError(
        `"${rawPath}" crosses "${head}", which is not a relation declared on this collection.`,
      );
    }
    if (relation.kind === 'one-to-many' || relation.kind === 'many-to-many') {
      throw new InMemoryQueryError(
        `"${rawPath}" reads through the to-many relation "${head}" — only a filter (EXISTS) can cross it.`,
      );
    }
    const related = relatedRows(relation.get(row))[0];
    if (related === undefined) return undefined;
    return relation
      .target()
      .query([])
      .read(related, path.slice(dot + 1));
  }

  /** The declared kind of a path (following to-one relations), or `unknown`. */
  private kindOf(rawPath: string): { kind: FilterFieldKind; array: boolean } {
    const path = this.unqualify(rawPath);
    const dot = path.indexOf('.');
    if (dot === -1) return this.field(path) ?? { kind: 'unknown', array: false };
    const relation = this.collection.$relations[path.slice(0, dot)];
    if (!relation) return { kind: 'unknown', array: false };
    return relation
      .target()
      .query([])
      .kindOf(path.slice(dot + 1));
  }

  /**
   * Build a leaf predicate. `match` tests one non-null element; `negated` flips the element-level
   * result into "no element matches" — with SQL's rule that a NULL value (or an uncastable
   * comparison) satisfies neither a condition nor its negation.
   */
  private leaf(
    path: string,
    match: (element: unknown, kind: FilterFieldKind) => boolean | undefined,
    negated = false,
  ): Predicate<T> {
    const { kind, array } = this.kindOf(path);
    return (row) => {
      const value = this.read(row, path);
      if (isNil(value)) return false;
      if (array || (Array.isArray(value) && (kind === 'unknown' || kind === 'json'))) {
        const elements = (Array.isArray(value) ? value : [value]).filter((e) => !isNil(e));
        const results = elements.map((e) => match(e, kind));
        if (negated) return results.every((r) => r === false);
        return results.some((r) => r === true);
      }
      const result = match(value, kind);
      if (result === undefined) return false;
      return negated ? !result : result;
    };
  }

  private equalsLeaf(path: string, value: unknown, negated: boolean): Predicate<T> {
    return this.leaf(
      path,
      (e, kind) => {
        const c = compare(e, value, kind);
        return c === undefined ? undefined : c === 0;
      },
      negated,
    );
  }

  private compareLeaf(path: string, operator: string, value: unknown): Predicate<T> {
    switch (operator) {
      case '=':
        return isNil(value) ? () => false : this.equalsLeaf(path, value, false);
      case '!=':
      case '<>':
        return isNil(value) ? () => false : this.equalsLeaf(path, value, true);
      case '>':
      case '>=':
      case '<':
      case '<=':
        if (isNil(value)) return () => false;
        return this.leaf(path, (e, kind) => {
          const c = compare(e, value, kind);
          if (c === undefined) return undefined;
          if (operator === '>') return c > 0;
          if (operator === '>=') return c >= 0;
          if (operator === '<') return c < 0;
          return c <= 0;
        });
      default:
        throw new InMemoryQueryError(`Unsupported comparison operator "${operator}".`);
    }
  }

  private inLeaf(path: string, values: unknown[], negated: boolean): Predicate<T> {
    // SQL: `x IN ()` is false and `x NOT IN ()` is true for every row, NULLs included (knex emits
    // 1 = 0 / 1 = 1); `x NOT IN (…, NULL)` is never true.
    if (values.length === 0) return () => negated;
    if (negated && values.some(isNil)) return () => false;
    const candidates = values.filter((v) => !isNil(v));
    return this.leaf(
      path,
      (e, kind) => {
        let unknown = false;
        for (const candidate of candidates) {
          const c = compare(e, candidate, kind);
          if (c === 0) return true;
          if (c === undefined) unknown = true;
        }
        return unknown ? undefined : false;
      },
      negated,
    );
  }

  private betweenLeaf(path: string, range: [unknown, unknown], negated: boolean): Predicate<T> {
    const [low, high] = Array.isArray(range) ? range : [undefined, undefined];
    if (isNil(low) || isNil(high)) return () => false;
    return this.leaf(
      path,
      (e, kind) => {
        const lo = compare(e, low, kind);
        const hi = compare(e, high, kind);
        if (lo === undefined || hi === undefined) return undefined;
        return lo >= 0 && hi <= 0;
      },
      negated,
    );
  }

  private likeLeaf(path: string, pattern: string): Predicate<T> {
    const regex = likeToRegExp(pattern, true);
    return this.leaf(path, (e) => regex.test(stringify(e)));
  }

  private add(test: Predicate<T>, or = false): this {
    this.clauses.push({ or, test });
    return this;
  }

  private group(callback: (qb: QueryBuilderLike) => void, or: boolean): this {
    const child = new InMemoryQueryBuilder(this.collection);
    callback(child);
    // An empty group compiles to nothing in knex — not to an always-true/false clause.
    if (child.clauses.length === 0) return this;
    return this.add((row) => child.matches(row), or);
  }

  /**
   * Does `row` satisfy every recorded condition? Clauses chain left to right the way knex joins
   * them — `a AND b OR c` — so AND binds tighter than OR, exactly as the emitted SQL would.
   */
  matches(row: T): boolean {
    let result = false;
    let segment = true;
    this.clauses.forEach((clause, index) => {
      if (clause.or && index > 0) {
        result ||= segment;
        segment = true;
      }
      segment &&= clause.test(row);
    });
    return this.clauses.length === 0 ? true : result || segment;
  }

  // -- QueryBuilderLike -------------------------------------------------------------------------

  where(callback: (qb: QueryBuilderLike) => void): this;
  where(column: string, value: unknown): this;
  where(column: string, operator: string, value: unknown): this;
  where(...args: unknown[]): this {
    if (typeof args[0] === 'function') {
      return this.group(args[0] as (qb: QueryBuilderLike) => void, false);
    }
    const column = args[0] as string;
    if (args.length >= 3) return this.add(this.compareLeaf(column, String(args[1]), args[2]));
    // knex compiles `where(col, null)` to `col IS NULL`.
    if (isNil(args[1])) return this.whereNull(column);
    return this.add(this.equalsLeaf(column, args[1], false));
  }

  orWhere(callback: (qb: QueryBuilderLike) => void): this {
    return this.group(callback, true);
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches QueryBuilderLike.whereHas (see its docblock).
  whereHas(relation: any, callback: (qb: QueryBuilderLike) => void): this {
    const name = String(relation);
    const declared = this.collection.$relations[name];
    if (!declared) {
      throw new InMemoryQueryError(`"${name}" is not a relation declared on this collection.`);
    }
    const child = new InMemoryQueryBuilder(declared.target());
    callback(child);
    return this.add((row) => relatedRows(declared.get(row)).some((r) => child.matches(r)));
  }

  whereNot(column: string, value: unknown): this {
    if (isNil(value)) return this.whereNotNull(column);
    return this.add(this.equalsLeaf(column, value, true));
  }

  whereIn(column: string, values: unknown[]): this {
    return this.add(this.inLeaf(column, Array.isArray(values) ? values : [values], false));
  }

  whereNotIn(column: string, values: unknown[]): this {
    return this.add(this.inLeaf(column, Array.isArray(values) ? values : [values], true));
  }

  whereNull(column: string): this {
    return this.add((row) => isNil(this.read(row, column)));
  }

  whereNotNull(column: string): this {
    return this.add((row) => !isNil(this.read(row, column)));
  }

  whereBetween(column: string, range: [unknown, unknown]): this {
    return this.add(this.betweenLeaf(column, range, false));
  }

  whereNotBetween(column: string, range: [unknown, unknown]): this {
    return this.add(this.betweenLeaf(column, range, true));
  }

  whereILike(column: string, value: string): this {
    return this.add(this.likeLeaf(column, value));
  }

  orWhereILike(column: string, value: string): this {
    return this.add(this.likeLeaf(column, value), true);
  }

  orderBy(column: string, direction: 'asc' | 'desc'): this {
    this.sorts.push({ field: column, direction: direction === 'desc' ? 'desc' : 'asc' });
    return this;
  }

  /**
   * Only the group-by-count search predicate (`LOWER(??) LIKE ?`) is understood; any other raw
   * SQL — a policy's `computed` fields, `fullText`, `vectorSimilarity` — throws
   * {@link InMemoryQueryError}. Declare a virtual field on the collection instead of `computed`.
   */
  whereRaw(sql: string, bindings: readonly unknown[] = []): this {
    if (GROUP_SEARCH_SQL.test(sql) && typeof bindings[0] === 'string') {
      const field = bindings[0];
      const pattern = likeToRegExp(String(bindings[1] ?? ''), false);
      this.groupSearches.push({ field, pattern });
      return this.add(
        this.leaf(field, (e) => pattern.test(stringify(e).toLowerCase())),
        false,
      );
    }
    throw new InMemoryQueryError(
      `The in-memory adapter cannot evaluate raw SQL (${JSON.stringify(sql)}). Policy \`computed\` fields, \`fullText\` and \`vectorSimilarity\` are SQL-only — declare a virtual field on the collection instead.`,
    );
  }

  orderByRaw(sql: string, _bindings: readonly unknown[] = []): this {
    throw new InMemoryQueryError(
      `The in-memory adapter cannot order by raw SQL (${JSON.stringify(sql)}). Declare a virtual field on the collection and sort on it instead.`,
    );
  }

  distinct(...columns: string[]): this {
    this.distinctFields = columns;
    return this;
  }

  limit(count: number): this {
    this.limitCount = Math.max(0, count);
    return this;
  }

  offset(n: number): this {
    this.offsetCount = Math.max(0, n);
    return this;
  }

  select(...columns: string[]): this {
    for (const column of columns) this.selects.push(parseAlias(column));
    return this;
  }

  count(column: string): this {
    const { expr, alias } = parseAlias(column);
    if (expr !== '*') {
      throw new InMemoryQueryError(`Only count('*') is supported in memory, got "${column}".`);
    }
    this.countAlias = alias;
    return this;
  }

  groupBy(...columns: string[]): this {
    this.groups.push(...columns);
    return this;
  }

  // -- execution --------------------------------------------------------------------------------

  private compareRows(a: T, b: T): number {
    for (const { field, direction } of this.sorts) {
      const c = this.compareValues(
        this.read(a, field),
        this.read(b, field),
        this.kindOf(field).kind,
      );
      if (c !== 0) return direction === 'desc' ? -c : c;
    }
    return 0;
  }

  /** Ascending comparison with NULLs sorting last (so NULLS FIRST once a desc sort negates it). */
  private compareValues(a: unknown, b: unknown, kind: FilterFieldKind): number {
    if (isNil(a)) return isNil(b) ? 0 : 1;
    if (isNil(b)) return -1;
    return compare(a, b, kind) ?? 0;
  }

  /** Filter + sort (+ distinct / projection / aggregation), before limit/offset. */
  private evaluate(): T[] {
    const matched = this.rows.filter((row) => this.matches(row));
    if (this.groups.length > 0) return this.aggregate(matched) as unknown as T[];

    const sorted =
      this.sorts.length > 0 ? [...matched].sort((a, b) => this.compareRows(a, b)) : matched;

    if (this.distinctFields.length > 0) {
      const seen = new Set<string>();
      const out: Record<string, unknown>[] = [];
      for (const row of sorted) {
        const projected: Record<string, unknown> = {};
        const key: unknown[] = [];
        for (const field of this.distinctFields) {
          const value = this.read(row, field);
          projected[this.unqualify(field)] = value;
          key.push(normalize(value, this.kindOf(field).kind) ?? null);
        }
        const k = JSON.stringify(key);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(projected);
        }
      }
      return out as unknown as T[];
    }

    if (this.selects.length > 0) {
      return sorted.map((row) => {
        const projected: Record<string, unknown> = {};
        for (const { expr, alias } of this.selects) projected[alias] = this.read(row, expr);
        return projected as T;
      });
    }
    return sorted;
  }

  /**
   * `GROUP BY` over the matched rows. An array-typed grouping field is unnested — each element is
   * its own group — which is what a tag picker wants (Postgres would group whole arrays).
   */
  private aggregate(rows: T[]): Record<string, unknown>[] {
    const columns = this.groups;
    const groups = new Map<string, { values: unknown[]; count: number }>();
    const single = columns.length === 1 ? (columns[0] as string) : undefined;
    const unnest = single !== undefined && this.kindOf(single).array;
    const searches = this.groupSearches.filter((s) => s.field === single);

    for (const row of rows) {
      const tuples: unknown[][] = [];
      if (unnest) {
        const value = this.read(row, single as string);
        const elements = Array.isArray(value) ? value : isNil(value) ? [null] : [value];
        for (const element of elements) {
          if (
            searches.every(
              (s) => !isNil(element) && s.pattern.test(stringify(element).toLowerCase()),
            )
          ) {
            tuples.push([element]);
          }
        }
      } else {
        tuples.push(columns.map((c) => this.read(row, c)));
      }
      for (const values of tuples) {
        const key = JSON.stringify(
          values.map((v, i) => normalize(v, this.kindOf(columns[i] as string).kind) ?? null),
        );
        const group = groups.get(key);
        if (group) group.count++;
        else groups.set(key, { values, count: 1 });
      }
    }

    const outputs = [...groups.values()].map(({ values, count }) => {
      const row: Record<string, unknown> = {};
      const selects =
        this.selects.length > 0 ? this.selects : columns.map((c) => ({ expr: c, alias: c }));
      for (const { expr, alias } of selects) {
        const index = columns.indexOf(expr);
        if (index === -1) {
          throw new InMemoryQueryError(`"${expr}" is selected but not grouped by.`);
        }
        row[alias] = values[index];
      }
      if (this.countAlias !== undefined) row[this.countAlias] = count;
      return { row, values, count };
    });

    outputs.sort((a, b) => {
      for (const { field, direction } of this.sorts) {
        let c: number;
        if (field === this.countAlias) {
          c = a.count - b.count;
        } else {
          const index = columns.indexOf(field);
          const aliasIndex = this.selects.findIndex((s) => s.alias === field);
          const i =
            index !== -1
              ? index
              : aliasIndex !== -1
                ? columns.indexOf(this.selects[aliasIndex]!.expr)
                : -1;
          if (i === -1) throw new InMemoryQueryError(`Cannot order grouped rows by "${field}".`);
          c = this.compareValues(a.values[i], b.values[i], this.kindOf(columns[i] as string).kind);
        }
        if (c !== 0) return direction === 'desc' ? -c : c;
      }
      return 0;
    });
    return outputs.map((o) => o.row);
  }

  private window<R>(rows: R[]): R[] {
    const start = this.offsetCount ?? 0;
    const end = this.limitCount === undefined ? undefined : start + this.limitCount;
    return rows.slice(start, end);
  }

  /**
   * Execute: the matching rows in order, honouring `limit`/`offset` (which is what a cursor page
   * sets). Under a `distinct`, a `select` or a `groupBy`, the rows are projection objects — just
   * as a Lucid query returns them.
   */
  all(): T[] {
    return this.window(this.evaluate());
  }

  /** How many rows (or distinct tuples / groups) match, ignoring `limit`/`offset`. */
  total(): number {
    return this.evaluate().length;
  }

  /**
   * One offset page — the in-memory `query.paginate(page, size)`. Feed it the `{ page, size }`
   * the runner resolved (clamped and defaulted), never raw request values.
   */
  paginate(page: number, perPage: number): InMemoryPage<T> {
    const size = Math.max(1, Math.floor(perPage));
    const current = Math.max(1, Math.floor(page));
    const rows = this.evaluate();
    const total = rows.length;
    return {
      data: rows.slice((current - 1) * size, current * size),
      meta: {
        total,
        perPage: size,
        currentPage: current,
        lastPage: Math.max(1, Math.ceil(total / size)),
        firstPage: 1,
      },
    };
  }

  /**
   * Thenable, like a Lucid query: `await qb` resolves to {@link all}. This is what lets helpers
   * that execute a builder by awaiting it (`groupByCountFromRequest`) run over an array.
   */
  // biome-ignore lint/suspicious/noThenProperty: deliberately thenable, mirroring Lucid's query builders.
  then<R1 = T[], R2 = never>(
    onfulfilled?: ((rows: T[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return new Promise<T[]>((resolve) => resolve(this.all())).then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------------------------------------
// One-call helpers
// ---------------------------------------------------------------------------------------------

/**
 * Filter, search, sort and offset-paginate `rows` in one call: {@link applyFilter} over a fresh
 * builder, then {@link InMemoryQueryBuilder.paginate} with the resolved page. A `distinct` request
 * pages the distinct tuples instead of rows.
 *
 * ```ts
 * const page = filterInMemory(users, rows, parseFilterRequest(ctx.request.qs()), {
 *   allowed: ['name', 'age', 'posts.title'],
 *   searchable: ['name'],
 *   fieldTypes: users.fieldTypes,
 * })
 * // → { data, meta: { total, perPage, currentPage, lastPage, firstPage } }
 * ```
 */
export function filterInMemory<T extends object>(
  collection: InMemoryCollection<T>,
  rows: Iterable<T>,
  input: FilterInput,
  config: FilterConfig,
): InMemoryPage<T> {
  const qb = collection.query(rows);
  const { page, size } = applyFilter(qb, input, config);
  return qb.paginate(page, size);
}

/**
 * The keyset (cursor) counterpart of {@link filterInMemory}: {@link applyCursor} over a fresh
 * builder (the primary key defaults to the collection's), then `buildCursorPage`. Keyset values
 * are read through the collection, so a virtual field or a to-one relation path works as a cursor
 * sort field.
 */
export function cursorInMemory<T extends object>(
  collection: InMemoryCollection<T>,
  rows: Iterable<T>,
  input: FilterInput & CursorParams,
  config: FilterConfig & { primaryKey?: string },
): CursorPage<T> {
  const qb = collection.query(rows);
  const cursorConfig: CursorConfig = {
    ...config,
    primaryKey: config.primaryKey ?? collection.primaryKey,
  };
  const resolved: ResolvedCursor = applyCursor(qb, input, cursorConfig);
  const fetched = qb.all();

  // buildCursorPage reads keyset values as plain properties; stand each row in with an object
  // carrying its keyset values (virtual fields and relation paths resolved), then map back.
  const originals = new Map<object, T>();
  const keyed = fetched.map((row) => {
    const values = resolved.keyset.map((k) => qb.read(row, k.field));
    const stand: Record<string, unknown> = {};
    resolved.keyset.forEach((k, i) => {
      setPath(stand, k.field, values[i]);
    });
    originals.set(stand, row);
    return stand;
  });
  const page = buildCursorPage(keyed, resolved);
  return { ...page, items: page.items.map((stand) => originals.get(stand) as T) };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let node = target;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (typeof next === 'object' && next !== null) node = next as Record<string, unknown>;
    else {
      const created: Record<string, unknown> = {};
      node[segment] = created;
      node = created;
    }
  }
  node[segments[segments.length - 1] as string] = value;
}
