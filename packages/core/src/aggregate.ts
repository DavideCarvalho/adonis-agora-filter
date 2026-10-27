import type { AggregateFn } from './aggregate_path.js';
import type { RelationSpec } from './filter_spec.js';
import type { ColumnFilter } from './operators.js';
import type { ComputedContext, ComputedFields, ComputedSource } from './types.js';
import { normalizeOperator } from './validate-column-filter.js';

/**
 * The structural slice of a booted Lucid relation the aggregate-subquery
 * compiler reads. A real `@adonisjs/lucid` `HasMany` / `ManyToMany` relation
 * satisfies it — declared locally so this module never hard-imports Lucid. The
 * key-column fields are optional because they differ by relation kind
 * (one-to-many exposes `foreignKeyColumnName`; many-to-many exposes the pivot
 * fields), and only the relevant ones are read per kind.
 */
export interface LucidRelationLike {
  /** Relation kind — `'hasMany'` / `'manyToMany'` are the to-many kinds we correlate. */
  type: string;
  /** Compute the relation's key columns from the naming strategy (idempotent). */
  boot(): void;
  /** The related (child) model — its `table` is the child table name. */
  relatedModel(): { table?: string };
  // one-to-many (hasMany)
  foreignKeyColumnName?: string;
  localKeyColumnName?: string;
  // many-to-many (pivot) — plus localKeyColumnName above for the owner PK
  relatedKeyColumnName?: string;
  pivotTable?: string;
  pivotForeignKey?: string;
  pivotRelatedForeignKey?: string;
}

/**
 * The structural slice of a Lucid model the aggregate discovery reads: its table
 * name and a relation accessor. `$getRelation` is typed with `any` for the same
 * reason `QueryBuilderLike.whereHas` is — Lucid types it with a generic
 * literal-union `Name`, and `string` is not assignable to that union, so a
 * narrower signature would make every real model fail to satisfy this interface.
 */
export interface LucidModelLike {
  table?: string;
  // biome-ignore lint/suspicious/noExplicitAny: Lucid's $getRelation<Name extends ...> rejects a plain `string` arg; `any` keeps every real model assignable (same precedent as whereHas).
  $getRelation(name: any): LucidRelationLike | undefined;
}

/** Column functions (need a numeric child column); `count` needs none. */
const COLUMN_FNS: readonly AggregateFn[] = ['sum', 'avg', 'min', 'max'];

/** Double-quote one identifier segment for Postgres, escaping embedded quotes. */
function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * The correlated `FROM … WHERE <correlation>` clause behind each discovered
 * `$count` source. Keyed by the source function, so a hand-written computed
 * field never has one.
 */
const countRowSets = new WeakMap<ComputedSource & object, (ctx: ComputedContext) => string>();

/** Is `value` the integer `n`, as a number or as the string a query parameter carries? */
function isInteger(value: unknown, n: number): boolean {
  return value === n || value === String(n);
}

/**
 * The `EXISTS` / `NOT EXISTS` predicate equivalent to a filter on a discovered
 * `$count` field, when the filter only asks whether the collection is empty:
 * `gt 0`, `gte 1` and `notEquals 0` mean non-empty; `equals 0`, `lte 0` and
 * `lt 1` mean empty. `EXISTS` stops at the first related row where the counting
 * subquery visits all of them. `undefined` for any other filter or source.
 */
export function countExistencePredicate(
  source: ComputedSource,
  alias: string,
  filter: ColumnFilter,
): string | undefined {
  if (typeof source !== 'function') return undefined;
  const rowSet = countRowSets.get(source);
  if (!rowSet) return undefined;
  const value = filter.value;
  let exists: boolean;
  switch (normalizeOperator(filter.operator)) {
    case 'gt':
    case 'notEquals':
      if (!isInteger(value, 0)) return undefined;
      exists = true;
      break;
    case 'gte':
      if (!isInteger(value, 1)) return undefined;
      exists = true;
      break;
    case 'equals':
    case 'lte':
      if (!isInteger(value, 0)) return undefined;
      exists = false;
      break;
    case 'lt':
      if (!isInteger(value, 1)) return undefined;
      exists = false;
      break;
    default:
      return undefined;
  }
  return `${exists ? 'EXISTS' : 'NOT EXISTS'} (SELECT 1 ${rowSet({ alias })})`;
}

/** A `$count` source over the rows `rowSet` (`FROM … WHERE …`) selects. */
function countSource(rowSet: (ctx: ComputedContext) => string): ComputedSource {
  const source = (ctx: ComputedContext) => `(SELECT COUNT(*) ${rowSet(ctx)})`;
  countRowSets.set(source, rowSet);
  return source;
}

/**
 * The scalar aggregate expression over an (already-quoted) child column. Empty
 * collection semantics: `sum` coalesces to 0; `avg`/`min`/`max` stay NULL (their
 * natural result over zero rows); `count` is naturally 0.
 */
function aggregateExpr(fn: AggregateFn, quotedColumn: string): string {
  switch (fn) {
    case 'count':
      return 'COUNT(*)';
    case 'sum':
      return `COALESCE(SUM(${quotedColumn}),0)`;
    case 'avg':
      return `AVG(${quotedColumn})`;
    case 'min':
      return `MIN(${quotedColumn})`;
    case 'max':
      return `MAX(${quotedColumn})`;
  }
}

/**
 * ONE_TO_MANY correlation: a direct FK on the child row points back at the
 * root's PK. `column` omitted → `$count`.
 *
 *   (SELECT <agg> FROM "child" WHERE "child"."fk" = "<alias>"."pk")
 */
