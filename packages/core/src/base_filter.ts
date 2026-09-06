import type { FilterInput } from './types.js';

/**
 * The class-authoring form of a filter over ANY backend — the generic base behind
 * {@link import('./base_model_filter.js').BaseModelFilter} (Lucid) and custom backends
 * (in-memory stores, engine clients, predicate bags) alike: **one style that does everything**.
 *
 * A method's name IS the key it owns, `setup()` runs on every call before anything the request
 * asked for, and the class is resolved through the IoC container so an `@inject()`ed constructor
 * works — exactly the shape AdonisJS developers know from `adonis-lucid-filter`. What differs per
 * backend is only what `$query` IS: a Lucid builder for models, a draft the methods narrow for
 * anything else.
 *
 * ```ts
 * export class RunFilter extends BaseFilter<RunQueryDraft> {
 *   declare $query: RunQueryDraft;
 *
 *   status(value: unknown, operator: string) {
 *     const values = (Array.isArray(value) ? value : [value]).map(String);
 *     this.$query.narrow(values.length === 1 ? { status: values[0] } : { statuses: values });
 *   }
 * }
 *
 * const draft = new RunQueryDraft();
 * await applyCustomFilter(draft, RunFilter, ctx);
 * ```
 */
export abstract class BaseFilter<TQuery> {
  /**
   * The query being filtered — the one the caller created. Methods mutate it directly; nothing
   * here constructs or executes a query.
   */
  declare $query: TQuery;

  /** The raw decoded request input the dispatch reads (query string, or the body on a POST). */
  declare $input: Readonly<Record<string, unknown>>;

  /** The parsed input — filters, sort, search, pagination — after the wire format is read. */
  declare $parsed: FilterInput;

  /** The request context handed to the call (a real `HttpContext` in an AdonisJS app). */
  declare $ctx: unknown;

  /**
   * Runs on every filter call, before anything the request asked for — the place for defaults
   * and for constraints the client must not be able to relax.
   */
  setup?(): void | Promise<void>;

  /** The whole raw input, one key of it, or a fallback when the key is absent. */
  input(): Readonly<Record<string, unknown>>;
  input(key: string): unknown;
  input(key: string, fallback: unknown): unknown;
  input(key?: string, fallback?: unknown): unknown {
    if (key === undefined) return this.$input;
    return Object.hasOwn(this.$input, key) ? this.$input[key] : fallback;
  }
}
