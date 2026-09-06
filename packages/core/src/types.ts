import type { FieldAliases } from './field_aliases.js';
import type { FullTextSearchOptions, VectorDistanceMetric } from './lucid_adapter.js';
import type { ColumnFilter } from './operators.js';

/**
 * A field's classified value kind — mirrors `@adonis-agora/filter-client`'s `FieldTypeKind`.
 *
 * Lives here rather than next to the client codegen because it is no longer codegen-only: the same
 * declaration drives server-side value coercion (see {@link FilterConfig.fieldTypes}). Re-exported
 * from `generate_client.ts` for backwards compatibility.
 */
export type FilterFieldKind = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';

/** A sort directive: field + direction. */
export interface SortItem {
  field: string;
  direction: 'asc' | 'desc';
}

/** Context handed to a {@link ComputedSource} function — the root table alias. */
export interface ComputedContext {
  /**
   * The root table's SQL alias — for Lucid this is the model's table name (the
   * main table carries no generated alias), taken from {@link FilterConfig.table}.
   * A correlated subquery references the outer row through it, e.g.
   * `` ({ alias }) => `(SELECT COUNT(*) FROM posts WHERE posts.author_id = ${alias}.id)` ``.
   */
  alias: string;
}

/**
 * A dev-declared virtual/computed field's SQL source. Two forms:
 *
 * - **verbatim string** — inlined exactly as written (`"first || ' ' || last"`).
 *   No token substitution; a correlated subquery needing the outer alias must
 *   use the function form.
 * - **function** `({ alias }) => sql` — receives the root table alias
 *   ({@link ComputedContext}) so it can emit a correlated subquery referencing
 *   the outer row.
 *
 * SAFETY: the source is authored by the developer at declaration time, never by
 * the client. The client only references the declared alias name; its filter
 * VALUE is always a bound parameter. Only this dev expression is inlined.
 */
export type ComputedSource = string | ((ctx: ComputedContext) => string);

/** A map of computed-field alias → its dev-declared {@link ComputedSource}. */
export type ComputedFields = Record<string, ComputedSource>;

/**
 * Where a request's structured input is read from, for {@link resolveInputFromRequest}:
 *
 * - `'auto'` — query on reads (GET/HEAD), query+body (body wins) on writes.
 * - `'query'` / `'body'` — always that container.
 * - a dot-path (e.g. `'body.filters'`) — the nested object at that path.
 * - a function — a custom extractor receiving the raw request.
 */
export type InputSource =
  | 'auto'
  | 'query'
  | 'body'
  | (string & {})
  | ((req: unknown) => Record<string, unknown> | undefined);

/**
 * How incoming field-name keys are normalized before matching against the
 * allow-list — a built-in case transform or a custom mapping function.
 */
export type InputNormalizer = 'camelCase' | 'snakeCase' | ((key: string) => string);

/**
 * A group-by-count aggregation request: the distinct values of `field` with counts, over the
 * rows the active filters select. `limit` bounds the rows (highest count first — tag cardinality
 * grows with the data, so the unbounded answer is a listing); `offset` pages that bound;
 * `search` narrows to values containing the text, server-side, so a rare value outside the first
 * page stays reachable by typing.
 */
export interface GroupByCountRequest {
  field: string;
  limit?: number | undefined;
  offset?: number | undefined;
  search?: string | undefined;
}

/** Bounds for a group-by-count answer: how many group rows come back, from where, matching what. */
export interface GroupByCountOptions {
  limit?: number | undefined;
  offset?: number | undefined;
  /** Narrow to groups whose value contains this text (case-insensitive). */
  search?: string | undefined;
}

/**
 * The parsed, structured input a {@link applyFilter} call consumes — produced by
 * {@link parseFilterRequest} from a request query string, or built directly.
 */
export interface FilterInput {
  /** Column filter conditions (with optional AND/OR composition). */
  filters?: ColumnFilter[];
  /** Sort directives, applied in order. */
  sort?: SortItem[];
  /**
   * Select DISTINCT values of the given field(s) — the active filters, search,
   * sort and pagination still apply. Useful for populating a filter dropdown
   * with the distinct values of a column. Fields are alias-resolved and checked
   * against {@link FilterConfig.allowed} exactly like a `where` field; unknown
   * fields are dropped (or rejected under {@link FilterConfig.throwOnInvalid}).
   */
  distinct?: string[];
  /**
   * Free-text search term. Routed through Postgres tsvector full-text search
   * when the policy declares {@link FilterConfig.fullText}, otherwise a portable
   * ILIKE scan across {@link FilterConfig.searchable}.
   */
  search?: string;
  /** 1-based page number for offset pagination. */
  page?: number;
  /** Page size for offset pagination. */
  size?: number;
  /**
   * A group-by-count aggregation replacing entity-row output: the distinct values of one field
   * with counts — what populates a filter dropdown. Parsed from the `groupByCount[field]`,
   * `groupByCount[limit]`, `groupByCount[offset]` and `groupByCount[search]` params the client
   * builder emits.
   */
  groupByCount?: GroupByCountRequest;
  /**
   * A query embedding to rank rows by pgvector *similarity* (distinct from the
   * text `search` above). Applied only when the policy declares a similarity
   * column (see {@link FilterConfig.vectorSimilarity}) — ignored otherwise, so
   * non-similarity requests are unchanged. Typically the controller computes
   * this from an embedding service, not the query string.
   */
  vectorSimilarity?: readonly number[];
}

