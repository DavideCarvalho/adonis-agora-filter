import { BaseModelFilter } from './base_model_filter.js';
import { readDecorators } from './decorator_metadata.js';
import { type FilterSpec, defineFilter } from './filter_spec.js';
import type { FilterFieldTypeInfo } from './generate_client.js';

/**
 * A filter class as the container hands it back: constructible, extending {@link BaseModelFilter}
 * — and carrying that base's static declarations (`filterable`, `sortable`, `blacklist`, …).
 *
 * Spelled as an intersection with `typeof BaseModelFilter` rather than an index signature: a
 * concrete `class UserFilter extends BaseModelFilter` has no index signature, so
 * `Record<string, unknown>` here would make every real filter class *unassignable* to this type —
 * `static $filter = () => UserFilter` on a model would not compile.
 */
// biome-ignore lint/suspicious/noExplicitAny: constructor args are the class's own injected deps.
export type FilterClass = new (...args: any[]) => BaseModelFilter;

/** The static declarations a filter class may carry, as the internals read them. */
type FilterStatics = Partial<
  Pick<
    typeof BaseModelFilter,
    | 'model'
    | 'filterable'
    | 'sortable'
    | 'searchable'
    | 'fieldTypes'
    | 'blacklist'
    | 'dropId'
    | 'camelCase'
  >
> &
  Record<string, unknown>;

/**
 * A filter class's static side. Read through a cast rather than declared on {@link FilterClass}
 * itself: an index signature there would make every concrete `class UserFilter extends
 * BaseModelFilter` *unassignable* to the type — `static $filter = () => UserFilter` on a model
 * would stop compiling.
 */
function statics(cls: FilterClass): FilterStatics {
  return cls as unknown as FilterStatics;
}

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

  const blacklist = new Set(statics(cls).blacklist ?? []);
  const bound = explicitBindings(cls).methods;
  const keys = new Set<string>();
  let proto = cls.prototype as object | null;
  while (proto !== null && proto !== BaseModelFilter.prototype && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (RESERVED_METHODS.has(name) || blacklist.has(name) || bound.has(name)) continue;
      if (name.startsWith('$') || name.startsWith('_')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (typeof descriptor?.value === 'function') keys.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  KEY_CACHE.set(cls, keys);
  return keys;
}

/**
 * The `@filterFor` bindings a class declares: request key → method, and the set of methods that
 * are bound (and so no longer answer to their own name).
 *
 * Memoized per class alongside the dispatch keys — decorators run at class-definition time, long
 * before the first request reaches the class.
 */
function explicitBindings(cls: FilterClass): { keys: Map<string, string>; methods: Set<string> } {
  const cached = BINDING_CACHE.get(cls);
  if (cached) return cached;

  const keys = new Map<string, string>();
  const methods = new Set<string>();
  const blacklist = new Set(statics(cls).blacklist ?? []);
  for (const [method, bound] of Object.entries(readDecorators(cls).filterFor ?? {})) {
    if (blacklist.has(method)) continue;
    methods.add(method);
    for (const key of bound) keys.set(key, method);
  }

  const bindings = { keys, methods };
  BINDING_CACHE.set(cls, bindings);
  return bindings;
}

const BINDING_CACHE = new WeakMap<
  FilterClass,
  { keys: Map<string, string>; methods: Set<string> }
>();
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

  const declared = declaredByModel(cls);
  const spec = defineFilter({
    ...declared,
    filterable: (statics(cls).filterable as never) ?? declared.filterable ?? [],
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

/**
 * What the model itself declares through `@filterable` / `@sortable` / `@searchable` on its
 * columns, read off the filter's `static model`.
 *
 * These are **fallbacks**: a static on the filter class replaces the corresponding list outright,
 * so a stricter filter over a shared model can narrow what the model opens up. Only `fieldTypes`
 * merges per field — it is metadata about a column, not a decision about who may reach it.
 */
function declaredByModel(cls: FilterClass): {
  filterable?: string[];
  sortable?: string[];
  searchable?: string[];
  fieldTypes?: Record<string, FilterFieldTypeInfo>;
} {
  const model = statics(cls).model as object | undefined;
  if (!model) return {};

  const declared = readDecorators(model);
  const out: {
    filterable?: string[];
    sortable?: string[];
    searchable?: string[];
    fieldTypes?: Record<string, FilterFieldTypeInfo>;
  } = {};

  if (declared.filterable) {
    out.filterable = Object.keys(declared.filterable);
    const fieldTypes: Record<string, FilterFieldTypeInfo> = {};
    for (const [column, kind] of Object.entries(declared.filterable)) {
      if (kind !== null) fieldTypes[column] = { kind };
    }
    const merged = { ...fieldTypes, ...statics(cls).fieldTypes };
    if (Object.keys(merged).length > 0) out.fieldTypes = merged;
  }
  if (declared.sortable) out.sortable = [...new Set(declared.sortable)];
  if (declared.searchable) out.searchable = [...new Set(declared.searchable)];

  return out;
}

function pick(cls: FilterClass, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const statics = cls as unknown as Record<string, unknown>;
  for (const name of names) {
    const value = statics[name];
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

  const bound = explicitBindings(cls).keys.get(key);
  if (bound !== undefined) return bound;

  const keys = dispatchKeys(cls);
  if (keys.has(key)) return key;

  const knobs = statics(cls);
  if (knobs.camelCase !== false) {
    const camel = toCamelCase(key);
    if (keys.has(camel)) return camel;
    if (knobs.dropId === true) {
      const dropped = stripId(camel);
      if (dropped.length > 0 && keys.has(dropped)) return dropped;
    }
  }
  if (knobs.dropId === true) {
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
