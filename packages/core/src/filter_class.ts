import { BaseModelFilter } from './base_model_filter.js';
import { type FilterSpec, defineFilter } from './filter_spec.js';

/** A filter class as the container hands it back: constructible, extending {@link BaseModelFilter}. */
// biome-ignore lint/suspicious/noExplicitAny: constructor args are the class's own injected deps.
export type FilterClass = (new (...args: any[]) => BaseModelFilter) & Record<string, unknown>;

/** Request keys the wire format owns — never dispatched to a method of the same name. */
const RESERVED_KEYS = new Set([
  'filter',
  'filters',
  'sort',
  'search',
  'page',
  'size',
  'distinct',
  'include',
  'select',
  'after',
  'before',
  'first',
  'last',
  'limit',
  'offset',
]);

/** Names on the class that are machinery, not request keys. */
const RESERVED_METHODS = new Set(['constructor', 'setup', 'input']);

/**
 * Is this a filter class (as opposed to a `defineFilter` spec)? Checked structurally — a class
 * that extends {@link BaseModelFilter} — so the two forms can share one entry point.
 */
export function isFilterClass(value: unknown): value is FilterClass {
  if (typeof value !== 'function') return false;
  let proto = Object.getPrototypeOf(value) as unknown;
  while (proto !== null && proto !== Function.prototype) {
    if (proto === BaseModelFilter) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * The request keys a class owns with a method of its own, walking the prototype chain up to (but
 * not including) {@link BaseModelFilter} — so a shared abstract filter's methods are inherited
 * like any other. `setup`, the constructor, `$`-prefixed members and anything on the class's
 * `blacklist` are excluded.
 *
 * Memoized per class: the shape of a class does not change between requests.
 */
export function dispatchKeys(cls: FilterClass): ReadonlySet<string> {
  const cached = KEY_CACHE.get(cls);
  if (cached) return cached;

  const blacklist = new Set((cls.blacklist as string[] | undefined) ?? []);
  const keys = new Set<string>();
  let proto = cls.prototype as object | null;
  while (proto !== null && proto !== BaseModelFilter.prototype && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (RESERVED_METHODS.has(name) || blacklist.has(name)) continue;
      if (name.startsWith('$') || name.startsWith('_')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (typeof descriptor?.value === 'function') keys.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  KEY_CACHE.set(cls, keys);
  return keys;
}

const KEY_CACHE = new WeakMap<FilterClass, Set<string>>();
const SPEC_CACHE = new WeakMap<FilterClass, FilterSpec>();

/**
 * Compile a filter class's static declarations into the {@link FilterSpec} the runner consumes —
 * the same object `defineFilter` produces, so a class and a spec take the identical code path
 * through allow-listing, search, sort and pagination.
 *
 * A class that declares no `filterable` is method-only: nothing reaches SQL except through the
 * methods it wrote, which is the tightest allow-list there is.
 *
 * Memoized per class — the declaration is static, so it is compiled once per process.
 */
export function specFromFilterClass(cls: FilterClass): FilterSpec {
  const cached = SPEC_CACHE.get(cls);
  if (cached) return cached;

  const spec = defineFilter({
    filterable: (cls.filterable as never) ?? [],
    ...pick(cls, [
      'model',
      'sortable',
      'searchable',
      'relations',
      'aliases',
      'computed',
      'fieldTypes',
      'fullText',
      'vectorSimilarity',
      'tenant',
      'defaultFilters',
      'defaultSort',
      'defaultSize',
      'maxSize',
      'maxDepth',
      'table',
      'throwOnInvalid',
    ]),
  });
  SPEC_CACHE.set(cls, spec);
  return spec;
}

function pick(cls: FilterClass, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const value = cls[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Find the method a request key maps to, honouring the class's `camelCase` (a `snake_case` key
 * matches a camelCase method — on by default) and `dropId` (`companyId` matches `company`) knobs.
 * Returns the method name, or `undefined` when the class does not own the key.
 */
export function methodForKey(cls: FilterClass, key: string): string | undefined {
  if (typeof key !== 'string' || key.length === 0 || RESERVED_KEYS.has(key)) return undefined;
  const keys = dispatchKeys(cls);
  if (keys.has(key)) return key;

  if (cls.camelCase !== false) {
    const camel = toCamelCase(key);
    if (keys.has(camel)) return camel;
    if (cls.dropId === true) {
      const dropped = stripId(camel);
      if (dropped.length > 0 && keys.has(dropped)) return dropped;
    }
  }
  if (cls.dropId === true) {
    const dropped = stripId(key);
    if (dropped.length > 0 && keys.has(dropped)) return dropped;
  }
  return undefined;
}

function toCamelCase(key: string): string {
  const result = key.replace(/[_-](\w)/g, (_, char) => (char as string).toUpperCase());
  return result.charAt(0).toLowerCase() + result.slice(1);
}

function stripId(key: string): string {
  if (key === 'id') return '';
  if (key.endsWith('Id')) return key.slice(0, -2);
  if (key.endsWith('_id')) return key.slice(0, -3);
  return key;
}

/** Is this key one the wire format owns (so it is never dispatched to a method)? */
export function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key);
}
