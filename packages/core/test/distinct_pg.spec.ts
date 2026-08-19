import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineFilter, specToFilterConfig } from '../src/filter_spec.js';
import { parseFilterRequest } from '../src/parse_request.js';
import { applyFilter } from '../src/runner.js';
import type { FilterConfig } from '../src/types.js';
import { InvalidColumnFilterError } from '../src/validate-column-filter.js';
import { type PgHarness, createPgHarness, probePgReachable } from './support/pg.js';

// Resolved at collection time so the pg-backed blocks skip (not fail) when no
// Postgres is reachable.
const pgUp = await probePgReachable();

/**
 * DISTINCT is the client/server contract this batch fixes: the client emits a
 * `distinct` query param but the server used to drop it on the floor. These
 * tests run against real Postgres and prove the projection actually dedups rows
 * — and, by comparison against the un-distinct query, that it was a genuine
 * no-op before the fix.
 */

let harness: PgHarness;

// Columns are applied programmatically (rather than with `@column` decorator
// syntax) so the test suite does not depend on SWC legacy-decorator transform
// config — the decorator *is* a plain function, and this is the exact call the
// syntax desugars to.
class Note extends BaseModel {
  static table = 'sighting_notes';
  declare id: number;
  declare sightingId: number;
  declare body: string;
}
column({ isPrimary: true })(Note.prototype, 'id');
column()(Note.prototype, 'sightingId');
column()(Note.prototype, 'body');

class Sighting extends BaseModel {
  static table = 'sightings';
  declare id: number;
  declare city: string;
  declare species: string;
}
column({ isPrimary: true })(Sighting.prototype, 'id');
column()(Sighting.prototype, 'city');
column()(Sighting.prototype, 'species');
hasMany(() => Note, { foreignKey: 'sightingId' })(Sighting.prototype, 'notes');

/**
 * The relation-path spec: `notes.body` is a *filterable* path (the documented,
 * idiomatic relation-filter feature), which makes `spec.isFilterable('notes.body')`
 * true — so `distinct=notes.body` cleared the allow-list and was forwarded to
 * Lucid as `distinct "notes"."body"` against a FROM that only holds `sightings`.
 */
const relationSpec = defineFilter({
  model: Sighting,
  filterable: ['city', 'species'],
  relations: { notes: { filterable: ['body'] } },
});

beforeAll(async () => {
  if (!pgUp) return;
  harness = createPgHarness();
  await harness.raw('drop table if exists sighting_notes');
  await harness.raw('drop table if exists sightings');
  await harness.raw(
    'create table sightings (id serial primary key, city text not null, species text not null)',
  );
  // 6 rows across 3 distinct cities (NYC x3, LA x2, SF x1).
  await harness.raw(
    "insert into sightings (city, species) values ('NYC','hawk'),('NYC','robin'),('NYC','crow'),('LA','robin'),('LA','crow'),('SF','hawk')",
  );
  await harness.raw(
    'create table sighting_notes (id serial primary key, sighting_id int not null, body text not null)',
  );
  // Notes exist only for the NYC hawk (1) and the LA robin (4) — so a
  // `notes.body = 'ringed'` relation filter keeps exactly those two rows.
  await harness.raw(
    "insert into sighting_notes (sighting_id, body) values (1,'ringed'),(4,'ringed'),(4,'banded')",
  );
});

afterAll(async () => {
  if (harness) await harness.close();
});

const config: FilterConfig = { allowed: ['city', 'species'] };

describe.skipIf(!pgUp)('distinct projection against real Postgres', () => {
  it('baseline (no distinct) returns every matching row — the pre-fix behavior', async () => {
    const query = Sighting.query().select('city');
    // No distinct in input → applyFilter must not add one.
    applyFilter(query as never, { sort: [{ field: 'city', direction: 'asc' }] }, config);
    const rows = await query;
    expect(rows.map((r) => r.city)).toEqual(['LA', 'LA', 'NYC', 'NYC', 'NYC', 'SF']);
  });

  it('distinct([city]) dedups to one row per city (the fix)', async () => {
    const input = parseFilterRequest({ distinct: 'city', sort: 'city' });
    expect(input.distinct).toEqual(['city']);
    const query = Sighting.query().select('city');
    applyFilter(query as never, input, config);
    const rows = await query;
    // Deduped: 3 cities, not 6 sightings. This is exactly what the client asked
    // for and what the server ignored before the fix.
    expect(rows.map((r) => r.city)).toEqual(['LA', 'NYC', 'SF']);
  });

  it('distinct composes with an active where filter', async () => {
    const input = parseFilterRequest({
      filter: { species: 'robin' },
      distinct: 'city',
      sort: 'city',
    });
    const query = Sighting.query().select('city');
    applyFilter(query as never, input, config);
    const rows = await query;
    // 'robin' seen in NYC and LA → two distinct cities.
    expect(rows.map((r) => r.city)).toEqual(['LA', 'NYC']);
  });

  it('resolves a distinct alias to its target column before the allow-list', async () => {
    const input = parseFilterRequest({ distinct: 'town', sort: 'city' });
    const query = Sighting.query().select('city');
    applyFilter(query as never, input, { allowed: ['city'], aliases: { town: 'city' } });
    const rows = await query;
    expect(rows.map((r) => r.city)).toEqual(['LA', 'NYC', 'SF']);
  });

  it('drops a disallowed distinct field (no dedup applied)', async () => {
    const input = parseFilterRequest({ distinct: 'species', sort: 'city' });
    const query = Sighting.query().select('city');
    // 'species' not in allow-list → distinct dropped → every row survives.
    applyFilter(query as never, input, { allowed: ['city'] });
    const rows = await query;
    expect(rows).toHaveLength(6);
  });
});

