import { describe, expect, it } from 'vitest';
import {
  buildCursorPage,
  buildKeyset,
  decodeCursor,
  encodeCursor,
  extractCursorValues,
  type ResolvedCursor,
  reverseKeyset,
} from '../src/cursor.js';

describe('cursor codec', () => {
  it('round-trips scalar values', () => {
    const values = [42, 'Alice', true];
    const encoded = encodeCursor(values);
    expect(typeof encoded).toBe('string');
    expect(decodeCursor(encoded)).toEqual(values);
  });

  it('round-trips Date values to Date instances', () => {
    const d = new Date('2024-01-02T03:04:05.000Z');
    const decoded = decodeCursor(encodeCursor([d, 7]))!;
    expect(decoded[0]).toBeInstanceOf(Date);
    expect((decoded[0] as Date).toISOString()).toBe(d.toISOString());
    expect(decoded[1]).toBe(7);
  });

  it('produces a URL-safe string (base64url, no + / =)', () => {
    const encoded = encodeCursor([{ a: 1 }, 'x'.repeat(50)]);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('returns null for malformed cursors', () => {
    expect(decodeCursor('!!!not-base64!!!@@@')).toBeNull();
    expect(decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toBeNull();
  });
});

describe('buildKeyset', () => {
  it('appends the primary key as a tiebreaker when absent', () => {
    expect(buildKeyset([{ field: 'name', direction: 'asc' }], 'id')).toEqual([
      { field: 'name', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ]);
  });

  it('inherits the last column direction for the tiebreaker', () => {
    expect(buildKeyset([{ field: 'name', direction: 'desc' }], 'id')).toEqual([
      { field: 'name', direction: 'desc' },
      { field: 'id', direction: 'desc' },
    ]);
  });

  it('does not duplicate the pk if already in the sort', () => {
    const sorts = [
      { field: 'name', direction: 'asc' as const },
      { field: 'id', direction: 'desc' as const },
    ];
    expect(buildKeyset(sorts, 'id')).toEqual(sorts);
  });

  it('defaults to an asc pk tiebreaker for an empty sort', () => {
    expect(buildKeyset([], 'id')).toEqual([{ field: 'id', direction: 'asc' }]);
  });
});

describe('reverseKeyset', () => {
  it('flips every column direction', () => {
    expect(
      reverseKeyset([
        { field: 'name', direction: 'asc' },
        { field: 'id', direction: 'desc' },
      ]),
    ).toEqual([
      { field: 'name', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ]);
  });
});

describe('extractCursorValues', () => {
  it('reads values in keyset order', () => {
    const row = { id: 5, name: 'Bob', age: 30 };
    expect(
      extractCursorValues(row, [
        { field: 'name', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ]),
    ).toEqual(['Bob', 5]);
  });

  it('walks dotted relation paths', () => {
    const row = { id: 1, author: { name: 'Z' } };
    expect(
      extractCursorValues(row, [
        { field: 'author.name', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ]),
    ).toEqual(['Z', 1]);
  });
});

describe('buildCursorPage', () => {
  const keyset = [
    { field: 'name', direction: 'asc' as const },
    { field: 'id', direction: 'asc' as const },
  ];
  const rows = [
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
    { id: 3, name: 'C' },
  ];

  it('forward first page: trims the extra row and reports hasNext, no prev', () => {
    const resolved: ResolvedCursor = { keyset, size: 2, backward: false, hasCursor: false };
    const page = buildCursorPage(rows, resolved);
    expect(page.items).toEqual([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ]);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrev).toBe(false);
    expect(page.nextCursor).toBe(encodeCursor(['B', 2]));
    expect(page.prevCursor).toBeNull();
  });

  it('forward last page (no extra row): hasNext false, prev known from cursor', () => {
    const resolved: ResolvedCursor = { keyset, size: 5, backward: false, hasCursor: true };
    const page = buildCursorPage(rows, resolved);
    expect(page.items).toEqual(rows);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrev).toBe(true);
    expect(page.prevCursor).toBe(encodeCursor(['A', 1]));
  });

  it('backward page: re-reverses rows and maps hasExtra to hasPrev', () => {
    // Backward query returns rows in reversed (desc) order; page restores asc.
    const backwardRows = [
      { id: 3, name: 'C' },
      { id: 2, name: 'B' },
      { id: 1, name: 'A' },
    ];
    const resolved: ResolvedCursor = { keyset, size: 2, backward: true, hasCursor: true };
    const page = buildCursorPage(backwardRows, resolved);
    // slice(0, size) then reverse → [B, C]
    expect(page.items).toEqual([
      { id: 2, name: 'B' },
      { id: 3, name: 'C' },
    ]);
    expect(page.hasNext).toBe(true); // backward always came from a cursor
    expect(page.hasPrev).toBe(true); // extra row seen
  });
});
