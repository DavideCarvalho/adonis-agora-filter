import { escapeLike } from './escape-like.js';
import type { ColumnFilter, FilterOperator } from './operators.js';
import type { ComputedContext, ComputedSource, GroupByCountOptions, SortItem } from './types.js';
import { normalizeOperator } from './validate-column-filter.js';

/**
 * The structural subset of a Lucid `ModelQueryBuilder` / `DatabaseQueryBuilder`
 * the adapter drives. An `@adonisjs/lucid` query builder satisfies it — declared
 * locally so the adapter never hard-imports Lucid (and stays unit-testable with a
 * recording mock). The nested-callback `where`/`orWhere` overloads model Lucid's
 * grouping closures used for AND/OR composition.
 */
export interface QueryBuilderLike {
  where(callback: (qb: QueryBuilderLike) => void): QueryBuilderLike;
  where(column: string, value: unknown): QueryBuilderLike;
  where(column: string, operator: string, value: unknown): QueryBuilderLike;
  orWhere(callback: (qb: QueryBuilderLike) => void): QueryBuilderLike;
  /**
   * Constrain the query to rows whose `relation` has at least one related row
   * matching the nested conditions — Lucid's `whereHas`. Used to translate a
   * dotted relation-path filter (`posts.title = x`) into a real subquery
   * (`whereHas('posts', (q) => q.where('title', x))`) instead of a dotted
   * column reference. The recording mock implements it so relation translation
   * stays unit-testable.
   *
   * `relation` is `any`, not `string`, and that is load-bearing: Lucid types its
   * own `whereHas` as `<Name extends ExtractModelRelations<Model>>(relation: Name, ...)`
   * — a union of the model's *literal* relation names. `string` is not assignable
   * to that union, so declaring `relation: string` here makes every real Lucid
   * builder fail to satisfy this interface, and TS reports the failure against
   * `where` (the first member it tries), which sends you hunting in the wrong
   * place. Widening the member to optional does NOT help: an optional member
   * that is present is still checked. Since the parameter must accept the
   * `string` the adapter passes AND be assignable to each model's relation-name
   * union, `any` is the only type that works.
   */
  // biome-ignore lint/suspicious/noExplicitAny: see above — `string` here makes every real Lucid builder fail to satisfy this interface. Guarded by test/types/lucid_compat.types.ts.
  whereHas(relation: any, callback: (qb: QueryBuilderLike) => void): QueryBuilderLike;
  whereNot(column: string, value: unknown): QueryBuilderLike;
  whereIn(column: string, values: unknown[]): QueryBuilderLike;
  whereNotIn(column: string, values: unknown[]): QueryBuilderLike;
  whereNull(column: string): QueryBuilderLike;
  whereNotNull(column: string): QueryBuilderLike;
  whereBetween(column: string, range: [unknown, unknown]): QueryBuilderLike;
  whereNotBetween(column: string, range: [unknown, unknown]): QueryBuilderLike;
  whereILike(column: string, value: string): QueryBuilderLike;
  orWhereILike(column: string, value: string): QueryBuilderLike;
  orderBy(column: string, direction: 'asc' | 'desc'): QueryBuilderLike;
  /**
   * Project columns — Lucid's `select`. Optional on the seam: only aggregations need it
   * (entity-row listings select whole rows), so a minimal custom implementation can omit it
   * until it serves a `groupByCount`.
   */
  select?: (...columns: string[]) => unknown;
  /**
   * Aggregate rows — Lucid's `count`. Optional, same reason as {@link select}: only the
   * group-by-count aggregation calls it, with a `'* AS count'`-style argument.
   */
  count?: (column: string) => unknown;
  /**
   * Group rows — Lucid's `groupBy`. Optional, same reason: only the group-by-count aggregation
   * calls it.
   */
  groupBy?: (...columns: string[]) => unknown;
  /**
   * Skip rows — Lucid's `offset`. Optional: entity-row pagination goes through Lucid's own
   * `paginate`, so only the group-by-count aggregation pages with limit/offset directly.
   */
  offset?: (n: number) => unknown;
  /**
   * Add a raw SQL predicate with positional bindings — Lucid's `whereRaw`. The
   * escape hatch for constraints no structured method can express, used here for
   * pgvector similarity (`embedding <=> ?::vector < ?`). `sql` is server-authored
   * (never client text); every user value travels as a `?` binding. Optional on
   * real Lucid builders; the recording mock implements it so vector translation
   * stays unit-testable and the package stays framework-free.
   */
  whereRaw(sql: string, bindings?: readonly unknown[]): QueryBuilderLike;
  /**
   * Add a raw SQL ordering with positional bindings — Lucid's `orderByRaw`. Used
   * to order by a pgvector distance expression (`embedding <=> ?::vector asc`),
   * which no column-name `orderBy` can express. Same seam contract as
   * {@link QueryBuilderLike.whereRaw}.
   */
  orderByRaw(sql: string, bindings?: readonly unknown[]): QueryBuilderLike;
  /**
   * Restrict the query to DISTINCT tuples of `columns` — Lucid's `distinct`.
   * Used by {@link applyDistinct} to execute a client `.distinct(...)`
   * projection. The columns are the already alias-resolved, allow-listed field
   * names; a variadic column list matches Lucid's signature exactly. Optional on
   * real Lucid builders; the recording mock implements it so the translation
   * stays unit-testable.
   */
  distinct(...columns: string[]): QueryBuilderLike;
  limit(count: number): QueryBuilderLike;
}

