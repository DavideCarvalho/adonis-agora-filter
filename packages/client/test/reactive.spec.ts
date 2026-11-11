import { describe, expect, it, vi } from 'vitest';
import { filterQuery } from '../src/filter-query-builder.js';

describe('FilterQueryBuilder — reactivity', () => {
  describe('subscribe', () => {
    it('notifies on a mutation', () => {
      const q = filterQuery();
      const listener = vi.fn();
      q.subscribe(listener);

      q.where('name', 'foo');

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies once per primitive mutation, including via convenience methods', () => {
      const q = filterQuery();
      const listener = vi.fn();
      q.subscribe(listener);

      q.equals('status', 'active'); // delegates to where → 1
      q.sortDesc('createdAt'); // delegates to sort → 1
      q.addGte('age', 18); // delegates to add → 1
      q.page(1, 25); // primitive → 1

      expect(listener).toHaveBeenCalledTimes(4);
    });

    it('returns an unsubscribe function that stops notifications', () => {
      const q = filterQuery();
      const listener = vi.fn();
      const unsubscribe = q.subscribe(listener);

      q.where('name', 'foo');
      unsubscribe();
      q.where('name', 'bar');

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('supports multiple independent subscribers', () => {
      const q = filterQuery();
      const a = vi.fn();
      const b = vi.fn();
      q.subscribe(a);
      q.subscribe(b);

      q.search('term');

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('does not notify the parent when an or()/and() sub-builder mutates internally', () => {
      const q = filterQuery();
      const listener = vi.fn();
      q.subscribe(listener);

      q.or((b) => {
        b.where('name', 'iContains', 'a');
        b.where('email', 'iContains', 'a');
      });

      // The two sub-builder mutations are isolated; only the parent or() fires.
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSnapshot', () => {
    it('returns a stable reference until the next mutation', () => {
      const q = filterQuery().where('name', 'foo');

      const first = q.getSnapshot();
      const second = q.getSnapshot();
      expect(second).toBe(first); // same reference — required by useSyncExternalStore

      q.where('status', 'active');
      const third = q.getSnapshot();
      expect(third).not.toBe(first); // new reference after mutation
    });

    it('reflects the latest built result', () => {
      const q = filterQuery();
      expect(q.getSnapshot()).toEqual({ filter: { where: [] } });

      q.where('name', 'foo');
      expect(q.getSnapshot()).toEqual({
        filter: { where: [{ field: 'name', operator: 'equals', value: 'foo' }] },
      });
    });

    it('matches build() output', () => {
      const q = filterQuery().where('age', 'gte', 18).sort('name').page(1, 10);
      expect(q.getSnapshot()).toEqual(q.build());
    });
  });

  describe('getVersion', () => {
    it('starts at 0 and increments per mutation', () => {
      const q = filterQuery();
      expect(q.getVersion()).toBe(0);

      q.where('name', 'foo');
      expect(q.getVersion()).toBe(1);

      q.clear();
      expect(q.getVersion()).toBe(2);
    });
  });
});
