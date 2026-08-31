import { BaseModel, column } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyFilter } from '../src/runner.js';
import type { ComputedFields, FilterConfig } from '../src/types.js';
import { createPgHarness, type PgHarness, probePgReachable } from './support/pg.js';

// Resolved at collection time so the pg-backed blocks skip (not fail) when no
// Postgres is reachable.
const pgUp = await probePgReachable();

/**
 * Computed (virtual) fields against real Postgres — both source forms:
 * a verbatim STRING expression and a FUNCTION `({ alias }) => sql` correlated
 * subquery. Proves they filter and sort correctly, compose with real columns,
 * and — the critical contract — keep the client VALUE parameterized so a
 * malicious value cannot inject SQL.
 */

let harness: PgHarness;

class Author extends BaseModel {
  static table = 'authors';
  declare id: number;
  declare firstName: string;
  declare lastName: string;
}
column({ isPrimary: true })(Author.prototype, 'id');
column()(Author.prototype, 'firstName');
column()(Author.prototype, 'lastName');

const computed: ComputedFields = {
  // Verbatim string source (no token substitution).
  fullName: "first_name || ' ' || last_name",
  // Function source — correlated subquery using the surfaced root table alias.
  postCount: ({ alias }) => `(SELECT COUNT(*) FROM posts WHERE posts.author_id = ${alias}.id)`,
};

const config: FilterConfig = {
  allowed: ['firstName', 'lastName'],
  computed,
  table: 'authors',
};

beforeAll(async () => {
  if (!pgUp) return;
  harness = createPgHarness();
  await harness.raw('drop table if exists posts');
  await harness.raw('drop table if exists authors');
  await harness.raw(
    'create table authors (id serial primary key, first_name text not null, last_name text not null)',
  );
  await harness.raw('create table posts (id serial primary key, author_id int not null)');
  // Ada Lovelace (3 posts), Alan Turing (1 post), Grace Hopper (0 posts).
  await harness.raw(
    "insert into authors (id, first_name, last_name) values (1,'Ada','Lovelace'),(2,'Alan','Turing'),(3,'Grace','Hopper')",
  );
  await harness.raw('insert into posts (author_id) values (1),(1),(1),(2)');
});

afterAll(async () => {
  if (harness) await harness.close();
});

describe.skipIf(!pgUp)('computed field — verbatim string source', () => {
  it('filters by the computed expression (contains)', async () => {
    const query = Author.query();
    applyFilter(
      query as never,
      { filters: [{ field: 'fullName', operator: 'contains', value: 'Turing' }] },
      config,
    );
    const rows = await query;
    expect(rows.map((r) => r.firstName)).toEqual(['Alan']);
  });

  it('sorts by the computed expression', async () => {
    const query = Author.query();
    applyFilter(query as never, { sort: [{ field: 'fullName', direction: 'asc' }] }, config);
    const rows = await query;
    // Alphabetical by "First Last": Ada Lovelace, Alan Turing, Grace Hopper.
    expect(rows.map((r) => r.firstName)).toEqual(['Ada', 'Alan', 'Grace']);
  });
});

describe.skipIf(!pgUp)('computed field — function source (correlated subquery)', () => {
  it('filters by a to-many count via the surfaced alias', async () => {
    const query = Author.query();
    applyFilter(
      query as never,
      {
        filters: [{ field: 'postCount', operator: 'gt', value: 1 }],
        sort: [{ field: 'id', direction: 'asc' }],
      },
      config,
    );
    const rows = await query;
    // Only Ada has > 1 post.
    expect(rows.map((r) => r.firstName)).toEqual(['Ada']);
  });

  it('sorts by the computed subquery, descending', async () => {
    const query = Author.query();
    applyFilter(query as never, { sort: [{ field: 'postCount', direction: 'desc' }] }, config);
    const rows = await query;
    // Ada (3) > Alan (1) > Grace (0).
    expect(rows.map((r) => r.firstName)).toEqual(['Ada', 'Alan', 'Grace']);
  });
});

describe.skipIf(!pgUp)('computed field — composition + injection safety', () => {
  it('composes a computed sort with a real-column sort in request order', async () => {
    const query = Author.query();
    // Sort by postCount desc, then lastName asc as a tiebreaker.
    applyFilter(
      query as never,
      {
        sort: [
          { field: 'postCount', direction: 'desc' },
          { field: 'lastName', direction: 'asc' },
        ],
      },
      config,
    );
    const rows = await query;
    expect(rows.map((r) => r.firstName)).toEqual(['Ada', 'Alan', 'Grace']);
  });

  it('keeps the client value parameterized — a SQL-injection value cannot escape', async () => {
    const query = Author.query();
    // A classic injection payload as the VALUE. If it were concatenated into SQL
    // it would flip the predicate to always-true (returning all 3 authors) or
    // throw a syntax error. As a bound parameter it is just a string literal that
    // equals no author's full name → zero rows.
    const evil = "Nobody' OR '1'='1";
    applyFilter(
      query as never,
      { filters: [{ field: 'fullName', operator: 'equals', value: evil }] },
      config,
    );
    const rows = await query;
    expect(rows).toHaveLength(0);
  });
});
