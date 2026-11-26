import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyFilterFromRequest } from '../src/apply_from_request.js';
import { explainFilterQuery } from '../src/dev_tools/explain.js';
import { defineFilter, specToFilterConfig } from '../src/filter_spec.js';
import { generateFilterClient } from '../src/generate_client.js';
import { InvalidColumnFilterError } from '../src/validate-column-filter.js';
import { MockQueryBuilder } from './mock_query_builder.js';

function ctxOf(qs: Record<string, unknown>) {
  return { request: { qs: () => qs } };
}

/** Run `fn`, return the error it throws (fails the test when it does not throw). */
function thrown(fn: () => unknown): InvalidColumnFilterError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidColumnFilterError);
    return error as InvalidColumnFilterError;
  }
  throw new Error('expected an InvalidColumnFilterError');
}

describe('relation columns are deny-by-default', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a relation declared as `{}` exposes no column to filter or sort', () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const spec = defineFilter({ filterable: ['title'], relations: { author: {} } });

    expect(spec.isFilterable('author.password')).toBe(false);
    expect(spec.isFilterable('author.name')).toBe(false);
    expect(spec.isSortable('author.password')).toBe(false);
    expect(spec.relations.author).toMatchObject({ filterable: [], sortable: [] });
  });

  it('blocks the char-by-char secret extraction with a 400 naming the option to add', () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const spec = defineFilter({ filterable: ['title'], relations: { author: {} } });
    const qb = new MockQueryBuilder();

    const error = thrown(() =>
      applyFilterFromRequest(
        qb,
        spec,
        ctxOf({ filter: { 'author.password': { startsWith: '$2a$' } } }),
      ),
    );

    expect(error.status).toBe(400);
    expect(error.code).toBe('E_INVALID_COLUMN_FILTER');
    expect(error.message).toBe(
      'Field "author.password" is not filterable: "password" is not in the allow-list of relation ' +
        '"author". To allow it, add \'password\' to `relations.author.filterable` in the filter spec.',
    );
    expect(qb.find('whereHas')).toBeUndefined();
  });

  it('rejects even without throwOnInvalid (a silent drop would hide the breaking change)', () => {
    const spec = defineFilter({
      filterable: ['title'],
      relations: { author: { filterable: ['name'] } },
    });
    expect(spec.throwOnInvalid).toBe(false);
    expect(() =>
      applyFilterFromRequest(
        new MockQueryBuilder(),
        spec,
        ctxOf({ filter: { 'author.email': 'x' } }),
      ),
    ).toThrow(InvalidColumnFilterError);
  });

  it('applies listed relation columns', () => {
    const spec = defineFilter({
      filterable: ['title'],
      relations: { author: { filterable: ['name'] } },
    });
    const qb = new MockQueryBuilder();
    applyFilterFromRequest(qb, spec, ctxOf({ filter: { 'author.name': 'Ada' } }));
    expect(qb.find('whereHas')?.args).toEqual(['author']);
    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['name', 'Ada'] });
  });

  it('names the sortable option for a sort on an unlisted relation column', () => {
    const spec = defineFilter({
      filterable: ['title'],
      relations: { author: { filterable: ['name'], sortable: ['createdAt'] } },
    });
    const error = thrown(() =>
      applyFilterFromRequest(new MockQueryBuilder(), spec, ctxOf({ sort: 'author.name' })),
    );
    expect(error.message).toContain('`relations.author.sortable`');

    const qb = new MockQueryBuilder();
    applyFilterFromRequest(qb, spec, ctxOf({ sort: '-author.createdAt' }));
    expect(qb.flatten()).toContainEqual({ method: 'orderBy', args: ['author.createdAt', 'desc'] });
  });

  it('names the nested option path for a deeper relation', () => {
    const spec = defineFilter({
      filterable: ['name'],
      relations: {
        posts: { filterable: ['title'], relations: { comments: { filterable: ['body'] } } },
      },
    });
    const allowed = specToFilterConfig(spec).allowed as (field: string) => boolean;
    const error = thrown(() => allowed('posts.comments.email'));
    expect(error.message).toContain('`relations.posts.relations.comments.filterable`');
  });

  it('keeps dropping fields on undeclared relations and base columns (no new 400s there)', () => {
    const spec = defineFilter({
      filterable: ['name'],
      relations: { posts: { filterable: ['title'] } },
    });
    const qb = new MockQueryBuilder();
    applyFilterFromRequest(
      qb,
      spec,
      ctxOf({ filter: { 'secrets.key': 'x', secret: 'y', name: 'A' } }),
    );
    const flat = qb.flatten();
    expect(flat).toContainEqual({ method: 'where', args: ['name', 'A'] });
    expect(
      flat.find((c) => c.args.includes('secrets') || c.args.includes('secret')),
    ).toBeUndefined();
  });

  it('a distinct on an unlisted relation column is dropped quietly, as before', () => {
    const spec = defineFilter({
      filterable: ['city'],
      relations: { posts: { filterable: ['title'] } },
    });
    const qb = new MockQueryBuilder();
    applyFilterFromRequest(qb, spec, ctxOf({ distinct: 'posts.secret,city' }));
    expect(qb.flatten().find((c) => c.args.includes('posts.secret'))).toBeUndefined();
  });

  it("an explicit '*' still opts every related column in", () => {
    const spec = defineFilter({ filterable: ['name'], relations: { posts: { filterable: '*' } } });
    expect(spec.isFilterable('posts.anything')).toBe(true);
    expect(spec.isSortable('posts.anything')).toBe(true);
  });

  it('explainFilterQuery reports the refusal with the actionable message', () => {
    const spec = defineFilter({ filterable: ['name'], relations: { author: { filterable: [] } } });
    const out = explainFilterQuery(spec, 'filter[author.password][startsWith]=x');
    expect(out.issues[0]).toMatchObject({ subject: 'author.password', effect: 'rejected' });
    expect(out.issues[0]?.message).toContain('relations.author.filterable');
  });

  it('codegen emits no field paths for a relation with no listed columns', () => {
    const spec = defineFilter({ filterable: ['name'], relations: { author: { filterable: [] } } });
    const out = generateFilterClient(spec, { name: 'users' });
    expect(out).not.toContain('author.');
  });
});

describe('dev-time warning for a relation declared without `filterable`', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.restoreAllMocks();
  });

  it('warns once per such relation, naming the option to add', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    defineFilter({
      filterable: ['title'],
      relations: { author: {}, posts: { relations: { comments: {} } } },
    });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('relation "author" declares no `filterable` columns');
    expect(messages[0]).toContain("`relations.author.filterable: ['name']`");
    expect(messages[2]).toContain('`relations.posts.relations.comments.filterable');
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ code: 'AGORA_FILTER_RELATION_COLUMNS' });
  });

  it('stays quiet when filterable/sortable/aggregates is declared (even `[]`)', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    defineFilter({
      filterable: ['title'],
      relations: {
        author: { filterable: [] },
        tags: { sortable: ['name'] },
        posts: { aggregates: ['views'] },
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('never warns in production', () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    defineFilter({ filterable: ['title'], relations: { author: {} } });
    expect(warn).not.toHaveBeenCalled();
  });
});
