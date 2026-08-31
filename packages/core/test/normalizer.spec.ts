import { describe, expect, it } from 'vitest';
import { normalizeInput } from '../src/normalizer.js';

describe('normalizeInput', () => {
  it('converts snake_case to camelCase', () => {
    const out = normalizeInput({ company_id: 5, first_name: 'a' }, { normalizer: 'camelCase' });
    expect(out).toEqual({ companyId: 5, firstName: 'a' });
  });

  it('snakeCase normalizer converts camelCase to snake_case', () => {
    const out = normalizeInput({ companyId: 5 }, { normalizer: 'snakeCase' });
    expect(out).toEqual({ company_id: 5 });
  });

  it('custom normalizer function receives keys', () => {
    const out = normalizeInput({ foo: 1, bar: 2 }, { normalizer: (k) => k.toUpperCase() });
    expect(out).toEqual({ FOO: 1, BAR: 2 });
  });

  it('dropId strips trailing Id (camelCase) or _id (snake)', () => {
    const camel = normalizeInput({ companyId: 5 }, { normalizer: 'camelCase', dropId: true });
    expect(camel).toEqual({ company: 5 });
    const snake = normalizeInput({ company_id: 5 }, { normalizer: 'snakeCase', dropId: true });
    expect(snake).toEqual({ company: 5 });
  });

  it('dropId on a bare "id" key drops it (empty string is filtered)', () => {
    const out = normalizeInput({ id: 5, name: 'x' }, { normalizer: 'camelCase', dropId: true });
    expect(out).toEqual({ name: 'x' });
  });

  it('handles null/undefined input as empty object', () => {
    expect(normalizeInput(null, { normalizer: 'camelCase' })).toEqual({});
    expect(normalizeInput(undefined, { normalizer: 'camelCase' })).toEqual({});
  });

  it('preserves nested values unchanged (only top-level keys normalized)', () => {
    const out = normalizeInput({ nested_obj: { inner_key: 1 } }, { normalizer: 'camelCase' });
    expect(out).toEqual({ nestedObj: { inner_key: 1 } });
  });

  it('drops __proto__ key to prevent prototype pollution', () => {
    const input = JSON.parse('{"__proto__": {"malicious": true}, "name": "safe"}');
    const out = normalizeInput(input, { normalizer: 'camelCase' });
    expect(out).toEqual({ name: 'safe' });
    expect(Object.hasOwn(out, '__proto__')).toBe(false);
  });

  it('drops constructor/prototype/toString/valueOf keys', () => {
    for (const key of ['constructor', 'prototype', 'toString', 'valueOf']) {
      const out = normalizeInput({ [key]: 'evil', name: 'safe' }, { normalizer: 'camelCase' });
      expect(out).toEqual({ name: 'safe' });
    }
  });

  it('strips null/undefined/empty-string values by default', () => {
    const out = normalizeInput(
      { name: '', age: null, missing: undefined, role: 'admin' },
      { normalizer: 'camelCase' },
    );
    expect(out).toEqual({ role: 'admin' });
  });

  it('does not strip when stripEmpty is false', () => {
    const out = normalizeInput(
      { name: '', age: null, role: 'admin' },
      { normalizer: 'camelCase', stripEmpty: false },
    );
    expect(out).toEqual({ name: '', age: null, role: 'admin' });
  });

  it('preserves zero and false values when stripping', () => {
    const out = normalizeInput({ count: 0, active: false, name: '' }, { normalizer: 'camelCase' });
    expect(out).toEqual({ count: 0, active: false });
  });

  it('snakeCase handles consecutive uppercase (acronyms)', () => {
    const out = normalizeInput({ myURLField: 1 }, { normalizer: 'snakeCase' });
    expect(out).toEqual({ my_url_field: 1 });
  });

  it('output uses a null-prototype object', () => {
    const out = normalizeInput({ name: 'safe' }, { normalizer: 'camelCase' });
    expect(Object.getPrototypeOf(out)).toBeNull();
  });
});
