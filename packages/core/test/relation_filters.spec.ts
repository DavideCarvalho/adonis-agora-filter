import { describe, expect, it } from 'vitest';
import { applyFilterFromRequest } from '../src/apply_from_request.js';
import { defineFilter } from '../src/filter_spec.js';
import { applyColumnFilters } from '../src/lucid_adapter.js';
// Exercise the *published* testing helper exactly as a consumer would import it
// (`@adonis-agora/filter/testing` resolves to this module).
import { MockQueryBuilder, makeMockQueryBuilder } from '../src/testing.js';

/**
 * Locate the `whereHas('<relation>')` child recorder anywhere in the tree.
 * `children` are appended in the same order as their group/whereHas markers in
 * `calls`, so we walk `calls` and advance a child cursor for each marker — this
 * lets a test prove a relation subquery is nested *inside* another, not merely
 * that both `whereHas` calls exist somewhere.
 */
function relationChild(qb: MockQueryBuilder, relation: string): MockQueryBuilder | undefined {
  let ci = 0;
  for (const call of qb.calls) {
    const isGroup = call.args[0] === '<group>';
    const isWhereHas = call.method === 'whereHas';
    if (!isGroup && !isWhereHas) continue;
    const child = qb.children[ci++];
    if (!child) continue;
    if (isWhereHas && call.args[0] === relation) return child;
    const nested = relationChild(child, relation);
    if (nested) return nested;
  }
  return undefined;
}

describe('lucid adapter — relation (whereHas) translation', () => {
  it('translates a single-level relation path into whereHas + nested where', () => {
    const qb = new MockQueryBuilder();
    applyColumnFilters(qb, [{ field: 'posts.title', operator: 'equals', value: 'Hi' }]);

    expect(qb.find('whereHas')?.args).toEqual(['posts']);
    // The leaf operator lands on the *bare* column inside the relation subquery.
    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['title', 'Hi'] });

    const posts = relationChild(qb, 'posts');
    expect(posts).toBeDefined();
    expect(posts?.find('where')?.args).toEqual(['title', 'Hi']);
  });

  it('supports the full operator set inside a relation subquery', () => {
    const qb = new MockQueryBuilder();
    applyColumnFilters(qb, [{ field: 'posts.title', operator: 'contains', value: 'foo' }]);

    const posts = relationChild(qb, 'posts');
    expect(posts?.find('whereILike')?.args).toEqual(['title', '%foo%']);
    // No dotted column reference leaks to the outer builder.
    expect(qb.flatten().some((c) => c.args[0] === 'posts.title')).toBe(false);
  });

  it('nests deeper relation paths (depth 2) as whereHas within whereHas', () => {
    const qb = new MockQueryBuilder();
    applyColumnFilters(qb, [{ field: 'posts.comments.body', operator: 'equals', value: 'x' }]);

    const posts = relationChild(qb, 'posts');
    expect(posts).toBeDefined();
    // `comments` must be nested INSIDE the `posts` subquery, not a sibling.
    const comments = posts && relationChild(posts, 'comments');
    expect(comments).toBeDefined();
    expect(comments?.find('where')?.args).toEqual(['body', 'x']);
    // The outer builder itself never sees a `comments` whereHas.
    expect(relationChild(qb, 'comments')).toBe(posts && relationChild(posts, 'comments'));
  });

  it('combines a relation filter with a top-level base-column filter', () => {
    const qb = new MockQueryBuilder();
    applyColumnFilters(qb, [
      { field: 'name', operator: 'equals', value: 'Al' },
      { field: 'posts.title', operator: 'equals', value: 'Hi' },
    ]);

    const flat = qb.flatten();
    // Base column stays a plain where on the root builder.
    expect(flat).toContainEqual({ method: 'where', args: ['name', 'Al'] });
    // Relation column goes through whereHas.
    expect(qb.find('whereHas')?.args).toEqual(['posts']);
    expect(flat).toContainEqual({ method: 'where', args: ['title', 'Hi'] });
  });
});

describe('@adonis-agora/filter/testing — relation filtering end-to-end', () => {
  it('drives applyFilterFromRequest against the published mock, whitelisted relation → whereHas', () => {
    const spec = defineFilter({
      filterable: ['name'],
      relations: { posts: { filterable: ['title'] } },
    });
    const qb = makeMockQueryBuilder();

    applyFilterFromRequest(qb, spec, undefined, {
      input: { filters: [{ field: 'posts.title', operator: 'equals', value: 'Hi' }] },
    });

    expect(qb.find('whereHas')?.args).toEqual(['posts']);
    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['title', 'Hi'] });
  });

  it('rejects a relation column that is not whitelisted (no whereHas emitted)', () => {
    const spec = defineFilter({
      filterable: ['name'],
      relations: { posts: { filterable: ['title'] } },
    });
    const qb = makeMockQueryBuilder();

    expect(() =>
      applyFilterFromRequest(qb, spec, undefined, {
        input: { filters: [{ field: 'posts.secret', operator: 'equals', value: 'x' }] },
      }),
    ).toThrow(/relations\.posts\.filterable/);
    expect(qb.find('whereHas')).toBeUndefined();
  });
});
