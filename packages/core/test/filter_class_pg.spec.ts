import { compose } from '@adonisjs/core/helpers';
import { BaseModel, ModelQueryBuilder, column } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaseModelFilter } from '../src/base_model_filter.js';
import { Filterable } from '../src/filterable_mixin.js';
import { registerFilterMacros } from '../src/lucid_macros.js';
import { type PgHarness, createPgHarness, probePgReachable } from './support/pg.js';

const pgUp = await probePgReachable();

/**
 * The class form end to end: a real Lucid model composed with the `Filterable` mixin, a filter
 * class with a `setup()` scope and a method of its own, the macros registered the way the
 * provider registers them — and a real Postgres executing the SQL.
 *
 * The unit specs prove which builder calls are made; only this proves the calls survive Lucid,
 * reach the database as one statement, and come back as the right rows and the right page.
 */

let harness: PgHarness;

// Columns are applied programmatically (rather than with decorator syntax) so the suite does not
// depend on an SWC legacy-decorator transform — the decorator is a plain function.
class Bird extends compose(BaseModel, Filterable) {
  static table = 'class_form_birds';
  declare id: number;
  declare name: string;
  declare family: string;
  declare wingspan: number;
  declare deletedAt: Date | null;

  static $filter = () => BirdFilter;
}
column({ isPrimary: true })(Bird.prototype, 'id');
column()(Bird.prototype, 'name');
column()(Bird.prototype, 'family');
column()(Bird.prototype, 'wingspan');
column()(Bird.prototype, 'deletedAt');

class BirdFilter extends BaseModelFilter {
  static model = Bird;
  static filterable = ['family'];
  static sortable = ['name', 'wingspan'];
  static searchable = ['name'];
  static defaultSize = 25;
  static maxSize = 50;

  /** Server policy: soft-deleted rows are never reachable, whatever the request says. */
  setup() {
    this.$query.whereNull('deleted_at');
  }

  /** A key the class owns: no column called `minWingspan` exists. */
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
  await harness.raw('drop table if exists class_form_birds');
  await harness.raw(`
    create table class_form_birds (
      id serial primary key,
      name text not null,
      family text not null,
      wingspan int not null,
      deleted_at timestamptz
    )
  `);
  await harness.raw(`
    insert into class_form_birds (name, family, wingspan, deleted_at) values
      ('Sandpiper', 'scolopacidae', 40, null),
      ('Curlew', 'scolopacidae', 90, null),
      ('Godwit', 'scolopacidae', 75, null),
      ('Kingfisher', 'alcedinidae', 25, null),
      ('Ghost Sandpiper', 'scolopacidae', 200, now())
  `);
});

afterAll(async () => {
  if (!pgUp) return;
  await harness.raw('drop table if exists class_form_birds').catch(() => {});
  await harness.close();
});

describe.skipIf(!pgUp)('filter classes against real Postgres', () => {
  it('setup() scopes every query — the soft-deleted row is unreachable', async () => {
    const { query } = await Bird.filter(ctxWith({}));
    const rows = await query;

    expect(rows.map((row) => row.name)).not.toContain('Ghost Sandpiper');
    expect(rows).toHaveLength(4);
  });

  it('a declared column filters through the declarative half', async () => {
    const { query } = await Bird.filter(ctxWith({ filter: { family: 'alcedinidae' } }));
    const rows = await query;

    expect(rows.map((row) => row.name)).toEqual(['Kingfisher']);
  });

  it('a key the class owns runs its own SQL', async () => {
    const { query } = await Bird.filter(ctxWith({ filter: { minWingspan: '70' } }));
    const rows = await query;

    expect(rows.map((row) => row.name).sort()).toEqual(['Curlew', 'Godwit']);
  });

  it('the builder comes back as a builder, not as rows — and keeps composing', async () => {
    const { query } = await Bird.filter(ctxWith({ filter: { minWingspan: '30' } }));
    query.where('family', 'scolopacidae').orderBy('wingspan', 'desc');

    const rows = await query;

    expect(rows.map((row) => row.name)).toEqual(['Curlew', 'Godwit', 'Sandpiper']);
  });

  it('filterPaginate() pages with what the request asked for', async () => {
    const { query } = await Bird.filter(ctxWith({ sort: 'name', page: '2', size: '2' }));
    const page = await query.filterPaginate();

    expect(page.currentPage).toBe(2);
    expect(page.perPage).toBe(2);
    expect(page.total).toBe(4);
    expect(page.all().map((row) => row.name)).toEqual(['Kingfisher', 'Sandpiper']);
  });

  it('the model one-liner does the same', async () => {
    const page = await Bird.filterPaginate(ctxWith({ search: 'sandpiper' }));

    // the soft-deleted 'Ghost Sandpiper' still does not come back
    expect(page.all().map((row) => row.name)).toEqual(['Sandpiper']);
  });

  it('a column the class never declared is dropped, not queried', async () => {
    const { query } = await Bird.filter(ctxWith({ filter: { wingspan: '25' } }));
    const rows = await query;

    // `wingspan` is sortable but not filterable — the filter is pruned, so every row comes back
    expect(rows).toHaveLength(4);
  });

  it('size is clamped to the class maxSize', async () => {
    const { query } = await Bird.filter(ctxWith({ size: '500' }));
    const page = await query.filterPaginate();

    expect(page.perPage).toBe(50);
  });
});
