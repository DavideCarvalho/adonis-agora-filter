import type {
  Base,
  EqValue,
  FieldsWithOp,
  FilterFieldTypes,
  OperatorsFor,
  OrderableFieldsOf,
  OrderingOps,
  StringFieldsOf,
  UnaryOf,
  ValueAt,
  ValueForOp,
} from './field-types.js';
import type { FilterQueryResult } from './filter-query-builder.js';
import { FilterQueryBuilder } from './filter-query-builder.js';
import type { FilterOperator } from './types.js';

/**
 * A type-safe wrapper interface over `FilterQueryBuilder` that restricts
 * field name arguments to the `Fields` union type.
 *
 * At runtime this is identical to `FilterQueryBuilder` — the typing is the
 * only difference. Zero runtime overhead.
 *
 * **Important:** This interface must mirror every public method of
 * `FilterQueryBuilder` so the cast in `filterQueryTyped()` is safe.
 */
export interface TypedFilterQueryBuilder<
  Fields extends string,
  M extends FilterFieldTypes<Fields> = Record<Fields, unknown>,
> {
  // ─── Core filter methods ────────────────────────────────────────────────

  // 1) Unary 2-arg (no value)
  where<K extends Fields>(field: K, operator: UnaryOf<ValueAt<M, K>>): this;
  // 2) Generic 3-arg: operator constrained to the field's set, value derived from (T, Op).
  //    For unknown-typed fields, OperatorsFor<unknown> is the full union and
  //    ValueForOp<unknown, Op> stays loose, so this overload is fully permissive —
  //    no separate `FilterOperator` fallback is needed (that fallback would defeat
  //    narrowing for *known* fields by swallowing every operator).
  //
  //    CAVEAT (scalar shorthand, see overload 3): on a string field, `where('name', 'gt')`
  //    does NOT flag `'gt'` as a misplaced operator — the 2-arg `(field, value)` shorthand
  //    matches first and swallows `'gt'` as an equals VALUE (a string is a valid EqValue).
  //    This is inherent to the value-shorthand overload, not a bug: there's no way to tell a
  //    string that happens to equal an operator name from an intended operator. Use the
  //    explicit 3-arg form (`where('name', 'equals', 'gt')`) when the value is operator-like.
  where<K extends Fields, Op extends OperatorsFor<ValueAt<M, K>>>(
    field: K,
    operator: Op,
    value: ValueForOp<ValueAt<M, K>, Op>,
  ): this;
  // 3) Value shorthand: scalar (auto-equals) or array (auto-in)
  where<K extends Fields>(field: K, value: EqValue<ValueAt<M, K>>): this;

  // add() is runtime-restricted to RANGE ops (validateAddOperator). For string/boolean
  // fields, Extract<OperatorsFor<T>, OrderingOps> = never → no valid operator (compile-time
  // surfacing of the runtime throw). Unknown-typed fields keep all four range ops.
  add<K extends Fields, Op extends Extract<OperatorsFor<ValueAt<M, K>>, OrderingOps>>(
    field: K,
    operator: Op,
    value: ValueForOp<ValueAt<M, K>, Op>,
  ): this;

  remove(field: Fields): this;

  // ─── Dynamic escape hatches (untyped field) ─────────────────────────────
  // Deliberately typed with a plain `string` field, NOT the `Fields` union:
  // these are the runtime-driven entry points for field names not known at
  // codegen time (AG-Grid column ids, user-built queries). The server's
  // allow-list remains the real security boundary.
  whereDynamic(field: string, operator: FilterOperator, value?: unknown): this;
  sortDynamic(field: string, direction?: 'asc' | 'desc'): this;

  // ─── Convenience methods ────────────────────────────────────────────────

  equals<K extends Fields>(field: K, value: EqValue<ValueAt<M, K>>): this;
  notEquals<K extends Fields>(field: K, value: EqValue<ValueAt<M, K>>): this;
  contains<K extends StringFieldsOf<M> & Fields>(field: K, value: string): this;
  in<K extends Fields>(field: K, values: Base<ValueAt<M, K>>[]): this;
  notIn<K extends Fields>(field: K, values: Base<ValueAt<M, K>>[]): this;
  between<K extends OrderableFieldsOf<M> & Fields>(
    field: K,
    low: Base<ValueAt<M, K>>,
    high: Base<ValueAt<M, K>>,
  ): this;
  gt<K extends OrderableFieldsOf<M> & Fields>(
    field: K,
    value: ValueForOp<ValueAt<M, K>, 'gt'>,
  ): this;
  gte<K extends OrderableFieldsOf<M> & Fields>(
    field: K,
    value: ValueForOp<ValueAt<M, K>, 'gte'>,
  ): this;
  lt<K extends OrderableFieldsOf<M> & Fields>(
    field: K,
    value: ValueForOp<ValueAt<M, K>, 'lt'>,
  ): this;
  lte<K extends OrderableFieldsOf<M> & Fields>(
    field: K,
    value: ValueForOp<ValueAt<M, K>, 'lte'>,
  ): this;
  // isNull/isNotNull are CommonUnary — valid for every field type — so they stay broad.
  isNull(field: Fields): this;
  isNotNull(field: Fields): this;
  // isEmpty/isNotEmpty are EmptyUnaryOps — only valid where OperatorsFor<T> includes them
  // (string/json/unknown). Gated to mirror the where()/add() narrowing; for unknown-typed
  // fields OperatorsFor<unknown> is the full union, so every field still qualifies.
  isEmpty(field: FieldsWithOp<M, 'isEmpty'> & Fields): this;
  isNotEmpty(field: FieldsWithOp<M, 'isNotEmpty'> & Fields): this;
  startsWith<K extends StringFieldsOf<M> & Fields>(field: K, value: string): this;
  endsWith<K extends StringFieldsOf<M> & Fields>(field: K, value: string): this;

  // ─── Range helpers (use add — accumulate) ───────────────────────────────

  addGte<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;
  addLte<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;
  addGt<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;
  addLt<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;

  // ─── Sort (typed) ──────────────────────────────────────────────────────

  sort(field: Fields, direction?: 'asc' | 'desc'): this;
  sortAsc(field: Fields): this;
  sortDesc(field: Fields): this;

  // ─── Distinct (typed) ───────────────────────────────────────────────────

  distinct(...fields: Fields[]): this;

  // ─── Non-field methods (passthrough) ────────────────────────────────────

  include(...relations: string[]): this;
  search(term: string): this;
  page(page: number, size?: number): this;
  or(callback: (builder: TypedFilterQueryBuilder<Fields, M>) => void): this;
  and(callback: (builder: TypedFilterQueryBuilder<Fields, M>) => void): this;
  set(key: string, value: unknown): this;
  clear(): this;

  // ─── Reactivity (framework-agnostic store contract) ──────────────────────

  subscribe(listener: () => void): () => void;
  getSnapshot(): FilterQueryResult;
  getVersion(): number;

  // ─── Output ─────────────────────────────────────────────────────────────

  build(): FilterQueryResult;
  toQueryString(): string;
  toFlatObject(): Record<string, unknown>;
}

/**
 * Creates a new type-safe `FilterQueryBuilder` that restricts field name
 * arguments to the `Fields` union type.
 *
 * At runtime this returns the exact same `FilterQueryBuilder` instance —
 * typing is the only difference. Zero runtime overhead.
 *
 * @example
 * type UserFields = 'name' | 'age' | 'status';
 *
 * const q = filterQueryTyped<UserFields>()
 *   .contains('name', 'Al')
 *   .gte('age', 18)
 *   .sortDesc('name')
 *   .page(0, 25)
 *   .build();
 *
 * // TypeScript error — 'invalid' is not assignable to UserFields:
 * // filterQueryTyped<UserFields>().where('invalid', 'foo');
 */
export function filterQueryTyped<
  Fields extends string,
  M extends FilterFieldTypes<Fields> = Record<Fields, unknown>,
>(): TypedFilterQueryBuilder<Fields, M> {
  return new FilterQueryBuilder() as unknown as TypedFilterQueryBuilder<Fields, M>;
}