/**
 * Regression guard 4 — the combination most likely to break: a relation-path
 * *filter* (a correlated `whereHas` EXISTS) and a root-scalar *distinct* in the
 * same request. The relation filter must keep working and the distinct must
 * still dedup the root column.
 */
describe.skipIf(!pgUp)('relation-path filter + root-scalar distinct compose', () => {
  it('filters via whereHas and dedups the root column', async () => {
    const input = parseFilterRequest({
      filter: { 'notes.body': 'ringed' },
      distinct: 'city',
      sort: 'city',
    });
    const query = Sighting.query().select('city');
    applyFilter(query as never, input, specToFilterConfig(relationSpec));
    const sql = (query as unknown as { toQuery(): string }).toQuery();
    // The relation filter is still a correlated EXISTS — nothing was joined.
    expect(sql).toContain('exists');
    const rows = await query;
    // Notes on sighting 1 (NYC) and 4 (LA) → two distinct cities.
    expect(rows.map((r) => r.city)).toEqual(['LA', 'NYC']);
  });
});

/**
 * The bug this batch fixes. `notes.body` is whitelisted for *filtering*, so it
 * cleared `resolveSafeDistinct`'s allow-list check and reached Lucid as
 * `select distinct "notes"."body" from "sightings"` — Postgres:
 * `missing FROM-clause entry for table "notes"`. Lucid's relation filtering
 * compiles to a correlated EXISTS subquery, so the relation is NEVER in the
 * outer FROM and there is no alias to project.
 */
describe.skipIf(!pgUp)('relation-path distinct is refused, never emitted', () => {
  it('does not emit an identifier the query has no FROM entry for', async () => {
    const input = parseFilterRequest({ distinct: 'notes.body', sort: 'city' });
    const query = Sighting.query().select('city');
    applyFilter(query as never, input, specToFilterConfig(relationSpec));
    const sql = (query as unknown as { toQuery(): string }).toQuery();
    expect(sql).not.toContain('distinct');
    expect(sql).not.toContain('notes');
    // And it EXECUTES — the whole point. Before the fix this rejected with
    // `missing FROM-clause entry for table "notes"`.
    const rows = await query;
    expect(rows).toHaveLength(6);
  });

  it('refuses it even when the relation is filtered in the same request', async () => {
    const input = parseFilterRequest({
      filter: { 'notes.body': 'ringed' },
      distinct: 'notes.body',
      sort: 'city',
    });
    const query = Sighting.query().select('city');
    applyFilter(query as never, input, specToFilterConfig(relationSpec));
    // A `whereHas` on the same relation does NOT bring the table into scope.
    const rows = await query;
    expect(rows.map((r) => r.city)).toEqual(['LA', 'NYC']);
  });

  it('rejects it loudly under throwOnInvalid, naming the cause', async () => {
    const throwing = defineFilter({
      model: Sighting,
      filterable: ['city', 'species'],
      relations: { notes: { filterable: ['body'] } },
      throwOnInvalid: true,
    });
    const query = Sighting.query().select('city');
    expect(() =>
      applyFilter(query as never, { distinct: ['notes.body'] }, specToFilterConfig(throwing)),
    ).toThrow(InvalidColumnFilterError);
    // The message must point at the join, not at the allow-list.
    expect(() =>
      applyFilter(query as never, { distinct: ['notes.body'] }, specToFilterConfig(throwing)),
    ).toThrow(/relation path/i);
  });

  it('keeps a root-table-qualified distinct working (it IS in the FROM)', async () => {
    const query = Sighting.query().select('city');
    applyFilter(
      query as never,
      { distinct: ['sightings.city'], sort: [{ field: 'city', direction: 'asc' }] },
      { allowed: '*', table: 'sightings' },
    );
    const rows = await query;
    expect(rows.map((r) => r.city)).toEqual(['LA', 'NYC', 'SF']);
  });
});
