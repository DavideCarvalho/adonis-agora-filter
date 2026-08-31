import { describe, expect, it } from 'vitest';
import { discoverAggregateSources, type LucidModelLike } from '../src/aggregate.js';
import { applyComputedField } from '../src/lucid_adapter.js';
import type { ComputedSource } from '../src/types.js';
import { MockQueryBuilder } from './mock_query_builder.js';

/** Build a fake Lucid-like model whose $getRelation returns canned metadata. */
function fakeModel(
  relations: Record<string, Record<string, unknown>>,
  table = 'root',
): LucidModelLike {
  return {
    table,
    $getRelation(name: string) {
      const rel = relations[name];
      if (!rel) return undefined;
      return {
        boot() {},
        relatedModel: () => ({ table: rel.childTable as string }),
        ...rel,
      } as never;
    },
  };
}

const render = (source: ComputedSource, alias: string): string =>
  typeof source === 'function' ? source({ alias }) : source;

describe('discoverAggregateSources — hasMany (one-to-many)', () => {
  const model = fakeModel(
    {
      posts: {
        type: 'hasMany',
        childTable: 'posts',
        foreignKeyColumnName: 'author_id',
        localKeyColumnName: 'id',
      },
    },
    'authors',
  );

  it('synthesises $count and the declared numeric column aggregates only', () => {
    const sources = discoverAggregateSources(model, {
      posts: { aggregates: ['views'] },
    });
    expect(Object.keys(sources).sort()).toEqual(
      [
        'posts.$avg.views',
        'posts.$count',
        'posts.$max.views',
        'posts.$min.views',
        'posts.$sum.views',
      ].sort(),
    );
  });

  it('compiles a correlated COUNT subquery with quoted identifiers and the outer alias', () => {
    const { 'posts.$count': count } = discoverAggregateSources(model, { posts: {} });
    expect(render(count!, 'authors')).toBe(
      '(SELECT COUNT(*) FROM "posts" WHERE "posts"."author_id" = "authors"."id")',
    );
  });

  it('coalesces SUM to 0 (empty-collection semantics) but not AVG/MIN/MAX', () => {
    const s = discoverAggregateSources(model, { posts: { aggregates: ['views'] } });
    expect(render(s['posts.$sum.views']!, 'authors')).toContain('COALESCE(SUM("posts"."views"),0)');
    expect(render(s['posts.$avg.views']!, 'authors')).toContain('AVG("posts"."views")');
    expect(render(s['posts.$min.views']!, 'authors')).toContain('MIN("posts"."views")');
    expect(render(s['posts.$max.views']!, 'authors')).toContain('MAX("posts"."views")');
  });
});

describe('discoverAggregateSources — manyToMany (pivot)', () => {
  const model = fakeModel(
    {
      tags: {
        type: 'manyToMany',
        childTable: 'tags',
        pivotTable: 'article_tag',
        pivotForeignKey: 'article_id',
        pivotRelatedForeignKey: 'tag_id',
        localKeyColumnName: 'id',
        relatedKeyColumnName: 'id',
      },
    },
    'articles',
  );

  it('$count counts pivot rows directly (no child join)', () => {
    const { 'tags.$count': count } = discoverAggregateSources(model, { tags: {} });
    expect(render(count!, 'articles')).toBe(
      '(SELECT COUNT(*) FROM "article_tag" WHERE "article_tag"."article_id" = "articles"."id")',
    );
  });

  it('$sum joins pivot → child inside the scalar subquery', () => {
    const { 'tags.$sum.weight': sum } = discoverAggregateSources(model, {
      tags: { aggregates: ['weight'] },
    });
    expect(render(sum!, 'articles')).toBe(
      '(SELECT COALESCE(SUM("tags"."weight"),0) FROM "tags" JOIN "article_tag" ON "tags"."id" = "article_tag"."tag_id" WHERE "article_tag"."article_id" = "articles"."id")',
    );
  });
});

describe('discoverAggregateSources — gating & degradation', () => {
  it('returns an empty map without a model (capability guard)', () => {
    expect(discoverAggregateSources(undefined, { posts: { aggregates: ['views'] } })).toEqual({});
  });

  it('excludes to-one relations (belongsTo / hasOne)', () => {
    const model = fakeModel({
      author: {
        type: 'belongsTo',
        childTable: 'authors',
        foreignKeyColumnName: 'author_id',
        localKeyColumnName: 'id',
      },
    });
    expect(discoverAggregateSources(model, { author: { aggregates: ['x'] } })).toEqual({});
  });

  it('skips a relation that cannot be booted (degrades gracefully)', () => {
    const model: LucidModelLike = {
      table: 'root',
      $getRelation() {
        return {
          type: 'hasMany',
          boot() {
            throw new Error('no adapter');
          },
          relatedModel: () => ({ table: 't' }),
        } as never;
      },
    };
    expect(discoverAggregateSources(model, { posts: { aggregates: ['views'] } })).toEqual({});
  });
});

describe('aggregate value binding (injection safety)', () => {
  it('an aggregate source, applied via applyComputedField, binds the value with ?', () => {
    const model = fakeModel(
      {
        posts: {
          type: 'hasMany',
          childTable: 'posts',
          foreignKeyColumnName: 'author_id',
          localKeyColumnName: 'id',
        },
      },
      'authors',
    );
    const { 'posts.$count': count } = discoverAggregateSources(model, { posts: {} });
    const qb = new MockQueryBuilder();
    applyComputedField(qb, render(count!, 'authors'), {
      field: 'posts.$count',
      operator: 'gt',
      value: 3,
    });
    const call = qb.find('whereRaw');
    // The client value is a positional binding — never concatenated into the SQL.
    expect(call?.args[0]).toBe(
      '((SELECT COUNT(*) FROM "posts" WHERE "posts"."author_id" = "authors"."id")) > ?',
    );
    expect(call?.args[1]).toEqual([3]);
  });
});