/**
 * A pgvector distance metric → the operator applied between the vector column and
 * the query embedding:
 *
 * - `'cosine'` — cosine distance, pgvector `<=>` (default; the usual choice for
 *   normalized embeddings).
 * - `'l2'` — Euclidean / L2 distance, pgvector `<->`.
 * - `'innerProduct'` — negative inner product, pgvector `<#>`.
 *
 * All three are *distance* operators (smaller = more similar), so nearest-first
 * ranking is always ascending order.
 */
export type VectorDistanceMetric = 'cosine' | 'l2' | 'innerProduct';

/** pgvector distance operator for each {@link VectorDistanceMetric}. */
const VECTOR_OPERATORS: Record<VectorDistanceMetric, string> = {
  cosine: '<=>',
  l2: '<->',
  innerProduct: '<#>',
};

/**
 * Options for {@link applyVectorSimilarity} — an **embedding similarity** ordering
 * (pgvector) against a `vector` column. This is DISTINCT from full-text search
 * ({@link applyFullTextSearch}): here a query *embedding* is ranked against the
 * column by a distance metric, optionally filtered by a distance threshold and
 * truncated to the top-K nearest rows. (Full-text search matches a text *query
 * string* against a tsvector document.)
 */
export interface VectorSimilarityOptions {
  /** The pgvector column to compare the query embedding against (e.g. `'embedding'`). */
  column: string;
  /** The query embedding — the vector rows are ranked by similarity to. */
  vector: readonly number[];
  /** Distance metric → pgvector operator. Default `'cosine'` (`<=>`). */
  metric?: VectorDistanceMetric;
  /**
   * Keep only rows whose distance to the query embedding is strictly below this
   * value (a `WHERE embedding <=> ? < threshold`). Omitted → no distance filter.
   */
  threshold?: number;
  /**
   * Limit the result to the K nearest rows (a `LIMIT`). Omitted → no limit is
   * added here (the caller's pagination still applies).
   */
  topK?: number;
  /**
   * Order by ascending distance (nearest first). Default `true`. Set `false` to
   * apply only a threshold filter without changing the query's ordering.
   */
  order?: boolean;
}

/** A safe SQL identifier: an unquoted column, optionally `table.column` qualified. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Quote a (possibly dotted) identifier for Postgres, one segment at a time. */
function quoteColumn(column: string): string {
  return column
    .split('.')
    .map((seg) => `"${seg}"`)
    .join('.');
}

