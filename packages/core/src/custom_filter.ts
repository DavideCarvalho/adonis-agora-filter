import type { FilterRequestContext } from './apply_from_request.js';
import type { BaseFilter } from './base_filter.js';
import { type FilterClass, methodForKey } from './filter_class.js';
import { type ColumnFilter, FILTER_OPERATORS } from './operators.js';
import { parseFilterRequest } from './parse_request.js';
import type { FilterInput } from './types.js';
import {
  InvalidColumnFilterError,
  MAX_FILTER_DEPTH,
  normalizeOperator,
} from './validate-column-filter.js';

/**
 * A filter class over a custom backend, as the container hands it back: constructible, extending
 * {@link BaseFilter} — the model form's {@link FilterClass} for drafts.
 */
// biome-ignore lint/suspicious/noExplicitAny: constructor args are the class's own injected deps.
export type CustomFilterClass<D> = new (...args: any[]) => BaseFilter<D>;

/** Options for {@link applyCustomFilter}. */
export interface ApplyCustomFilterOptions {
  /**
   * Pre-parsed input to use instead of reading `ctx.request.qs()`. Useful for non-HTTP callers
   * and tests; when omitted the query string is parsed via {@link parseFilterRequest}.
   */
  input?: FilterInput;
}

/**
 * Resolve a custom filter class through the request's IoC container when there is one — the same
 * resolver a controller is constructed with, so `@inject()` on the filter behaves identically —
 * and fall back to plain construction outside an AdonisJS request (a test, a script).
 */
async function resolveCustomFilter<D>(
  cls: CustomFilterClass<D>,
  ctx: FilterRequestContext | undefined,
): Promise<BaseFilter<D>> {
  const resolver = ctx?.containerResolver as
    | { make?: (c: unknown) => Promise<unknown> }
    | undefined;
  if (resolver && typeof resolver.make === 'function') {
    return (await resolver.make(cls)) as BaseFilter<D>;
  }
  return new cls();
}

/**
 * The method owning `field`: an exact `@filterFor`/own-method match first, else the head segment
 * (`attr.tier` reaches `attr`) so one method can own a whole dynamic subtree. The full field still
 * rides along as the method's third argument, so the method always knows which key it was reached
 * through.
 *
 * The cast is sound: method dispatch only walks the prototype chain and reads static knobs, both
 * of which a custom filter class carries exactly like a model filter class (the walk simply ends
 * at `Object.prototype` instead of `BaseModelFilter.prototype`, with the same result — and at
 * `BaseFilter.prototype` for the shared members, which are never dispatchable).
 */
function resolveMethod(cls: CustomFilterClass<unknown>, field: string): string | undefined {
  const asModelFilter = cls as unknown as FilterClass;
  const exact = methodForKey(asModelFilter, field);
  if (exact !== undefined) return exact;
  const dot = field.indexOf('.');
  if (dot > 0) return methodForKey(asModelFilter, field.slice(0, dot));
  return undefined;
}

/** One dispatched call: the method, the value, the operator, and the full field it was reached by. */
interface OwnedCall {
  method: string;
  value: unknown;
  operator: string;
  field: string;
}

/**
 * Collect the calls a parsed input dispatches to: every structured filter to its owning method
 * (`AND` groups recurse; `OR` is rejected — a draft is an ANDed predicate bag and cannot express
 * cross-field OR), then every bare top-level key the wire format does not own (`?tag=etl`, the
 * legacy spelling) to its same-named method. Unknown BARE keys are ignored — they are how old
 * callers send pagination and other endpoint mechanics — while an unknown STRUCTURED field is
 * rejected outright: the new spelling fails loudly on typos instead of silently widening.
 */
