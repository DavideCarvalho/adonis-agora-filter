import type { LucidModelLike } from './aggregate.js';
import type { FieldAliases } from './field_aliases.js';
import type {
  FilterableInput,
  RelationColumns,
  RelationSpec,
  TenantScopeSpec,
} from './filter_spec.js';
import type { FilterFieldTypeInfo } from './generate_client.js';
import type { QueryBuilderLike } from './lucid_adapter.js';
import type { ColumnFilter } from './operators.js';
import type {
  ComputedFields,
  FilterInput,
  FullTextSearchConfig,
  SortItem,
  VectorSimilarityConfig,
} from './types.js';

/**
 * The class-authoring form of a filter — the counterpart of `defineFilter`, in the shape
 * AdonisJS developers already know from `adonis-lucid-filter`: **a method per request key**,
 * with the query builder on `this.$query`.
 *
 * A method's name IS the key it owns. `?filter[fullName]=silva` calls `fullName('silva')`, and
 * because you wrote the method, the key needs no allow-list entry — writing the code is the
 * decision to expose it. Plain columns that need no custom SQL stay declarative: list them in
 * `static filterable` and the runner applies the operators, search, sort and pagination for you.
 *
 * The class is resolved through the IoC container, so an `@inject()`ed constructor works: a
 * filter can depend on a service exactly like a controller does.
 *
 * ```ts
 * @inject()
 * export default class UserFilter extends BaseModelFilter {
 *   declare $query: ModelQueryBuilderContract<typeof User>
 *
 *   constructor(private tenants: TenantsService) { super() }
 *
 *   static model = User
 *   static filterable = ['name', 'email', 'status']
 *   static sortable = ['name', 'createdAt']
 *   static searchable = ['name', 'email']
 *
 *   // always applied, before anything the request asked for
 *   setup() {
 *     this.$query.where('tenantId', this.tenants.current(this.$ctx))
 *   }
 *
 *   // the one key this class owns itself
 *   fullName(value: string) {
 *     this.$query.whereILike('full_name', `%${value}%`)
 *   }
 * }
 * ```
 */
export abstract class BaseModelFilter<Q extends QueryBuilderLike = QueryBuilderLike> {
  /**
   * The query builder being filtered — the one the caller created. Methods mutate it directly;
   * nothing here constructs or executes a query.
   */
  declare $query: Q;

  /** The raw decoded request input the dispatch reads (query string, or the body on a POST). */
  declare $input: Readonly<Record<string, unknown>>;

  /** The parsed input — filters, sort, search, pagination — after the wire format is read. */
  declare $parsed: FilterInput;

  /** The request context handed to the call (a real `HttpContext` in an AdonisJS app). */
  declare $ctx: unknown;

  // ── the declarative half: everything a plain column needs, without writing a method ──────────

  /** The owning Lucid model. Unlocks to-many aggregates and supplies the root table name. */
  static model?: LucidModelLike;
  /** Columns clients may filter on with the standard operators. `'*'` allows any base column. */
  static filterable?: FilterableInput;
  /** Columns clients may sort on. Defaults to `filterable`. */
  static sortable?: RelationColumns;
  /** Columns the free-text `search` term scans with a portable ILIKE. */
  static searchable?: string[];
  /** Whitelisted relations and the columns reachable through them. */
  static relations?: Record<string, RelationSpec>;
  /** Client-alias → target-field remapping. */
  static aliases?: FieldAliases;
  /** Virtual fields — alias → SQL expression. */
  static computed?: ComputedFields;
  /** Per-field value kinds, driving coercion and typed client codegen. */
  static fieldTypes?: Record<string, FilterFieldTypeInfo>;
  /** Opt-in Postgres tsvector search for the `search` term. */
  static fullText?: FullTextSearchConfig;
  /** Opt-in pgvector embedding-similarity ordering. */
  static vectorSimilarity?: VectorSimilarityConfig;
  /** Auto-scope a column to the tenant resolved from ctx (the declarative form of `setup`). */
  static tenant?: TenantScopeSpec;
  /** Server-declared filters always AND-combined with the request. */
  static defaultFilters?: ColumnFilter[];
  /** Sort applied when the request carries none. */
  static defaultSort?: SortItem[];
  /** Page size when the request asks for none. Default 25. */
  static defaultSize?: number;
  /** Hard cap on page size. Default 100. */
  static maxSize?: number;
  /** Max relation-path hops. Defaults to the deepest declared relation nesting. */
  static maxDepth?: number;
  /** Root table name — defaults to `model.table`. */
  static table?: string;
  /** Throw `InvalidColumnFilterError` on a disallowed field instead of dropping it. */
  static throwOnInvalid?: boolean;

  // ── dispatch controls (the `adonis-lucid-filter` knobs) ──────────────────────────────────────

  /** Method names that must never be dispatched from request input, whatever the key says. */
  static blacklist?: string[];
  /** Strip a trailing `Id` from an input key before looking for a method (`companyId` → `company`). */
  static dropId?: boolean;
  /** Match `snake_case` input keys against camelCase methods (`first_name` → `firstName`). Default true. */
  static camelCase?: boolean;

  /**
   * Runs on every filter call, before the request's own filters — the place for a scope the
   * client cannot relax (a tenant, a soft-delete guard, an ownership check).
   */
  setup?(): void | Promise<void>;

  /** The whole raw input, one key of it, or a fallback when the key is absent. */
  input(): Readonly<Record<string, unknown>>;
  input(key: string): unknown;
  input(key: string, fallback: unknown): unknown;
  input(key?: string, fallback?: unknown): unknown {
    if (key === undefined) return this.$input;
    return Object.hasOwn(this.$input, key) ? this.$input[key] : fallback;
  }
}