/**
 * Serialize a numeric embedding to a pgvector literal (`[1,2,3]`). Returns `null`
 * for an empty vector (a no-op signal). Throws on a non-finite component so a bad
 * embedding fails loudly rather than emitting `NaN`/`Infinity` into SQL.
 */
function serializeVector(vector: readonly number[]): string | null {
  if (vector.length === 0) return null;
  for (const n of vector) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new TypeError('Vector search embedding must contain only finite numbers.');
    }
  }
  return `[${vector.join(',')}]`;
}

/**
 * Apply an **embedding similarity** ordering (pgvector) to a Lucid query builder.
 *
 * This is *not* full-text search — it ranks rows by distance between a stored
 * embedding column and a query *embedding vector*. For matching a text query
 * string, use {@link applyFullTextSearch} instead.
 *
 * pgvector expresses similarity through raw distance operators (`<=>`, `<->`,
 * `<#>`) that no structured query-builder method covers, so this drives the
 * adapter's raw seam ({@link QueryBuilderLike.whereRaw}/`orderByRaw`) with the
 * query embedding passed as a positional binding — the column name is the only
 * interpolated fragment, and it is validated against a strict identifier charset
 * so it can never carry injection. The distance expression is
 * `<column> <op> ?::vector`, cast to `vector` so a text binding compares against
 * the column.
 *
 * A no-op when the embedding is empty. When `order` is not `false`, rows are
 * ordered nearest-first (ascending distance); `threshold` adds a max-distance
 * filter; `topK` truncates to the K nearest.
 */
export function applyVectorSimilarity(qb: QueryBuilderLike, opts: VectorSimilarityOptions): void {
  const literal = serializeVector(opts.vector);
  if (literal === null) return;
  if (!SAFE_IDENTIFIER.test(opts.column)) {
    throw new TypeError(`Invalid vector column name: ${JSON.stringify(opts.column)}`);
  }

  const operator = VECTOR_OPERATORS[opts.metric ?? 'cosine'];
  const distance = `${quoteColumn(opts.column)} ${operator} ?::vector`;

  if (opts.threshold !== undefined) {
    qb.whereRaw(`${distance} < ?`, [literal, opts.threshold]);
  }
  if (opts.order !== false) {
    qb.orderByRaw(`${distance} asc`, [literal]);
  }
  if (opts.topK !== undefined) {
    qb.limit(opts.topK);
  }
}

/**
 * Options for {@link applyFullTextSearch} — a Postgres **tsvector full-text
 * search** (the parity behavior of the NestJS reference's `applyVectorSearch`).
 * The user query string is matched against a text-search document with
 * `websearch_to_tsquery` and the `@@` operator, optionally ranked by `ts_rank`.
 *
 * This is DISTINCT from {@link VectorSimilarityOptions} (embedding similarity):
 * here the input is arbitrary *text*, tokenized by a language config; there the
 * input is a numeric *embedding vector*.
 */
export interface FullTextSearchOptions {
  /**
   * The user's raw search text. Always passed as a positional binding to
   * `websearch_to_tsquery` — never interpolated into SQL. A no-op when blank.
   */
  query: string;
  /**
   * The document to match against. Either a single precomputed `tsvector`
   * column (matched directly with `@@`), or one-or-more plain text columns that
   * are wrapped in `to_tsvector(<language>, ...)` at query time (see
   * {@link FullTextSearchOptions.columnKind}). Passing multiple columns implies
   * `'text'`.
   */
  column: string | readonly string[];
  /**
   * Postgres text-search config / language used for both `websearch_to_tsquery`
   * and any `to_tsvector` wrapping (e.g. `'english'`, `'simple'`). Default
   * `'english'`. Validated against the strict identifier charset before it is
   * spliced into SQL.
   */
  language?: string;
  /**
   * Add relevance ordering for matched rows (`ORDER BY ts_rank(...) DESC`). Off
   * by default because it changes the query's default ordering; opt in for
   * best-match-first results.
   */
  rank?: boolean;
  /**
   * How {@link FullTextSearchOptions.column} is treated:
   * - `'tsvector'` — a precomputed `tsvector` column, matched directly (`col @@ ...`);
   * - `'text'` — plain text column(s), wrapped in `to_tsvector(<language>, col ...)`.
   *
   * Defaults to `'tsvector'` for a single column and `'text'` when multiple
   * columns are given.
   */
  columnKind?: 'tsvector' | 'text';
}