function collectCalls(
  cls: CustomFilterClass<unknown>,
  raw: Record<string, unknown>,
  parsed: FilterInput,
): OwnedCall[] {
  const calls: OwnedCall[] = [];

  const visit = (filter: ColumnFilter, depth: number): void => {
    if (depth > MAX_FILTER_DEPTH) {
      throw new InvalidColumnFilterError(
        `Filter nesting exceeds maximum depth (${MAX_FILTER_DEPTH}).`,
      );
    }
    const isGroupNode =
      (filter.AND !== undefined || filter.OR !== undefined) &&
      (filter.field === undefined || filter.field === '');
    if (isGroupNode) {
      if (filter.OR !== undefined) {
        throw new InvalidColumnFilterError(
          'This filter does not support OR groups — a draft is an ANDed predicate bag.',
        );
      }
      for (const sub of filter.AND ?? []) visit(sub, depth + 1);
      return;
    }
    if (typeof filter.field !== 'string' || filter.field === '') {
      throw new InvalidColumnFilterError('Column filter needs a field.');
    }
    // SQL-symbol aliases (`=`, `!=`, …) normalize to canonical operators first, so methods only
    // ever see the canonical spelling — the same normalization the SQL path applies.
    const operator = normalizeOperator(String(filter.operator));
    if (!(FILTER_OPERATORS as readonly string[]).includes(operator)) {
      throw new InvalidColumnFilterError(`Unknown filter operator: "${String(filter.operator)}".`);
    }
    const method = resolveMethod(cls, filter.field);
    if (method === undefined) {
      throw new InvalidColumnFilterError(`Unknown filter field: "${filter.field}".`);
    }
    calls.push({ method, value: filter.value, operator, field: filter.field });
  };
  for (const filter of parsed.filters ?? []) visit(filter, 0);

  // A bare top-level key (`?tag=etl`) reaches a method of the same name too — the legacy spelling
  // — as long as the wire format does not own the key and no structured filter already claimed it.
  // The reserved gate inside `methodForKey` is what keeps endpoint mechanics (`limit`, `sort`, …)
  // from ever reaching a method here.
  for (const [key, value] of Object.entries(raw)) {
    const method = resolveMethod(cls, key);
    if (method !== undefined && !calls.some((call) => call.method === method)) {
      calls.push({ method, value, operator: 'equals', field: key });
    }
  }
  return calls;
}

/**
 * Run a custom filter class against a caller-created draft from a request context: bind the
 * per-request state onto the instance, run `setup()`, then hand each filter to its owning method
 * as `(value, operator, field)`.
 *
 * The custom-backend counterpart of
 * {@link import('./apply_from_request.js').applyFilterFromRequest}: that helper ends in SQL (a
 * `QueryBuilderLike`), this one ends in whatever the draft accumulates — a `RunQuery`, an engine
 * client query, an in-memory predicate. The wire format, the parsing, the method dispatch and the
 * error shapes are shared, so a console can move between a Lucid listing and a custom-backend one
 * without relearning the spelling.
 *
 * ```ts
 * const draft = new RunQueryDraft();
 * await applyCustomFilter(draft, RunFilter, ctx);
 * const runs = await engine.listRuns(draft.query);
 * ```
 */
export async function applyCustomFilter<D>(
  draft: D,
  cls: CustomFilterClass<D>,
  ctx: FilterRequestContext | undefined,
  options: ApplyCustomFilterOptions = {},
): Promise<void> {
  const raw: Record<string, unknown> = ctx?.request?.qs?.() ?? {};
  const parsed = options.input ?? parseFilterRequest(raw);
  const instance = await resolveCustomFilter(cls, ctx);

  Object.assign(instance, {
    $query: draft,
    $input: raw,
    $parsed: parsed,
    $ctx: ctx,
  });

  await instance.setup?.();

  for (const { method, value, operator, field } of collectCalls(cls, raw, parsed)) {
    const fn = (instance as unknown as Record<string, unknown>)[method];
    if (typeof fn === 'function') {
      await (fn as (v: unknown, op: string, f: string) => unknown).call(
        instance,
        value,
        operator,
        field,
      );
    }
  }
}
