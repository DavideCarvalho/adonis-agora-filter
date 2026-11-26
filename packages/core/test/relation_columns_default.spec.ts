import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyFilterFromRequest } from '../src/apply_from_request.js';
import { defineFilter } from '../src/filter_spec.js';
import { makeMockQueryBuilder } from '../src/testing.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
}

describe('relation columns are deny-by-default (security)', () => {
  it('a relation declared without `filterable` exposes none of its columns', () => {
    quiet();
    const spec = defineFilter({ filterable: ['title'], relations: { author: {} } });
    expect(spec.isFilterable('author.password')).toBe(false);
    expect(spec.isFilterable('author.email')).toBe(false);
    expect(spec.isSortable('author.password')).toBe(false);
  });

  it('drops a filter on an unlisted relation column (no whereHas emitted)', () => {
    quiet();
    const spec = defineFilter({ filterable: ['title'], relations: { author: {} } });
    const qb = makeMockQueryBuilder();
    applyFilterFromRequest(qb, spec, undefined, {
      input: {
        filters: [{ field: 'author.password', operator: 'startsWith', value: '$2a$' }],
      },
    });
    expect(qb.find('whereHas')).toBeUndefined();
  });

  it('refuses it under throwOnInvalid', () => {
    quiet();
    const spec = defineFilter({
      filterable: ['title'],
      relations: { author: {} },
      throwOnInvalid: true,
    });
    expect(() =>
      applyFilterFromRequest(makeMockQueryBuilder(), spec, undefined, {
        input: { filters: [{ field: 'author.password', operator: 'equals', value: 'x' }] },
      }),
    ).toThrow();
  });

  it('nested relations without `filterable` are closed too', () => {
    quiet();
    const spec = defineFilter({
      filterable: ['name'],
      relations: { posts: { filterable: ['title'], relations: { author: {} } } },
    });
    expect(spec.isFilterable('posts.title')).toBe(true);
    expect(spec.isFilterable('posts.author.password')).toBe(false);
  });

  it("an explicit list still works, and `'*'` opts every column back in", () => {
    const spec = defineFilter({
      filterable: ['name'],
      relations: { author: { filterable: ['name'] }, category: { filterable: '*' } },
    });
    expect(spec.isFilterable('author.name')).toBe(true);
    expect(spec.isFilterable('author.password')).toBe(false);
    expect(spec.isFilterable('category.anything')).toBe(true);
  });

  it('`sortable` still defaults to the relation `filterable`', () => {
    const spec = defineFilter({
      filterable: ['name'],
      relations: { author: { filterable: ['name'] } },
    });
    expect(spec.isSortable('author.name')).toBe(true);
    expect(spec.isSortable('author.password')).toBe(false);
  });

  it('warns outside production about a relation with no allow-list', () => {
    const warn = quiet();
    defineFilter({ filterable: ['name'], relations: { posts: { relations: { author: {} } } } });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('"posts"'))).toBe(true);
    expect(messages.some((m) => m.includes('"posts.author"'))).toBe(true);
  });

  it('does not warn when the relation has an explicit list (even empty) or in production', () => {
    const warn = quiet();
    defineFilter({ filterable: ['name'], relations: { author: { filterable: [] } } });
    expect(warn).not.toHaveBeenCalled();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      defineFilter({ filterable: ['name'], relations: { author: {} } });
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
