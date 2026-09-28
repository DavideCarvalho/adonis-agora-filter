import { describe, expect, it } from 'vitest';
import { applyFilterFromRequest } from '../src/apply_from_request.js';
import { defineFilter } from '../src/filter_spec.js';
import { groupByCountFromRequest } from '../src/group_by_count.js';
import {
  cursorInMemory,
  defineCollection,
  filterInMemory,
  InMemoryQueryError,
} from '../src/in_memory.js';
import type { ColumnFilter } from '../src/operators.js';
import { parseFilterRequest } from '../src/parse_request.js';
import { applyFilter } from '../src/runner.js';
import type { FilterConfig, FilterInput } from '../src/types.js';
import { InvalidColumnFilterError } from '../src/validate-column-filter.js';

interface Post {
  id: number;
  title: string;
  published: boolean;
}

interface Team {
  id: number;
  name: string;
}

interface User {
  id: number;
  first: string;
  last: string;
  email: string | null;
  age: number | null;
  active: boolean;
  createdAt: string;
  tags: string[] | null;
  teamId: number | null;
  posts: Post[];
}

const teams: Team[] = [
  { id: 1, name: 'Core' },
  { id: 2, name: 'Growth' },
];

const posts = defineCollection<Post>({
  fields: { id: 'number', title: 'string', published: 'boolean' },
});

const teamsCollection = defineCollection<Team>({ fields: { id: 'number', name: 'string' } });

const users = defineCollection<User>({
  name: 'users',
  fields: {
    id: 'number',
    first: 'string',
    last: 'string',
    email: 'string',
    age: 'number',
    active: 'boolean',
    createdAt: 'date',
    tags: 'string[]',
    teamId: 'number',
    fullName: { type: 'string', get: (u) => `${u.first} ${u.last}` },
  },
  relations: {
    posts: { kind: 'one-to-many', target: () => posts, get: (u) => u.posts },
    team: {
      kind: 'many-to-one',
      target: () => teamsCollection,
      get: (u) => teams.find((t) => t.id === u.teamId) ?? null,
    },
  },
});

const rows: User[] = [
  {
    id: 1,
    first: 'Ada',
    last: 'Lovelace',
    email: 'ada@example.com',
    age: 36,
    active: true,
    createdAt: '2024-01-10T00:00:00Z',
    tags: ['math', 'poet'],
    teamId: 1,
    posts: [{ id: 10, title: 'Notes on the Engine', published: true }],
  },
  {
    id: 2,
    first: 'Alan',
    last: 'Turing',
    email: null,
    age: 41,
    active: false,
    createdAt: '2024-03-05T00:00:00Z',
    tags: ['math'],
    teamId: 2,
    posts: [
      { id: 11, title: 'Computable Numbers', published: true },
      { id: 12, title: 'Draft 100%', published: false },
    ],
  },
  {
    id: 3,
    first: 'Grace',
    last: 'Hopper',
    email: '',
    age: null,
    active: true,
    createdAt: '2023-12-09T00:00:00Z',
    tags: null,
    teamId: null,
    posts: [],
  },
  {
    id: 4,
    first: 'edsger',
    last: 'Dijkstra',
    email: 'EWD@example.com',
    age: 72,
    active: true,
    createdAt: '2024-05-11T00:00:00Z',
    tags: [],
    teamId: 1,
    posts: [],
  },
];

const everything: FilterConfig = { allowed: '*', maxSize: 100 };

function ids(input: FilterInput, config: FilterConfig = everything): number[] {
  return filterInMemory(users, rows, input, config).data.map((u) => u.id);
}

function where(...filters: ColumnFilter[]): FilterInput {
  return { filters };
}