function oneToManySource(
  fn: AggregateFn,
  childTable: string,
  fk: string,
  pk: string,
  column: string | undefined,
): ComputedSource {
  if (fn === 'count') {
    return countSource(
      ({ alias }) => `FROM ${q(childTable)} WHERE ${q(childTable)}.${q(fk)} = ${q(alias)}.${q(pk)}`,
    );
  }
  const agg = aggregateExpr(fn, column ? `${q(childTable)}.${q(column)}` : '');
  return ({ alias }) =>
    `(SELECT ${agg} FROM ${q(childTable)} WHERE ${q(childTable)}.${q(fk)} = ${q(alias)}.${q(pk)})`;
}

/**
 * MANY_TO_MANY correlation, mediated by a pivot table. `$count` counts pivot
 * rows directly; the column functions JOIN pivot → child INSIDE the scalar
 * subquery to reach the child column.
 *
 *   $count: (SELECT COUNT(*) FROM "pivot" WHERE "pivot"."ownerFk" = "<alias>"."ownerPk")
 *   $agg:   (SELECT <agg> FROM "child"
 *             JOIN "pivot" ON "child"."childPk" = "pivot"."inverseFk"
 *             WHERE "pivot"."ownerFk" = "<alias>"."ownerPk")
 */
function manyToManySource(
  fn: AggregateFn,
  meta: {
    childTable: string;
    childPk: string;
    pivot: string;
    ownerFk: string;
    inverseFk: string;
    ownerPk: string;
  },
  column: string | undefined,
): ComputedSource {
  if (fn === 'count') {
    return countSource(
      ({ alias }) =>
        `FROM ${q(meta.pivot)} WHERE ${q(meta.pivot)}.${q(meta.ownerFk)} = ${q(alias)}.${q(meta.ownerPk)}`,
    );
  }
  const agg = aggregateExpr(fn, column ? `${q(meta.childTable)}.${q(column)}` : '');
  return ({ alias }) =>
    `(SELECT ${agg} FROM ${q(meta.childTable)} JOIN ${q(meta.pivot)} ON ${q(meta.childTable)}.${q(meta.childPk)} = ${q(meta.pivot)}.${q(meta.inverseFk)} WHERE ${q(meta.pivot)}.${q(meta.ownerFk)} = ${q(alias)}.${q(meta.ownerPk)})`;
}

/**
 * Discover to-many aggregate {@link ComputedSource}s from a Lucid model's
 * relation metadata, for the relations the spec whitelisted. For each declared
 * to-many relation (hasMany / manyToMany) this synthesises:
 *
 * - `<rel>.$count` — always;
 * - `<rel>.$sum|$avg|$min|$max.<col>` — one per column the relation's
 *   {@link RelationSpec.aggregates} declares (Lucid does not reflect SQL column
 *   types, so the dev asserts numeric-ness by listing the column there).
 *
 * To-one relations (belongsTo / hasOne) are excluded. The whole thing degrades
 * gracefully: a relation that is not on the model, is to-one, or cannot be
 * booted (e.g. no DB adapter yet) is simply skipped, and a model without the
 * introspection capability yields an empty map — so aggregates activate only
 * when the metadata is actually available.
 *
 * The result is merged into the spec's `computed` map, so aggregate fields ARE
 * computed fields with auto-generated correlated-subquery sources — they reuse
 * the exact same runner routing, allow-list bypass (their discovery IS their
 * allow-list, gated by the relation whitelist), injection-safe value binding,
 * and codegen surfacing.
 */
export function discoverAggregateSources(
  model: LucidModelLike | undefined,
  relations: Readonly<Record<string, RelationSpec>>,
): ComputedFields {
  if (!model || typeof model.$getRelation !== 'function') return {};
  const out: ComputedFields = {};

  for (const [relName, relSpec] of Object.entries(relations)) {
    let rel: LucidRelationLike | undefined;
    try {
      rel = model.$getRelation(relName);
      if (!rel) continue;
      rel.boot();
    } catch {
      continue; // Un-bootable relation (no adapter yet, etc.) → skip its aggregates.
    }

    const columns = relSpec.aggregates ?? [];
    const childTable = rel.relatedModel?.().table;

    if (rel.type === 'hasMany') {
      const fk = rel.foreignKeyColumnName;
      const pk = rel.localKeyColumnName;
      if (!childTable || !fk || !pk) continue;
      out[`${relName}.$count`] = oneToManySource('count', childTable, fk, pk, undefined);
      for (const col of columns) {
        for (const fn of COLUMN_FNS) {
          out[`${relName}.$${fn}.${col}`] = oneToManySource(fn, childTable, fk, pk, col);
        }
      }
    } else if (rel.type === 'manyToMany') {
      const pivot = rel.pivotTable;
      const ownerFk = rel.pivotForeignKey;
      const inverseFk = rel.pivotRelatedForeignKey;
      const ownerPk = rel.localKeyColumnName;
      const childPk = rel.relatedKeyColumnName;
      if (!pivot || !ownerFk || !ownerPk) continue;
      out[`${relName}.$count`] = manyToManySource(
        'count',
        {
          childTable: childTable ?? '',
          childPk: childPk ?? '',
          pivot,
          ownerFk,
          inverseFk: inverseFk ?? '',
          ownerPk,
        },
        undefined,
      );
      if (childTable && inverseFk && childPk) {
        for (const col of columns) {
          for (const fn of COLUMN_FNS) {
            out[`${relName}.$${fn}.${col}`] = manyToManySource(
              fn,
              { childTable, childPk, pivot, ownerFk, inverseFk, ownerPk },
              col,
            );
          }
        }
      }
    }
    // to-one (belongsTo / hasOne) and any other kind → no aggregate keys.
  }

  return out;
}