/**
 * Apply a Postgres **tsvector full-text search** to a Lucid query builder — the
 * parity port of the NestJS reference's `applyVectorSearch` (tsvector), NOT the
 * embedding similarity {@link applyVectorSimilarity}.
 *
 * Injection-safety: the user `query` string ALWAYS travels as a positional
 * binding (`websearch_to_tsquery('<lang>', ?)`); it is never interpolated.
 * `websearch_to_tsquery` (not the raw `to_tsquery`) parses arbitrary user input
 * — multi-word text, `"quoted phrases"`, `-exclude`, `or` — without throwing a
 * syntax error. The only spliced fragments are the column name(s) and the
 * language config, each validated against the strict identifier charset
 * ({@link SAFE_IDENTIFIER}) before use, so neither can carry injection.
 *
 * The match predicate is `<document> @@ websearch_to_tsquery('<lang>', ?)` where
 * `<document>` is either the tsvector column directly, or
 * `to_tsvector('<lang>', coalesce(col1,'') || ' ' || coalesce(col2,''))` for
 * text columns. When `rank` is set, rows are additionally ordered by descending
 * `ts_rank(<document>, websearch_to_tsquery('<lang>', ?))`. A no-op for a blank
 * query.
 */
export function applyFullTextSearch(qb: QueryBuilderLike, opts: FullTextSearchOptions): void {
  const query = opts.query.trim();
  if (query.length === 0) return;

  const columns = Array.isArray(opts.column) ? opts.column : [opts.column as string];
  if (columns.length === 0) return;
  for (const col of columns) {
    if (!SAFE_IDENTIFIER.test(col)) {
      throw new TypeError(`Invalid full-text search column name: ${JSON.stringify(col)}`);
    }
  }

  const language = opts.language ?? 'english';
  if (!SAFE_IDENTIFIER.test(language)) {
    throw new TypeError(`Invalid full-text search language: ${JSON.stringify(language)}`);
  }

  // The user query is a positional binding; only the validated language splices in.
  const tsquery = `websearch_to_tsquery('${language}', ?)`;

  // A precomputed tsvector column is matched directly; text columns are tokenized
  // at query time via to_tsvector, coalescing NULLs so a null column can't null
  // the whole document.
  const kind = opts.columnKind ?? (columns.length > 1 ? 'text' : 'tsvector');
  const document =
    kind === 'text'
      ? `to_tsvector('${language}', ${columns
          .map((c) => `coalesce(${quoteColumn(c)}, '')`)
          .join(" || ' ' || ")})`
      : quoteColumn(columns[0]!);

  qb.whereRaw(`${document} @@ ${tsquery}`, [query]);

  if (opts.rank) {
    qb.orderByRaw(`ts_rank(${document}, ${tsquery}) desc`, [query]);
  }
}

/** Wrap a value as a LIKE pattern with escaped metacharacters. */
function like(value: unknown, kind: 'contains' | 'startsWith' | 'endsWith'): string {
  const v = escapeLike(String(value));
  if (kind === 'startsWith') return `${v}%`;
  if (kind === 'endsWith') return `%${v}`;
  return `%${v}%`;
}

/**
 * Apply a single (leaf) column filter to the builder.
 *
 * A dotted `field` is a **relation path** (`posts.title`, `posts.comments.body`):
 * every segment but the last is a relation hop, translated into a nested Lucid
 * `whereHas` subquery, and the final segment is the bare column the operator
 * lands on inside the innermost relation query — so `posts.title = x` becomes
 * `whereHas('posts', (q) => q.where('title', x))`. Depth is already bounded by
 * the spec's `maxDepth` allow-list before a filter reaches the adapter, so this
 * only translates paths that were explicitly whitelisted. A non-dotted `field`
 * is a plain base column and takes the operator switch directly.
 */
