import { describe, expect, it } from 'vitest';
import { BaseFilter } from '../src/base_filter.js';
import { applyCustomFilter } from '../src/custom_filter.js';
import type { FilterInput } from '../src/types.js';
import { InvalidColumnFilterError } from '../src/validate-column-filter.js';

/** A ctx shaped like the slice the library reads off an HttpContext. */
function ctxWith(qs: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { request: { qs: () => qs }, ...extra };
}

/** The draft under construction — a predicate bag, standing in for a RunQuery. */
interface Bag {
  status?: string | undefined;
  statuses?: string[] | undefined;
  tags?: string[] | undefined;
  attrs: Array<{ key: string; op: string; value: unknown }>;
  log: string[];
}

class BagFilter extends BaseFilter<Bag> {
  declare $query: Bag;

  setup() {
    this.$query.log.push('setup');
  }

  status(value: unknown, operator: string) {
    this.$query.log.push(`status:${operator}`);
    const values = (Array.isArray(value) ? value : [value]).map(String);
    if (values.length === 1) this.$query.status = values[0];
    else this.$query.statuses = values;
  }

  tag(value: unknown, operator: string, field: string) {
    this.$query.log.push(`tag:${operator}:${field}`);
    this.$query.tags = (Array.isArray(value) ? value : [value]).map(String);
  }

  attr(value: unknown, operator: string, field: string) {
    this.$query.log.push(`attr:${operator}:${field}`);
    if (field === 'attr') {
      for (const entry of Array.isArray(value) ? value : [value]) {
        const [key, op, ...rest] = String(entry).split(':');
        if (key && op && rest.length > 0) {
          this.$query.attrs.push({ key, op, value: rest.join(':') });
        }
      }
      return;
    }
    this.$query.attrs.push({ key: field.slice('attr.'.length), op: operator, value });
  }
}

function bag(): Bag {
  return { attrs: [], log: [] };
}

describe('custom filters — one class style over any backend', () => {
  it('dispatches structured envelope filters to their methods with (value, operator, field)', async () => {
    const draft = bag();
    await applyCustomFilter(
      draft,
      BagFilter,
      ctxWith({ filter: { status: 'failed', tag: ['etl', 'nightly'] } }),
    );
    expect(draft.status).toBe('failed');
    expect(draft.tags).toEqual(['etl', 'nightly']);
    expect(draft.log).toEqual(['setup', 'status:equals', 'tag:in:tag']);
  });

  it('dispatches bare legacy keys to the same methods, once per method', async () => {
    const draft = bag();
    await applyCustomFilter(draft, BagFilter, ctxWith({ tag: 'etl' }));
    expect(draft.tags).toEqual(['etl']);
    expect(draft.log).toEqual(['setup', 'tag:equals:tag']);
  });

  it('ignores unknown and endpoint-mechanic bare keys instead of failing old callers', async () => {
    const draft = bag();
    await applyCustomFilter(
      draft,
      BagFilter,
      ctxWith({ tag: 'etl', limit: '50', offset: '0', whatever: 'x' }),
    );
    expect(draft.tags).toEqual(['etl']);
    expect(draft.log).toEqual(['setup', 'tag:equals:tag']);
  });

  it('routes a dotted field to its head-segment method with the full field', async () => {
    const draft = bag();
    await applyCustomFilter(
      draft,
      BagFilter,
      ctxWith({ filter: { where: [{ field: 'attr.tier', operator: 'equals', value: 'pro' }] } }),
    );
    expect(draft.attrs).toEqual([{ key: 'tier', op: 'equals', value: 'pro' }]);
    expect(draft.log).toEqual(['setup', 'attr:equals:attr.tier']);
  });

  it('parses legacy attr=key:op:value repeats through the same attr method', async () => {
    const draft = bag();
    await applyCustomFilter(draft, BagFilter, ctxWith({ attr: ['tier:eq:pro', 'amount:gte:200'] }));
    expect(draft.attrs).toEqual([
      { key: 'tier', op: 'eq', value: 'pro' },
      { key: 'amount', op: 'gte', value: '200' },
    ]);
  });

  it('flattens AND groups and rejects OR groups loudly', async () => {
    const draft = bag();
    await applyCustomFilter(
      draft,
      BagFilter,
      ctxWith({
        filter: {
          where: [
            {
              field: '',
              operator: 'equals',
              AND: [{ field: 'status', operator: 'equals', value: 'failed' }],
            },
          ],
        },
      }),
    );
    expect(draft.status).toBe('failed');

    await expect(
      applyCustomFilter(
        draft,
        BagFilter,
        ctxWith({ where: [{ field: '', operator: 'equals', OR: [] }] }),
      ),
    ).rejects.toThrow(InvalidColumnFilterError);
  });

  it('rejects an unknown structured field and an unknown operator', async () => {
    await expect(
      applyCustomFilter(bag(), BagFilter, ctxWith({ filter: { nope: 'x' } })),
    ).rejects.toThrow(InvalidColumnFilterError);
    // Operator validation happens before dispatch: methods only ever see real operators.
    await expect(
      applyCustomFilter(
        bag(),
        BagFilter,
        ctxWith({ filter: { where: [{ field: 'status', operator: 'frob', value: 'x' }] } }),
      ),
    ).rejects.toThrow(InvalidColumnFilterError);
  });

  it('runs setup before the methods and exposes input/parsed', async () => {
    let seenInput: unknown;
    let seenParsed: FilterInput | undefined;
    class SpyFilter extends BaseFilter<Bag> {
      declare $query: Bag;
      setup() {
        this.$query.log.push('setup');
      }
      tag(value: unknown) {
        seenInput = this.input('tag');
        seenParsed = this.$parsed;
        this.$query.tags = [String(value)];
      }
    }
    const draft = bag();
    await applyCustomFilter(draft, SpyFilter, ctxWith({ tag: 'etl' }));
    expect(draft.log[0]).toBe('setup');
    expect(seenInput).toBe('etl');
    // A bare legacy key rides method hoisting, not the parsed filter list — but the parsed input
    // is still bound for methods that need the whole request.
    expect(seenParsed).toBeDefined();
    expect(seenParsed?.filters ?? []).toHaveLength(0);
  });

  it('accepts a pre-parsed input instead of reading the query string', async () => {
    const draft = bag();
    await applyCustomFilter(draft, BagFilter, undefined, {
      input: { filters: [{ field: 'status', operator: 'equals', value: 'dead' }] },
    });
    expect(draft.status).toBe('dead');
  });

  it('never dispatches the base class members (input) as filter keys', async () => {
    const draft = bag();
    await applyCustomFilter(draft, BagFilter, ctxWith({ input: 'tag' }));
    expect(draft.tags).toBeUndefined();
    expect(draft.log).toEqual(['setup']);
  });
});
