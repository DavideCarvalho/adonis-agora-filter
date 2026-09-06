import type { QueryBuilderLike } from './lucid_adapter.js';

/** A recorded query-builder call: method name + its scalar args. */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * A recording stand-in for a Lucid query builder, published under
 * `@adonis-agora/filter/testing` so consumers can unit-test their own filter
 * definitions without a database. It satisfies {@link QueryBuilderLike}, so any
 * of the adapter/runner helpers (or {@link applyFilterFromRequest}) can be
 * driven against it and the resulting translation asserted.
 *
 * Nested `where`/`orWhere` closures run against child recorders, and a dotted
 * relation-path filter's `whereHas` records the relation name plus runs its
 * nested callback against a child. {@link flatten} collects every leaf call
 * (across all groups and relation subqueries) so tests can assert a translation
 * appeared without caring about the exact grouping nesting.
 */
export class MockQueryBuilder implements QueryBuilderLike {
  calls: RecordedCall[] = [];
  children: MockQueryBuilder[] = [];

  private record(method: string, ...args: unknown[]): this {
    this.calls.push({ method, args });
    return this;
  }

  private group(method: string, cb: (qb: QueryBuilderLike) => void): this {
    const child = new MockQueryBuilder();
    this.children.push(child);
    this.calls.push({ method, args: ['<group>'] });
    cb(child);
    return this;
  }

  // biome-ignore lint/suspicious/noExplicitAny: structural overloads for the mock.
  where(a: any, b?: any, c?: any): this {
    if (typeof a === 'function') return this.group('where', a);
    return c !== undefined ? this.record('where', a, b, c) : this.record('where', a, b);
  }
  orWhere(cb: (qb: QueryBuilderLike) => void): this {
    return this.group('orWhere', cb);
  }
  /**
   * Record a relation subquery: the `whereHas` call is captured with the
   * relation name (so `find('whereHas')?.args[0]` is the relation), and the
   * nested callback runs against a child recorder whose calls surface via
   * {@link flatten}.
   */
  whereHas(relation: string, cb: (qb: QueryBuilderLike) => void): this {
    const child = new MockQueryBuilder();
    this.children.push(child);
    this.calls.push({ method: 'whereHas', args: [relation] });
    cb(child);
    return this;
  }
  whereNot(column: string, value: unknown): this {
    return this.record('whereNot', column, value);
  }
  whereIn(column: string, values: unknown[]): this {
    return this.record('whereIn', column, values);
  }
  whereNotIn(column: string, values: unknown[]): this {
    return this.record('whereNotIn', column, values);
  }
  whereNull(column: string): this {
    return this.record('whereNull', column);
  }
  whereNotNull(column: string): this {
    return this.record('whereNotNull', column);
  }
  whereBetween(column: string, range: [unknown, unknown]): this {
    return this.record('whereBetween', column, range);
  }
  whereNotBetween(column: string, range: [unknown, unknown]): this {
    return this.record('whereNotBetween', column, range);
  }
  whereILike(column: string, value: string): this {
    return this.record('whereILike', column, value);
  }
  orWhereILike(column: string, value: string): this {
    return this.record('orWhereILike', column, value);
  }
  orderBy(column: string, direction: 'asc' | 'desc'): this {
    return this.record('orderBy', column, direction);
  }
  /** Record a raw predicate: `args` are `[sql, bindings]` (bindings default `[]`). */
  whereRaw(sql: string, bindings: readonly unknown[] = []): this {
    return this.record('whereRaw', sql, bindings);
  }
  /** Record a raw ordering: `args` are `[sql, bindings]` (bindings default `[]`). */
  orderByRaw(sql: string, bindings: readonly unknown[] = []): this {
    return this.record('orderByRaw', sql, bindings);
  }
  limit(count: number): this {
    return this.record('limit', count);
  }
  /** Record a row skip: `args` are `[n]`. Only the group-by-count aggregation pages this way. */
  offset(n: number): this {
    return this.record('offset', n);
  }
  /** Record a projection: `args` are the select expressions (aggregates included). */
  select(...columns: string[]): this {
    return this.record('select', ...columns);
  }
  /** Record an aggregation: `args` are `[column]` (e.g. `'* AS count'`). */
  count(column: string): this {
    return this.record('count', column);
  }
  /** Record a grouping: `args` are the group columns. */
  groupBy(...columns: string[]): this {
    return this.record('groupBy', ...columns);
  }
  /** Record a DISTINCT projection: `args` are the distinct column names. */
  distinct(...columns: string[]): this {
    return this.record('distinct', ...columns);
  }

  /**
   * Every recorded call across this builder and all nested groups and relation
   * subqueries (excludes the anonymous group markers, but keeps `whereHas` since
   * its recorded arg is the relation name, not a marker).
   */
  flatten(): RecordedCall[] {
    const own = this.calls.filter((c) => c.args[0] !== '<group>');
    return [...own, ...this.children.flatMap((c) => c.flatten())];
  }

  /** Find the first flattened call matching `method`. */
  find(method: string): RecordedCall | undefined {
    return this.flatten().find((c) => c.method === method);
  }

  /** Every flattened call matching `method` (handy for asserting relation subqueries). */
  findAll(method: string): RecordedCall[] {
    return this.flatten().filter((c) => c.method === method);
  }
}

/** Factory for a fresh {@link MockQueryBuilder} — the recording Lucid stand-in. */
export function makeMockQueryBuilder(): MockQueryBuilder {
  return new MockQueryBuilder();
}
