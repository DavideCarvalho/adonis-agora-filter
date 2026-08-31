import { compose } from '@adonisjs/core/helpers';
import { BaseModel, column, ModelQueryBuilder } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaseModelFilter } from '../src/base_model_filter.js';
import { filterable, filterFor, searchable, sortable } from '../src/decorators.js';
import { Filterable } from '../src/filterable_mixin.js';
import { registerFilterMacros } from '../src/lucid_macros.js';
import { createPgHarness, type PgHarness, probePgReachable } from './support/pg.js';

const pgUp = await probePgReachable();

/**
 * The decorators end to end: written in decorator *syntax* on a real Lucid model, stacked under
 * Lucid's own `@column()`, compiled by the same SWC transform an AdonisJS app runs in dev — and a
 * real Postgres executing the SQL they permit.
 *
 * The unit specs prove what the decorators record; only this proves the recording survives being
 * written the way an app writes it: on `declare` fields, next to `@column()`, in an app whose
 * models are transformed rather than hand-decorated.
 */
let harness: PgHarness;

class Moth extends compose(BaseModel, Filterable) {
  static table = 'decorated_moths';

  @column({ isPrimary: true })
  declare id: number;

  @column()
  @filterable()
  @searchable()
  @sortable()
  declare name: string;

  @column()
  @filterable()
  declare family: string;

  @column()
  @filterable('number')
  @sortable()
  declare wingspan: number;

  /** Undecorated on purpose: nothing in a request may reach it. */
  @column()
  declare secretNote: string;

  static $filter = () => MothFilter;
}

class MothFilter extends BaseModelFilter {
  static model = Moth;

  /** A key no method name could spell. */
  @filterFor('wingspan.min')
  minWingspan(value: unknown) {
    this.$query.where('wingspan', '>=', Number(value));
  }
}

function ctxWith(qs: Record<string, unknown>) {
  return { request: { qs: () => qs } };
}

beforeAll(async () => {
  if (!pgUp) return;
  harness = createPgHarness();
  registerFilterMacros(ModelQueryBuilder as never);
  await harness.raw('drop table if exists decorated_moths');
  await harness.raw(`
    create table decorated_moths (
      id serial primary key,
      name text not null,
      family text not null,
      wingspan int not null,
      secret_note text not null
    )
  `);
  await harness.raw(`
    insert into decorated_moths (name, family, wingspan, secret_note) values
      ('Luna', 'saturniidae', 110, 'alpha'),
      ('Atlas', 'saturniidae', 240, 'beta'),
      ('Hawk', 'sphingidae', 100, 'gamma'),
      ('Lunar Hawk', 'sphingidae', 60, 'alpha')
  `);
});

afterAll(async () => {
  if (!pgUp) return;
  await harness.raw('drop table if exists decorated_moths').catch(() => {});
  await harness.close();
});

describe.skipIf(!pgUp)('column decorators against real Postgres', () => {
  it('a decorated column is filterable with no allow-list on the filter class', async () => {
    const { query } = await Moth.filter(ctxWith({ filter: { family: 'sphingidae' } }));

    const rows = await query;

    expect(rows.map((row) => row.name).sort()).toEqual(['Hawk', 'Lunar Hawk']);
  });

  it('an undecorated column is unreachable — the condition never reaches SQL', async () => {
    const { query } = await Moth.filter(ctxWith({ filter: { secretNote: 'alpha' } }));

    const rows = await query;

    expect(rows).toHaveLength(4);
  });

  it('@searchable scopes the free-text term to the columns that carry it', async () => {
    const { query } = await Moth.filter(ctxWith({ search: 'luna' }));

    const rows = await query;

    // matches `name`, and nothing in `family` — which carries no @searchable
    expect(rows.map((row) => row.name).sort()).toEqual(['Luna', 'Lunar Hawk']);

    const byFamily = await Moth.filter(ctxWith({ search: 'sphingidae' }));
    expect(await byFamily.query).toHaveLength(0);
  });

  it('@sortable orders by a marked column and ignores an unmarked one', async () => {
    const sorted = await Moth.filter(ctxWith({ sort: '-wingspan' }));
    expect((await sorted.query).map((row) => row.name)).toEqual([
      'Atlas',
      'Luna',
      'Hawk',
      'Lunar Hawk',
    ]);

    const unsorted = await Moth.filter(ctxWith({ sort: 'secretNote' }));
    expect((await unsorted.query).map((row) => row.name).sort()).toEqual([
      'Atlas',
      'Hawk',
      'Luna',
      'Lunar Hawk',
    ]);
  });

  it('@filterFor answers a key no method name could spell', async () => {
    const { query } = await Moth.filter(ctxWith({ filter: { 'wingspan.min': '105' } }));

    const rows = await query;

    expect(rows.map((row) => row.name).sort()).toEqual(['Atlas', 'Luna']);
  });

  it('and the bound method stops answering to its own name', async () => {
    const { query } = await Moth.filter(ctxWith({ filter: { minWingspan: '105' } }));

    const rows = await query;

    expect(rows).toHaveLength(4);
  });

  it('pages the decorated surface like any other filter', async () => {
    const page = await Moth.filterPaginate(ctxWith({ sort: 'name', page: '2', size: '2' }));

    expect(page.currentPage).toBe(2);
    expect(page.total).toBe(4);
    expect(page.all().map((row) => row.name)).toEqual(['Luna', 'Lunar Hawk']);
  });
});
