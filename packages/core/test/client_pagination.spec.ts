import { filterQuery } from '@adonis-agora/filter-client';
import {
  applyTanstackTableState,
  tanstackPaginationFromMeta,
} from '@adonis-agora/filter-client/tanstack';
import { BaseModel, column } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineCollection, filterInMemory } from '../src/in_memory.js';
import { paginate } from '../src/paginate.js';
import { parseFilterRequest } from '../src/parse_request.js';
import { applyFilter } from '../src/runner.js';
import type { FilterConfig } from '../src/types.js';
import { createPgHarness, type PgHarness, probePgReachable } from './support/pg.js';

const pgUp = await probePgReachable();

/**
 * The client and the server must agree on page numbering: both are 1-based. These run the query
 * string the client builds through the server's parser and runner, so an off-by-one on either side
 * (page 0 and page 1 returning the same rows, every later page shifted) fails here.
 *
 * 7 rows, 3 per page: page 1 is ids 1-3, page 2 is ids 4-6, page 3 (the last) is id 7.
 */
interface Row {
  id: number;
  name: string;
}

const ROWS: Row[] = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `row ${i + 1}` }));
const SIZE = 3;
const EXPECTED: Record<number, number[]> = { 1: [1, 2, 3], 2: [4, 5, 6], 3: [7] };
const config: FilterConfig = { allowed: ['id', 'name'] };

/** The query string the browser sends, parsed the way AdonisJS hands it to `request.qs()`. */
function serverInput(queryString: string) {
  return parseFilterRequest(Object.fromEntries(new URLSearchParams(queryString)));
}

const rows = defineCollection<Row>({ fields: { id: 'number', name: 'string' } });

function inMemoryPage(queryString: string) {
  return filterInMemory(rows, ROWS, serverInput(queryString), config);
}

describe('client paging against the server runner (in memory)', () => {
  for (const page of [1, 2, 3]) {
    it(`builder .page(${page}) returns page ${page}`, () => {
      const qs = filterQuery().sortAsc('id').page(page, SIZE).toQueryString();
      const result = inMemoryPage(qs);

      expect(result.data.map((row) => row.id)).toEqual(EXPECTED[page]);
      expect(result.meta.currentPage).toBe(page);
      expect(result.meta.lastPage).toBe(3);
    });

    it(`TanStack pageIndex ${page - 1} returns page ${page} and maps back`, () => {
      const qs = applyTanstackTableState(filterQuery(), {
        sorting: [{ id: 'id', desc: false }],
        pagination: { pageIndex: page - 1, pageSize: SIZE },
      }).toQueryString();
      const result = inMemoryPage(qs);

      expect(result.data.map((row) => row.id)).toEqual(EXPECTED[page]);
      expect(tanstackPaginationFromMeta(result.meta)).toEqual({
        pagination: { pageIndex: page - 1, pageSize: SIZE },
        pageCount: 3,
        rowCount: 7,
      });
    });
  }

  it('rejects page 0 on the client instead of letting the server clamp it to page 1', () => {
    expect(() => filterQuery().page(0, SIZE)).toThrow(RangeError);
  });
});

class PagedRow extends BaseModel {
  static table = 'client_paging_rows';
  declare id: number;
  declare name: string;
}
column({ isPrimary: true })(PagedRow.prototype, 'id');
column()(PagedRow.prototype, 'name');

describe.skipIf(!pgUp)('client paging against the server runner (Lucid + Postgres)', () => {
  let harness: PgHarness;

  beforeAll(async () => {
    harness = createPgHarness();
    await harness.raw('drop table if exists client_paging_rows');
    await harness.raw('create table client_paging_rows (id integer primary key, name text)');
    for (const row of ROWS) {
      await harness.raw('insert into client_paging_rows (id, name) values (?, ?)', [
        row.id,
        row.name,
      ]);
    }
  });

  afterAll(async () => {
    await harness.raw('drop table if exists client_paging_rows');
    await harness.close();
  });

  async function lucidPage(queryString: string) {
    const query = PagedRow.query();
    const { page, size } = applyFilter(query, serverInput(queryString), config);
    const paginator = (await paginate(query, page, size)) as {
      toJSON(): { meta: Record<string, number>; data: PagedRow[] };
    };
    return paginator.toJSON();
  }

  for (const page of [1, 2, 3]) {
    it(`builder .page(${page}) and TanStack pageIndex ${page - 1} return page ${page}`, async () => {
      const fromBuilder = await lucidPage(
        filterQuery().sortAsc('id').page(page, SIZE).toQueryString(),
      );
      const fromTable = await lucidPage(
        applyTanstackTableState(filterQuery(), {
          sorting: [{ id: 'id', desc: false }],
          pagination: { pageIndex: page - 1, pageSize: SIZE },
        }).toQueryString(),
      );

      for (const result of [fromBuilder, fromTable]) {
        expect(result.data.map((row) => row.id)).toEqual(EXPECTED[page]);
        expect(tanstackPaginationFromMeta(result.meta)).toEqual({
          pagination: { pageIndex: page - 1, pageSize: SIZE },
          pageCount: 3,
          rowCount: 7,
        });
      }
    });
  }
});