function applyLeaf(qb: QueryBuilderLike, field: string, operator: FilterOperator, value: unknown) {
  const dot = field.indexOf('.');
  if (dot !== -1) {
    const relation = field.slice(0, dot);
    const rest = field.slice(dot + 1);
    qb.whereHas(relation, (sub) => applyLeaf(sub, rest, operator, value));
    return;
  }
  switch (operator) {
    case 'equals':
      qb.where(field, value);
      break;
    case 'notEquals':
      qb.whereNot(field, value);
      break;
    case 'contains':
    case 'iContains':
      qb.whereILike(field, like(value, 'contains'));
      break;
    case 'startsWith':
      qb.whereILike(field, like(value, 'startsWith'));
      break;
    case 'endsWith':
      qb.whereILike(field, like(value, 'endsWith'));
      break;
    case 'notContains':
      qb.where((sub) => sub.whereNot(field, value).whereNotNull(field));
      break;
    case 'gt':
      qb.where(field, '>', value);
      break;
    case 'gte':
      qb.where(field, '>=', value);
      break;
    case 'lt':
      qb.where(field, '<', value);
      break;
    case 'lte':
      qb.where(field, '<=', value);
      break;
    case 'between':
      qb.whereBetween(field, value as [unknown, unknown]);
      break;
    case 'notBetween':
      qb.whereNotBetween(field, value as [unknown, unknown]);
      break;
    case 'in':
    case 'isAnyOf':
      qb.whereIn(field, value as unknown[]);
      break;
    case 'notIn':
      qb.whereNotIn(field, value as unknown[]);
      break;
    case 'isNull':
    case 'notExists':
      qb.whereNull(field);
      break;
    case 'isNotNull':
    case 'exists':
      qb.whereNotNull(field);
      break;
    case 'isEmpty':
      qb.where(field, '');
      break;
    case 'isNotEmpty':
      qb.whereNot(field, '');
      break;
  }
}

/**
 * Apply one {@link ColumnFilter} (possibly an AND/OR group) to a builder. A leaf
 * is a single condition; `AND`/`OR` recurse into a grouped sub-builder so the
 * boolean structure maps to Lucid's nested `where`/`orWhere` closures.
 */
function applyOne(qb: QueryBuilderLike, filter: ColumnFilter): void {
  const op = normalizeOperator(filter.operator);
  const hasField = typeof filter.field === 'string' && filter.field.length > 0;

  qb.where((group) => {
    if (hasField) {
      applyLeaf(group, filter.field, op, filter.value);
    }
    if (filter.AND) {
      for (const sub of filter.AND) {
        group.where((g) => applyOne(g, sub));
      }
    }
    if (filter.OR) {
      for (const sub of filter.OR) {
        group.orWhere((g) => applyOne(g, sub));
      }
    }
  });
}

/** Apply an array of column filters (combined with AND) to a Lucid query builder. */
export function applyColumnFilters(qb: QueryBuilderLike, filters: ColumnFilter[]): void {
  for (const filter of filters) {
    applyOne(qb, filter);
  }
}

/** Apply sort directives to a Lucid query builder, in order. */
export function applySort(qb: QueryBuilderLike, sorts: SortItem[]): void {
  for (const sort of sorts) {
    qb.orderBy(sort.field, sort.direction);
  }
}

/**
 * Apply a DISTINCT projection over `columns` to a Lucid query builder — the
 * executable half of the client's `.distinct(...)` (which until now the server
 * silently ignored). A no-op for an empty list. The columns are the
 * already-validated, alias-resolved field names (the runner resolves aliases and
 * enforces the allow-list before calling this), so nothing client-controlled is
 * interpolated: Lucid quotes each identifier itself.
 */
export function applyDistinct(qb: QueryBuilderLike, columns: string[]): void {
  if (columns.length === 0) return;
  qb.distinct(...columns);
}

