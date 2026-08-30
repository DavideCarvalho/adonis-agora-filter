import { type FilterDecoratorRecord, legacyRecord, standardRecord } from './decorator_metadata.js';
import { isReservedKey } from './filter_class.js';
import { FilterDefinitionError } from './filter_spec.js';
import type { FilterFieldKind } from './types.js';

/**
 * A decorator that works under both flavours — the legacy `(prototype, key, descriptor)` form
 * AdonisJS compiles today (`experimentalDecorators`, which Lucid's `@column` requires) and the
 * TC39 standard `(value, context)` form TypeScript 5 emits when that flag is off. Which one runs
 * is decided at call time, from the shape of the second argument.
 */
export interface DualDecorator {
  (target: object, propertyKey: string | symbol, descriptor?: PropertyDescriptor): void;
  (value: unknown, context: StandardDecoratorContext): void;
}

/** The slice of a TC39 decorator context this library reads. */
export interface StandardDecoratorContext {
  kind: string;
  name: string | symbol;
  metadata?: object;
}

/** Standard decorators are handed a context object; legacy ones a property key. */
function isStandardContext(value: unknown): value is StandardDecoratorContext {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

/**
 * Resolve where a decorator should write, whichever flavour invoked it: the declared member's
 * name, and the record for the class that declared it.
 */
function target(
  what: string,
  expectedKinds: readonly string[],
  first: unknown,
  second: unknown,
): { name: string; record: FilterDecoratorRecord } {
  if (isStandardContext(second)) {
    if (!expectedKinds.includes(second.kind)) {
      throw new FilterDefinitionError(
        `${what} goes on ${expectedKinds.join(' or ')}, not on a ${second.kind}.`,
      );
    }
    if (!second.metadata) {
      throw new FilterDefinitionError(
        `${what} needs decorator metadata, which this runtime does not provide. Polyfill \`Symbol.metadata\` (\`Symbol.metadata ??= Symbol('Symbol.metadata')\`), or compile with \`experimentalDecorators\` as AdonisJS does.`,
      );
    }
    return { name: String(second.name), record: standardRecord(second.metadata) };
  }

  if (typeof first === 'function') {
    throw new FilterDefinitionError(`${what} goes on an instance member, not a static one.`);
  }
  if (typeof first !== 'object' || first === null) {
    throw new FilterDefinitionError(`${what} was applied to something that is not a class member.`);
  }
  return { name: String(second), record: legacyRecord(first) };
}

/**
 * Bind a filter method to the request key(s) it answers, instead of deriving the key from the
 * method's name.
 *
 * Worth reaching for exactly twice: when the key cannot be a method name (`team.name`), and when
 * one method should answer several keys. It also pins the public contract — with a binding, the
 * key survives renaming the method.
 *
 * ```ts
 * export default class UserFilter extends BaseModelFilter {
 *   @filterFor('team.name')
 *   byTeamName(value: string) {
 *     this.$query.whereHas('team', (team) => team.whereILike('name', `%${value}%`))
 *   }
 *
 *   @filterFor('q', 'query')
 *   freeText(value: string) { … }
 * }
 * ```
 *
 * A bound method answers **only** its declared keys: `?filter[byTeamName]=…` stops working, which
 * is the point — the method name becomes an implementation detail.
 */
export function filterFor(...keys: string[]): DualDecorator {
  if (keys.length === 0) {
    throw new FilterDefinitionError('@filterFor() needs at least one request key.');
  }
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new FilterDefinitionError('@filterFor() keys must be non-empty strings.');
    }
    if (isReservedKey(key)) {
      throw new FilterDefinitionError(
        `@filterFor('${key}') — '${key}' is a key the wire format itself owns (page, sort, search, …), so it never reaches a method. Bind another key.`,
      );
    }
  }

  return ((first: unknown, second: unknown): void => {
    const { name, record } = target('@filterFor()', ['method'], first, second);
    record.filterFor = { ...record.filterFor, [name]: [...keys] };
  }) as DualDecorator;
}

/** The member kinds a column decorator may sit on. */
const COLUMN_KINDS = ['field', 'accessor', 'getter', 'setter'] as const;

/**
 * Mark a model column as filterable — the allow-list, declared where the column is, stacked under
 * Lucid's own `@column()`.
 *
 * ```ts
 * export default class User extends compose(BaseModel, Filterable) {
 *   @column()
 *   @filterable()
 *   declare status: string
 *
 *   @column()
 *   @filterable('number')
 *   declare age: number
 *
 *   @column({ serializeAs: null })
 *   declare passwordHash: string   // undecorated — unreachable, as it should be
 * }
 * ```
 *
 * A filter class picks these up through its `static model`. Anything the filter declares itself
 * still wins outright, so a stricter filter over a shared model can narrow the surface:
 * `static filterable = ['status']` exposes that column and no other.
 *
 * The optional kind is the same one the colocated `filterable` map takes: it drives value
 * coercion and the generated client's types.
 */
export function filterable(kind?: FilterFieldKind): DualDecorator {
  return ((first: unknown, second: unknown): void => {
    const { name, record } = target('@filterable()', COLUMN_KINDS, first, second);
    record.filterable = { ...record.filterable, [name]: kind ?? null };
  }) as DualDecorator;
}

/** Mark a model column as sortable — `?sort=-createdAt` reaches it, nothing else does. */
export function sortable(): DualDecorator {
  return ((first: unknown, second: unknown): void => {
    const { name, record } = target('@sortable()', COLUMN_KINDS, first, second);
    record.sortable = [...(record.sortable ?? []), name];
  }) as DualDecorator;
}

/** Mark a model column as scanned by the free-text `?search=` term. */
export function searchable(): DualDecorator {
  return ((first: unknown, second: unknown): void => {
    const { name, record } = target('@searchable()', COLUMN_KINDS, first, second);
    record.searchable = [...(record.searchable ?? []), name];
  }) as DualDecorator;
}