describe('in-memory adapter — operators', () => {
  it('equals / notEquals with SQL NULL semantics', () => {
    expect(ids(where({ field: 'first', operator: 'equals', value: 'Ada' }))).toEqual([1]);
    // equals is case-sensitive (`=`), like the SQL it mirrors
    expect(ids(where({ field: 'first', operator: 'equals', value: 'ada' }))).toEqual([]);
    // a NULL age is neither 41 nor "not 41"
    expect(ids(where({ field: 'age', operator: 'notEquals', value: 41 }))).toEqual([1, 4]);
    // the runner rejects `equals: null` (use isNull); at the builder level knex's
    // `where(col, null)` is `IS NULL`, and the in-memory builder agrees
    expect(() => ids(where({ field: 'email', operator: 'equals', value: null }))).toThrow(
      InvalidColumnFilterError,
    );
    expect(
      users
        .query(rows)
        .where('email', null)
        .all()
        .map((u) => u.id),
    ).toEqual([2]);
    expect(
      users
        .query(rows)
        .whereNot('email', null)
        .all()
        .map((u) => u.id),
    ).toEqual([1, 3, 4]);
  });

  it('coerces filter values to the declared field kind', () => {
    expect(ids(where({ field: 'age', operator: 'equals', value: '36' }))).toEqual([1]);
    expect(ids(where({ field: 'active', operator: 'equals', value: 'false' }))).toEqual([2]);
    expect(ids(where({ field: 'active', operator: 'equals', value: '1' }))).toEqual([1, 3, 4]);
    expect(ids(where({ field: 'createdAt', operator: 'gte', value: '2024-03-01' }))).toEqual([
      2, 4,
    ]);
  });

  it('coerces through the runner when fieldTypes are declared, rejecting garbage', () => {
    const config: FilterConfig = {
      allowed: '*',
      fieldTypes: users.fieldTypes,
      throwOnInvalid: true,
    };
    expect(ids(where({ field: 'age', operator: 'gt', value: '40' }), config)).toEqual([2, 4]);
    expect(() => ids(where({ field: 'age', operator: 'gt', value: 'old' }), config)).toThrow(
      InvalidColumnFilterError,
    );
  });

  it('comparisons and between skip NULLs', () => {
    expect(ids(where({ field: 'age', operator: 'lt', value: 50 }))).toEqual([1, 2]);
    expect(ids(where({ field: 'age', operator: 'between', value: [30, 40] }))).toEqual([1]);
    expect(ids(where({ field: 'age', operator: 'notBetween', value: [30, 40] }))).toEqual([2, 4]);
  });

  it('in / notIn, with NOT IN over a NULL-bearing list matching nothing', () => {
    expect(ids(where({ field: 'id', operator: 'in', value: ['1', '3'] }))).toEqual([1, 3]);
    expect(ids(where({ field: 'age', operator: 'notIn', value: [36] }))).toEqual([2, 4]);
    const qb = users.query(rows).whereNotIn('age', [36, null]);
    expect(qb.all()).toEqual([]);
    expect(users.query(rows).whereIn('id', []).all()).toEqual([]);
    expect(users.query(rows).whereNotIn('age', []).all()).toHaveLength(4);
  });

  it('LIKE operators are ILIKE (the Lucid adapter emits whereILike) with escaped wildcards', () => {
    expect(ids(where({ field: 'last', operator: 'contains', value: 'OVE' }))).toEqual([1]);
    expect(ids(where({ field: 'first', operator: 'startsWith', value: 'ED' }))).toEqual([4]);
    expect(ids(where({ field: 'last', operator: 'endsWith', value: 'ing' }))).toEqual([2]);
    expect(ids(where({ field: 'posts.title', operator: 'contains', value: '100%' }))).toEqual([2]);
    // `%` in the value is literal, not a wildcard
    expect(ids(where({ field: 'posts.title', operator: 'contains', value: '%' }))).toEqual([2]);
  });

  it('LIKE on a non-string field matches the stringified value', () => {
    expect(ids(where({ field: 'age', operator: 'contains', value: '7' }))).toEqual([4]);
  });

  it('isNull / isNotNull / isEmpty / isNotEmpty mirror the Lucid translation', () => {
    expect(ids(where({ field: 'age', operator: 'isNull' }))).toEqual([3]);
    expect(ids(where({ field: 'age', operator: 'isNotNull' }))).toEqual([1, 2, 4]);
    // Lucid emits `= ''` / `<> ''`: NULL is neither empty nor not-empty
    expect(ids(where({ field: 'email', operator: 'isEmpty' }))).toEqual([3]);
    expect(ids(where({ field: 'email', operator: 'isNotEmpty' }))).toEqual([1, 4]);
  });

  it('virtual fields filter and sort like columns', () => {
    expect(ids(where({ field: 'fullName', operator: 'equals', value: 'Alan Turing' }))).toEqual([
      2,
    ]);
    expect(ids({ sort: [{ field: 'fullName', direction: 'desc' }] })).toEqual([4, 3, 2, 1]);
  });

  it('array fields: any element for scalar ops, no element for negated ops', () => {
    expect(ids(where({ field: 'tags', operator: 'equals', value: 'poet' }))).toEqual([1]);
    expect(ids(where({ field: 'tags', operator: 'in', value: ['math'] }))).toEqual([1, 2]);
    expect(ids(where({ field: 'tags', operator: 'contains', value: 'OE' }))).toEqual([1]);
    // no element is 'poet' — the empty array qualifies, the NULL array does not
    expect(ids(where({ field: 'tags', operator: 'notEquals', value: 'poet' }))).toEqual([2, 4]);
    expect(ids(where({ field: 'tags', operator: 'notIn', value: ['math'] }))).toEqual([4]);
  });
});