/**
 * Terminal group-by-count aggregation over one column:
 * `SELECT <col> AS value, COUNT(*) AS count … GROUP BY <col>`, most groups first —
 * what populates a filter dropdown. `column` must already be validated (allow-listed): it is
 * interpolated as an identifier, while every client VALUE rides a positional binding.
 *
 * Fixed ordering (count desc, value asc) is load-bearing, not cosmetic: the answer is pageable,
 * and paging an unordered listing repeats and skips rows.
 *
 * Requires a builder carrying the optional aggregation seam (`select`/`count`/`groupBy`/`offset`);
 * throws a plain `Error` naming the missing method otherwise, so a minimal custom implementation
 * fails loudly instead of silently returning entity rows.
 */
export function applyGroupByCount(
  qb: QueryBuilderLike,
  column: string,
  opts: GroupByCountOptions = {},
): void {
  if (!qb.select || !qb.count || !qb.groupBy || !qb.offset) {
    throw new Error(
      'groupByCount needs a builder with select/count/groupBy/offset — the active one does not implement the aggregation seam.',
    );
  }
  qb.select(`${column} AS value`);
  qb.count('* AS count');
  const needle = opts.search?.trim();
  if (needle) {
    qb.whereRaw(`LOWER(??) LIKE ?`, [column, `%${escapeLike(needle.toLowerCase())}%`]);
  }
  qb.groupBy(column);
  qb.orderBy('count', 'desc');
  qb.orderBy(column, 'asc');
  if (opts.limit !== undefined) qb.limit(Math.max(0, opts.limit));
  if (opts.offset !== undefined) qb.offset(Math.max(0, opts.offset));
}

/**
 * Resolve a {@link ComputedSource} to its final SQL expression string. The
 * string form is verbatim; the function form is invoked with the root table
 * {@link ComputedContext} so it can splice the outer alias into a correlated
 * subquery. Either way the result is dev-authored — never client text.
 */
export function resolveComputedExpression(source: ComputedSource, alias: string): string {
  return typeof source === 'function' ? source({ alias } satisfies ComputedContext) : source;
}

/**
 * Apply a filter on a dev-declared **computed field** to a Lucid query builder.
 *
 * The already-resolved `expression` is inlined as the raw left-hand side (it is
 * dev-authored — a verbatim string or a function's output — never client text);
 * the client's filter VALUE always rides through as a positional `?` binding,
 * exactly the injection-safety contract real-column filters have. The whole
 * expression is parenthesized so a compound source
 * (`first || ' ' || last`, `(SELECT …)`) composes under the operator without a
 * precedence surprise.
 */
export function applyComputedField(
  qb: QueryBuilderLike,
  expression: string,
  filter: ColumnFilter,
): void {
  const op = normalizeOperator(filter.operator);
  const value = filter.value;
  const lhs = `(${expression})`;
  switch (op) {
    case 'equals':
      qb.whereRaw(`${lhs} = ?`, [value]);
      break;
    case 'notEquals':
      qb.whereRaw(`${lhs} <> ?`, [value]);
      break;
    case 'gt':
      qb.whereRaw(`${lhs} > ?`, [value]);
      break;
    case 'gte':
      qb.whereRaw(`${lhs} >= ?`, [value]);
      break;
    case 'lt':
      qb.whereRaw(`${lhs} < ?`, [value]);
      break;
    case 'lte':
      qb.whereRaw(`${lhs} <= ?`, [value]);
      break;
    case 'in':
    case 'isAnyOf': {
      const values = Array.isArray(value) ? value : [];
      // An empty IN list matches nothing — emit an always-false predicate rather
      // than invalid `IN ()` SQL.
      if (values.length === 0) qb.whereRaw('1 = 0');
      else qb.whereRaw(`${lhs} in (${values.map(() => '?').join(', ')})`, values);
      break;
    }
    case 'notIn': {
      const values = Array.isArray(value) ? value : [];
      if (values.length === 0) qb.whereRaw('1 = 1');
      else qb.whereRaw(`${lhs} not in (${values.map(() => '?').join(', ')})`, values);
      break;
    }
    case 'between': {
      const [low, high] = value as [unknown, unknown];
      qb.whereRaw(`${lhs} between ? and ?`, [low, high]);
      break;
    }
    case 'notBetween': {
      const [low, high] = value as [unknown, unknown];
      qb.whereRaw(`${lhs} not between ? and ?`, [low, high]);
      break;
    }
    case 'contains':
    case 'iContains':
      qb.whereRaw(`${lhs} ilike ?`, [like(value, 'contains')]);
      break;
    case 'notContains':
      qb.whereRaw(`(${lhs} not ilike ? or ${lhs} is null)`, [like(value, 'contains')]);
      break;
    case 'startsWith':
      qb.whereRaw(`${lhs} ilike ?`, [like(value, 'startsWith')]);
      break;
    case 'endsWith':
      qb.whereRaw(`${lhs} ilike ?`, [like(value, 'endsWith')]);
      break;
    case 'isNull':
    case 'notExists':
      qb.whereRaw(`${lhs} is null`);
      break;
    case 'isNotNull':
    case 'exists':
      qb.whereRaw(`${lhs} is not null`);
      break;
    case 'isEmpty':
      qb.whereRaw(`${lhs} = ?`, ['']);
      break;
    case 'isNotEmpty':
      qb.whereRaw(`${lhs} <> ?`, ['']);
      break;
  }
}