/**
 * Declares a Postgres tsvector full-text search on a policy — the primary
 * `search` path when set. The request's `search` string is matched against the
 * configured document via `websearch_to_tsquery`, optionally ranked by
 * `ts_rank`. Omitting `column`-related fields is a compile error; a policy
 * without this config falls back to the ILIKE {@link FilterConfig.searchable}
 * scan. Additive — carries the same shape as {@link FullTextSearchOptions}
 * minus the per-request `query`.
 */
export type FullTextSearchConfig = Omit<FullTextSearchOptions, 'query'>;

/**
 * Declares a pgvector **embedding similarity** ordering on a policy — distinct
 * from full-text `search`. When a request also carries a query embedding
 * ({@link FilterInput.vectorSimilarity}), the runner ranks rows by ascending
 * distance to it. Additive — a policy without this behaves exactly as before.
 */
export interface VectorSimilarityConfig {
  /** The pgvector column ranked against the query embedding (e.g. `'embedding'`). */
  column: string;
  /** Distance metric → pgvector operator. Default `'cosine'` (`<=>`). */
  metric?: VectorDistanceMetric;
  /** Optional max-distance filter — drop rows farther than this from the embedding. */
  threshold?: number;
  /** Optional top-K truncation — keep only the K nearest rows. */
  topK?: number;
}

/**
 * An allow-list of field names — the security boundary for filter/sort. One of:
 *
 * - `'*'` — allow any field (use with care);
 * - `string[]` — allow exactly these field names;
 * - a predicate `(field) => boolean` — allow fields for which it returns true.
 *   The predicate form lets a policy express rules a flat list can't (e.g.
 *   relation-path whitelisting with a depth cap). It is evaluated against the
 *   already alias-resolved target field, never the client-facing alias key.
 */
export type AllowList = '*' | string[] | ((field: string) => boolean);

/**
 * Per-call filter policy. The allow-lists are the security boundary: only fields
 * named here can be filtered/sorted/searched, so client input can never probe
 * arbitrary columns.
 */
export interface FilterConfig {
  /** Columns clients may filter on. `'*'` allows any (use with care). */
  allowed: AllowList;
  /** Columns clients may sort on. Defaults to {@link FilterConfig.allowed}. */
  sortable?: AllowList;
  /**
   * Columns the free-text `search` term scans with a portable ILIKE — the
   * default search path when {@link FilterConfig.fullText} is not set.
   */
  searchable?: string[];
  /**
   * Declared column value kinds, keyed by field. A declared field has its filter value coerced to
   * that kind; a value that can't be coerced is treated exactly like a disallowed field (dropped,
   * or thrown under {@link FilterConfig.throwOnInvalid}). Guards the column from an uncastable
   * value that Postgres would otherwise reject at query time as a 500. Undeclared fields are
   * passed through uncoerced.
   */
  fieldTypes?: Readonly<Record<string, { kind?: FilterFieldKind }>>;
  /**
   * Opt-in Postgres tsvector full-text search. When set, the request `search`
   * string routes through `websearch_to_tsquery`/`@@` (and optional `ts_rank`)
   * instead of the ILIKE {@link FilterConfig.searchable} scan. Omitted → ILIKE.
   */
  fullText?: FullTextSearchConfig;
  /** Default page size when none is given. Default 25. */
  defaultSize?: number;
  /** Hard cap on page size. Default 100. */
  maxSize?: number;
  /** Throw `InvalidColumnFilterError` on a disallowed/invalid field instead of dropping it. Default false (drop). */
  throwOnInvalid?: boolean;
  /**
   * Declarative field-name remapping applied to filter and sort fields BEFORE
   * allow-listing — an alias key resolves to its target column, which is what
   * the allow-list, validation and query builder then see. Aliases do not
   * cascade. See {@link resolveFieldAlias}.
   */
  aliases?: FieldAliases;
  /**
   * Opt-in pgvector embedding-similarity ordering (distinct from text `search`).
   * When set and the request carries a query embedding
   * ({@link FilterInput.vectorSimilarity}), rows are ranked nearest-first by
   * distance to it. Omitted → no similarity ordering (default).
   */
  vectorSimilarity?: VectorSimilarityConfig;
  /**
   * Virtual/computed fields — a map of alias → dev-declared SQL expression
   * ({@link ComputedSource}). A declared alias becomes filterable and sortable
   * as if it were a real column; its declaration IS its allow-list (computed
   * fields bypass the column `allowed`/`sortable` lists — they are not real
   * columns). The client value is always parameterized; only the dev expression
   * is inlined.
   */
  computed?: ComputedFields;
  /**
   * The root table's SQL alias, surfaced to {@link ComputedSource} functions as
   * {@link ComputedContext.alias}. For Lucid this is the model's table name.
   * Required for function-form computed fields (and to-many aggregate fields)
   * whose correlated subqueries must reference the outer row.
   */
  table?: string;
}
