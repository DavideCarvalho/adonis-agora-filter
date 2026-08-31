import { BaseModel, column, hasMany, manyToMany } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineFilter } from '../src/filter_spec.js';
import { applyFilter } from '../src/runner.js';
import { createPgHarness, type PgHarness, probePgReachable } from './support/pg.js';

// Resolved at collection time so the pg-backed blocks skip (not fail) when no
// Postgres is reachable.
const pgUp = await probePgReachable();

/**
 * To-many aggregate fields ($count/$sum/$avg/$min/$max) against real Postgres,
 * with real Lucid models — auto-discovered from hasMany / manyToMany relation
 * metadata and compiled to correlated scalar subqueries. Proves filter + sort
 * correctness over seeded parent/child rows, the pivot (m2m) correlation, and
 * that the client value stays parameterized (no injection).
 */

let harness: PgHarness;

// ── hasMany: Author → posts ──────────────────────────────────────────────
class Post extends BaseModel {
  static table = 'agg_posts';
  declare id: number;
  declare authorId: number;
  declare views: number;
}
column({ isPrimary: true })(Post.prototype, 'id');
column()(Post.prototype, 'authorId');
column()(Post.prototype, 'views');

class Author extends BaseModel {
  static table = 'agg_authors';
  declare id: number;
  declare name: string;
}
column({ isPrimary: true })(Author.prototype, 'id');
column()(Author.prototype, 'name');
hasMany(() => Post, { foreignKey: 'authorId' })(Author.prototype, 'posts');

// ── manyToMany: Article ↔ tags (weight on tag) ───────────────────────────
class Tag extends BaseModel {
  static table = 'agg_tags';
  declare id: number;
  declare weight: number;
}
column({ isPrimary: true })(Tag.prototype, 'id');
column()(Tag.prototype, 'weight');

class Article extends BaseModel {
  static table = 'agg_articles';
  declare id: number;
  declare title: string;
}
column({ isPrimary: true })(Article.prototype, 'id');
column()(Article.prototype, 'title');
manyToMany(() => Tag, {
  pivotTable: 'agg_article_tag',
  pivotForeignKey: 'article_id',
  pivotRelatedForeignKey: 'tag_id',
})(Article.prototype, 'tags');

const authorSpec = defineFilter({
  model: Author,
  filterable: ['name'],
  relations: { posts: { filterable: ['views'], aggregates: ['views'] } },
});

const articleSpec = defineFilter({
  model: Article,
  filterable: ['title'],
  relations: { tags: { aggregates: ['weight'] } },
});

beforeAll(async () => {
  if (!pgUp) return;
  harness = createPgHarness();
  for (const t of ['agg_posts', 'agg_authors', 'agg_article_tag', 'agg_tags', 'agg_articles']) {
    await harness.raw(`drop table if exists ${t}`);
  }
  await harness.raw('create table agg_authors (id serial primary key, name text not null)');
  await harness.raw(
    'create table agg_posts (id serial primary key, author_id int not null, views int not null)',
  );
  // Seeded so $sum order (Zoe 100 > Ada 60 > Alan 5 > Grace 0) deliberately
  // DIFFERS from id order — a sort test that merely returned rows in insertion
  // order would then be wrong. Grace has no posts (empty-collection → sum 0,
  // max NULL). Ada: [10,20,30] count3 sum60 max30; Alan: [5]; Zoe: [100].
  await harness.raw(
    "insert into agg_authors (id, name) values (1,'Ada'),(2,'Alan'),(3,'Grace'),(4,'Zoe')",
  );
  await harness.raw(
    'insert into agg_posts (author_id, views) values (1,10),(1,20),(1,30),(2,5),(4,100)',
  );

  await harness.raw('create table agg_articles (id serial primary key, title text not null)');
  await harness.raw('create table agg_tags (id serial primary key, weight int not null)');
  await harness.raw('create table agg_article_tag (article_id int not null, tag_id int not null)');
  // A1 → tags with weights 2 & 3 (sum 5, count 2); A2 → tag weight 7 (sum 7, count 1); A3 → no tags.
  await harness.raw("insert into agg_articles (id, title) values (1,'A1'),(2,'A2'),(3,'A3')");
  await harness.raw('insert into agg_tags (id, weight) values (1,2),(2,3),(3,7)');
  await harness.raw('insert into agg_article_tag (article_id, tag_id) values (1,1),(1,2),(2,3)');
});

afterAll(async () => {
  if (harness) await harness.close();
});