/**
 * Append an ORDER BY on a dev-declared **computed field** to a Lucid query
 * builder via `orderByRaw`. Uses append semantics (like `orderBy`) so a computed
 * sort composes with real-column sorts in request order. The expression is
 * dev-authored and parenthesized; the direction is a validated literal.
 */
export function applyComputedSort(
  qb: QueryBuilderLike,
  expression: string,
  direction: 'asc' | 'desc',
): void {
  qb.orderByRaw(`(${expression}) ${direction === 'desc' ? 'desc' : 'asc'}`);
}

/**
 * Apply a keyset (cursor) seek predicate to a Lucid query builder for row-value
 * comparison across the keyset columns.
 *
 * Given a keyset (the active sort columns plus a primary-key tiebreaker, each
 * with a direction) and a boundary row's values, this constrains the query to
 * rows strictly *after* the boundary in keyset order. The row-value comparison
 * is expanded into the portable "OR of AND tiers" form that works across all
 * SQL dialects:
 *
 * ```text
 *   (c0 OP0 v0)
 *   OR (c0 = v0 AND c1 OP1 v1)
 *   OR (c0 = v0 AND c1 = v1 AND c2 OP2 v2) ...
 * ```
 *
 * where `OPi` is `>` for an `asc` column and `<` for a `desc` column. The whole
 * predicate is wrapped in one AND-group so it composes with any existing
 * `where` conditions. A no-op when the keyset is empty or `values` does not line
 * up positionally with it.
 */
export function applyKeyset(qb: QueryBuilderLike, keyset: SortItem[], values: unknown[]): void {
  if (keyset.length === 0 || values.length !== keyset.length) return;

  qb.where((outer) => {
    for (let tier = 0; tier < keyset.length; tier++) {
      const buildTier = (inner: QueryBuilderLike) => {
        // Equality on every column before this tier.
        for (let i = 0; i < tier; i++) {
          inner.where(keyset[i]!.field, values[i]);
        }
        const cmp = keyset[tier]!.direction === 'asc' ? '>' : '<';
        inner.where(keyset[tier]!.field, cmp, values[tier]);
      };
      // First tier seeds the group with AND; the rest OR onto it.
      if (tier === 0) outer.where(buildTier);
      else outer.orWhere(buildTier);
    }
  });
}

/** Apply a free-text ILIKE search across `columns` (OR-combined) to a Lucid query builder. */
export function applySearch(qb: QueryBuilderLike, term: string, columns: string[]): void {
  if (columns.length === 0 || term.length === 0) return;
  const pattern = like(term, 'contains');
  qb.where((group) => {
    for (const column of columns) {
      group.orWhereILike(column, pattern);
    }
  });
}