describe('in-memory adapter — composition and relations', () => {
  it('AND / OR groups follow the Lucid grouping', () => {
    const input = where({
      field: '',
      operator: 'equals',
      OR: [
        { field: 'first', operator: 'equals', value: 'Ada' },
        { field: 'age', operator: 'gt', value: 70 },
      ],
    });
    expect(ids(input)).toEqual([1, 4]);

    const nested = where(
      { field: 'active', operator: 'equals', value: true },
      {
        field: '',
        operator: 'equals',
        OR: [
          { field: 'age', operator: 'isNull' },
          { field: 'age', operator: 'gt', value: 70 },
        ],
      },
    );
    expect(ids(nested)).toEqual([3, 4]);
  });

  it('dotted to-many paths use EXISTS semantics', () => {
    expect(ids(where({ field: 'posts.published', operator: 'equals', value: false }))).toEqual([2]);
    expect(ids(where({ field: 'posts.id', operator: 'isNotNull' }))).toEqual([1, 2]);
  });

  it('dotted to-one paths filter and sort', () => {
    expect(ids(where({ field: 'team.name', operator: 'equals', value: 'Core' }))).toEqual([1, 4]);
    expect(
      users
        .query(rows)
        .orderBy('team.name', 'desc')
        .all()
        .map((u) => u.id),
    ).toEqual([3, 2, 1, 4]);
  });

  it('respects the allow-list and relation specs from defineFilter', async () => {
    const spec = defineFilter({
      filterable: users.filterable,
      sortable: ['age'],
      searchable: ['first', 'last'],
      relations: { posts: { filterable: ['title'] } },
      defaultSort: [{ field: 'age', direction: 'asc' }],
      throwOnInvalid: true,
    });
    const qb = users.query(rows);
    const { page, size } = applyFilterFromRequest(qb, spec, {
      request: { qs: () => ({ filter: { age: { gte: '30' } }, search: 'a' }) },
    });
    expect(qb.paginate(page, size).data.map((u) => u.id)).toEqual([1, 2, 4]);

    expect(() =>
      applyFilterFromRequest(users.query(rows), spec, {
        request: { qs: () => ({ filter: { posts: { published: true } } }) },
      }),
    ).toThrow(InvalidColumnFilterError);
  });
});