describe('aggregate discovery from relation metadata', () => {
  it('synthesises $count + declared numeric column aggregates for a hasMany relation', () => {
    const keys = Object.keys(authorSpec.computed ?? {});
    expect(keys).toContain('posts.$count');
    expect(keys).toContain('posts.$sum.views');
    expect(keys).toContain('posts.$avg.views');
    expect(keys).toContain('posts.$min.views');
    expect(keys).toContain('posts.$max.views');
    // No aggregate for an undeclared child column.
    expect(keys).not.toContain('posts.$sum.id');
  });

  it('defaults the correlated-subquery alias to the model table name', () => {
    expect(authorSpec.table).toBe('agg_authors');
  });
});

describe.skipIf(!pgUp)('hasMany aggregates against real Postgres', () => {
  it('filters by $count (> 1 post)', async () => {
    const query = Author.query();
    applyFilter(
      query as never,
      {
        filters: [{ field: 'posts.$count', operator: 'gt', value: 1 }],
        sort: [{ field: 'name', direction: 'asc' }],
      },
      {
        allowed: authorSpec.filterable as string[],
        computed: authorSpec.computed,
        table: authorSpec.table,
      },
    );
    const rows = await query;
    expect(rows.map((r) => r.name)).toEqual(['Ada']);
  });

  it('sorts by $sum.views descending (empty collection sums to 0)', async () => {
    const query = Author.query();
    applyFilter(
      query as never,
      { sort: [{ field: 'posts.$sum.views', direction: 'desc' }] },
      {
        allowed: authorSpec.filterable as string[],
        computed: authorSpec.computed,
        table: authorSpec.table,
      },
    );
    const rows = await query;
    // Zoe sum=100 > Ada sum=60 > Alan sum=5 > Grace sum=0 (COALESCE on empty).
    // This order is NOT the insertion/id order, so a dropped sort would fail here.
    expect(rows.map((r) => r.name)).toEqual(['Zoe', 'Ada', 'Alan', 'Grace']);
  });

  it('filters by $max.views', async () => {
    const query = Author.query();
    applyFilter(
      query as never,
      {
        filters: [{ field: 'posts.$max.views', operator: 'gte', value: 30 }],
        sort: [{ field: 'name', direction: 'asc' }],
      },
      {
        allowed: authorSpec.filterable as string[],
        computed: authorSpec.computed,
        table: authorSpec.table,
      },
    );
    const rows = await query;
    // Ada max=30, Zoe max=100 → both >= 30 (Grace max is NULL, Alan max 5).
    expect(rows.map((r) => r.name)).toEqual(['Ada', 'Zoe']);
  });
});

describe.skipIf(!pgUp)('manyToMany aggregates against real Postgres', () => {
  it('filters by pivot $count', async () => {
    const query = Article.query();
    applyFilter(
      query as never,
      {
        filters: [{ field: 'tags.$count', operator: 'gte', value: 2 }],
        sort: [{ field: 'title', direction: 'asc' }],
      },
      {
        allowed: articleSpec.filterable as string[],
        computed: articleSpec.computed,
        table: articleSpec.table,
      },
    );
    const rows = await query;
    // Only A1 has 2 tags.
    expect(rows.map((r) => r.title)).toEqual(['A1']);
  });

  it('sorts by $sum.weight through the pivot join', async () => {
    const query = Article.query();
    applyFilter(
      query as never,
      { sort: [{ field: 'tags.$sum.weight', direction: 'desc' }] },
      {
        allowed: articleSpec.filterable as string[],
        computed: articleSpec.computed,
        table: articleSpec.table,
      },
    );
    const rows = await query;
    // A2 weight=7 > A1 weight=5 > A3 weight=0 (empty → COALESCE 0).
    expect(rows.map((r) => r.title)).toEqual(['A2', 'A1', 'A3']);
  });
});

describe.skipIf(!pgUp)('aggregate injection safety', () => {
  it('binds the client value — a non-numeric injection payload reaches PG as data, not SQL', async () => {
    const query = Author.query();
    // If the value were concatenated, `(...) > 0 OR 1=1` would return every
    // author. As a bound parameter, PG casts the text to the count's numeric
    // type and rejects it — proving it never became SQL. Either way it CANNOT
    // silently return all rows.
    applyFilter(
      query as never,
      { filters: [{ field: 'posts.$count', operator: 'gt', value: '0 OR 1=1' }] },
      {
        allowed: authorSpec.filterable as string[],
        computed: authorSpec.computed,
        table: authorSpec.table,
      },
    );
    await expect(query).rejects.toThrow();
  });
});
