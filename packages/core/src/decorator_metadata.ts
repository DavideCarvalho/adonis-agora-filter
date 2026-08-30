import type { FilterFieldKind } from './types.js';

/**
 * What the decorators record about a class, per declaration site.
 *
 * Two storage channels back this, because two decorator flavours exist in the wild:
 *
 * - **legacy** (`experimentalDecorators`, what AdonisJS uses today — Lucid's `@column` requires
 *   it) hands the decorator the *prototype*, so the record is kept in a `WeakMap` keyed by it;
 * - **standard** (TC39 stage 3, TypeScript 5's default when the flag is off) hands the decorator
 *   a context object carrying a per-class `metadata` bag, so the record is kept in there.
 *
 * Both are read back the same way, so a class works under either flavour — and inheritance falls
 * out of the walk: prototype chain for the first, the metadata object's own prototype chain
 * (which the standard emit links to the base class's) for the second.
 */
export interface FilterDecoratorRecord {
  /** Method name → the request keys `@filterFor` bound it to. */
  filterFor?: Record<string, string[]>;
  /** Column name → the kind `@filterable` declared, or `null` when it declared none. */
  filterable?: Record<string, FilterFieldKind | null>;
  /** Columns marked `@sortable`. */
  sortable?: string[];
  /** Columns marked `@searchable`. */
  searchable?: string[];
}

/** The key the record is filed under inside a standard decorator's metadata bag. */
const NAMESPACE = '@adonis-agora/filter';

/** Legacy channel: prototype (or model prototype) → record. */
const LEGACY = new WeakMap<object, FilterDecoratorRecord>();

/**
 * The symbols a standard decorator's metadata bag may be stamped on: the real `Symbol.metadata`
 * when the runtime (or a polyfill) has it, and the registered fallback TypeScript's emit uses
 * otherwise. Resolved on every read rather than captured once, so a polyfill installed after this
 * module loads is still seen.
 */
function metadataSymbols(): symbol[] {
  const native = (Symbol as unknown as { metadata?: symbol }).metadata;
  const fallback = Symbol.for('Symbol.metadata');
  return native && native !== fallback ? [native, fallback] : [fallback];
}

/** The record a legacy decorator writes into, created on first use. */
export function legacyRecord(prototype: object): FilterDecoratorRecord {
  const existing = LEGACY.get(prototype);
  if (existing) return existing;
  const record: FilterDecoratorRecord = {};
  LEGACY.set(prototype, record);
  return record;
}

/**
 * The record a standard decorator writes into. The bag a subclass receives *inherits* from its
 * base's, so the record is defined as an **own** property — writing through the inherited one
 * would leak a subclass's bindings back onto the parent.
 */
export function standardRecord(metadata: object): FilterDecoratorRecord {
  if (!Object.hasOwn(metadata, NAMESPACE)) {
    Object.defineProperty(metadata, NAMESPACE, {
      value: {} satisfies FilterDecoratorRecord,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return (metadata as Record<string, FilterDecoratorRecord>)[NAMESPACE] as FilterDecoratorRecord;
}

/** Every record that applies to a class, base first — so a subclass's declaration wins. */
function recordsFor(cls: object): FilterDecoratorRecord[] {
  const found: FilterDecoratorRecord[] = [];

  const prototype = (cls as { prototype?: object }).prototype;
  let proto: object | null = prototype ?? null;
  while (proto !== null && proto !== Object.prototype) {
    const record = LEGACY.get(proto);
    if (record) found.push(record);
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  for (const symbol of metadataSymbols()) {
    let bag = (cls as Record<symbol, object | undefined>)[symbol] ?? null;
    while (bag !== null) {
      if (Object.hasOwn(bag, NAMESPACE)) {
        found.push(
          (bag as Record<string, FilterDecoratorRecord>)[NAMESPACE] as FilterDecoratorRecord,
        );
      }
      bag = Object.getPrototypeOf(bag) as object | null;
    }
  }

  return found.reverse();
}

/**
 * The merged declaration for a class — its own decorators layered over everything it inherits.
 *
 * Not memoized: decorators run at class-definition time, but a model's columns and a filter's
 * methods are read once per compiled spec, which is itself cached by the caller.
 */
export function readDecorators(cls: object): FilterDecoratorRecord {
  const merged: FilterDecoratorRecord = {};
  for (const record of recordsFor(cls)) {
    if (record.filterFor) merged.filterFor = { ...merged.filterFor, ...record.filterFor };
    if (record.filterable) merged.filterable = { ...merged.filterable, ...record.filterable };
    if (record.sortable) merged.sortable = [...(merged.sortable ?? []), ...record.sortable];
    if (record.searchable) merged.searchable = [...(merged.searchable ?? []), ...record.searchable];
  }
  return merged;
}