describe('in-memory adapter — search, sort, pagination, distinct', () => {
  it('search is a case-insensitive OR across searchable fields', () => {
    const config: FilterConfig = { allowed: '*', searchable: ['first', 'email'] };
    expect(ids({ search: 'EWD' }, config)).toEqual([4]);
    expect(ids({ search: 'al' }, config)).toEqual([2]);
    // combined with a filter: search ANDs with it
    expect(
      ids({ search: 'a', filters: [{ field: 'active', operator: 'equals', value: true }] }, config),
    ).toEqual([1, 3, 4]);
  });

  it('sorts with NULLS LAST ascending and NULLS FIRST descending', () => {
    expect(ids({ sort: [{ field: 'age', direction: 'asc' }] })).toEqual([1, 2, 4, 3]);
    expect(ids({ sort: [{ field: 'age', direction: 'desc' }] })).toEqual([3, 4, 2, 1]);
    expect(
      ids({
        sort: [
          { field: 'active', direction: 'desc' },
          { field: 'createdAt', direction: 'asc' },
        ],
      }),
    ).toEqual([3, 1, 4, 2]);
  });

  it('drops sorts on non-sortable fields', () => {
    expect(ids({ sort: [{ field: 'age', direction: 'desc' }] }, { allowed: ['first'] })).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('offset-paginates with the resolved (clamped) page size', () => {
    const page = filterInMemory(
      users,
      rows,
      { sort: [{ field: 'id', direction: 'asc' }], page: 2, size: 3 },
      { allowed: '*' },
    );
    expect(page.data.map((u) => u.id)).toEqual([4]);
    expect(page.meta).toEqual({ total: 4, perPage: 3, currentPage: 2, lastPage: 2, firstPage: 1 });

    const clamped = filterInMemory(users, rows, { size: 1000 }, { allowed: '*', maxSize: 2 });
    expect(clamped.meta.perPage).toBe(2);
  });

  it('projects distinct values under the active filters', () => {
    const page = filterInMemory(
      users,
      rows,
      {
        distinct: ['active'],
        sort: [{ field: 'active', direction: 'asc' }],
      },
      { allowed: '*' },
    );
    expect(page.data).toEqual([{ active: false }, { active: true }]);
    expect(page.meta.total).toBe(2);
  });

  it('parses the wire format end to end', () => {
    const input = parseFilterRequest({
      filter: { age: { gte: '36' }, active: 'true' },
      sort: '-age',
      page: '1',
      size: '10',
    });
    expect(ids(input, { allowed: '*', fieldTypes: users.fieldTypes })).toEqual([4, 1]);
  });
});

describe('in-memory adapter — cursor pagination', () => {
  const config = { allowed: '*' as const, maxSize: 100 };

  it('walks forward and backward through keyset pages', () => {
    const sort = [{ field: 'age', direction: 'asc' as const }];
    const first = cursorInMemory(users, rows, { sort, first: 2 }, config);
    expect(first.items.map((u) => u.id)).toEqual([1, 2]);
    expect(first.hasNext).toBe(true);
    expect(first.hasPrev).toBe(false);

    const second = cursorInMemory(
      users,
      rows,
      { sort, first: 2, after: first.nextCursor as string },
      config,
    );
    // SQL keyset semantics: the NULL-age row can never satisfy `age > 41`
    expect(second.items.map((u) => u.id)).toEqual([4]);
    expect(second.hasPrev).toBe(true);

    const back = cursorInMemory(
      users,
      rows,
      { sort, last: 2, before: second.prevCursor as string },
      config,
    );
    expect(back.items.map((u) => u.id)).toEqual([1, 2]);
  });

  it('uses the collection primary key and reads virtual keyset fields', () => {
    const sort = [{ field: 'fullName', direction: 'asc' as const }];
    const first = cursorInMemory(users, rows, { sort, first: 1 }, config);
    expect(first.items.map((u) => u.id)).toEqual([1]);
    const next = cursorInMemory(
      users,
      rows,
      { sort, first: 3, after: first.nextCursor as string },
      config,
    );
    expect(next.items.map((u) => u.id)).toEqual([2, 3, 4]);
    expect(next.hasNext).toBe(false);
  });
});

describe('in-memory adapter — group by count', () => {
  const spec = defineFilter({ filterable: users.filterable });

  it('counts values over the filtered rows, most frequent first', async () => {
    const result = await groupByCountFromRequest(users.query(rows), spec, {
      request: { qs: () => ({ filter: { active: 'true' }, groupByCount: { field: 'teamId' } }) },
    });
    expect(result).toEqual([
      { value: 1, count: 2 },
      { value: null, count: 1 },
    ]);
  });

  it('unnests array fields and narrows by search', async () => {
    const all = await groupByCountFromRequest(users.query(rows), spec, undefined, {
      field: 'tags',
    });
    expect(all).toEqual([
      { value: 'math', count: 2 },
      { value: 'poet', count: 1 },
      { value: null, count: 1 },
    ]);
    const searched = await groupByCountFromRequest(users.query(rows), spec, undefined, {
      field: 'tags',
      search: 'PO',
    });
    expect(searched).toEqual([{ value: 'poet', count: 1 }]);
  });
});

describe('in-memory adapter — SQL-only features fail loudly', () => {
  it('rejects policy computed fields and raw SQL', () => {
    const qb = users.query(rows);
    expect(() =>
      applyFilter(qb, where({ field: 'x', operator: 'equals', value: 1 }), {
        allowed: '*',
        computed: { x: 'a + b' },
      }),
    ).toThrow(InMemoryQueryError);
    expect(() => users.query(rows).orderByRaw('random()')).toThrow(InMemoryQueryError);
  });

  it('rejects an undeclared relation path', () => {
    expect(() => ids(where({ field: 'ghost.name', operator: 'equals', value: 'x' }))).toThrow(
      InMemoryQueryError,
    );
  });

  it('never reads inherited properties for undeclared fields', () => {
    expect(ids(where({ field: 'constructor', operator: 'isNotNull' }))).toEqual([]);
  });
});
