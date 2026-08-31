import type { BaseModelFilter } from './base_model_filter.js';
import type { CursorParams, ResolvedCursor } from './cursor.js';
import {
  type FilterClass,
  isFilterClass,
  methodForKey,
  specFromFilterClass,
} from './filter_class.js';
import { type FilterSpec, specToFilterConfig } from './filter_spec.js';
import { applyColumnFilters, type QueryBuilderLike } from './lucid_adapter.js';
import type { ColumnFilter } from './operators.js';
import { parseFilterRequest } from './parse_request.js';
import { applyCursor, applyFilter, type CursorConfig, type ResolvedPagination } from './runner.js';
import type { FilterInput } from './types.js';

/**
 * The structural slice of an AdonisJS `HttpContext` these helpers read. Only
 * `request.qs()` (the decoded query string) is used to source the raw input;
 * the whole ctx is also handed to a spec's tenant resolver. Declared
 * structurally so the package never hard-imports `@adonisjs/core` — a real
 * `HttpContext` satisfies it, and tests can pass a plain object.
 */
export interface FilterRequestContext {
  request?: { qs?: () => Record<string, unknown> };
  // biome-ignore lint/suspicious/noExplicitAny: ctx is opaque to us beyond request.qs; the tenant resolver reads the rest.
  [key: string]: any;
}

/** Options shared by the request-driven helpers. */
export interface ApplyFromRequestOptions {
  /**
   * Pre-parsed input to use instead of reading `ctx.request.qs()`. Useful for
   * non-HTTP callers and tests; when omitted the query string is parsed via
   * {@link parseFilterRequest}.
   */
  input?: FilterInput;
  /**
   * Query embedding for pgvector embedding-similarity ranking (distinct from the
   * text `search`). The idiomatic path: the controller computes it from an
   * embedding service and passes it here (rather than shipping a large float
   * array through the query string). Ignored unless the spec declares a
   * `vectorSimilarity` column; merged over any `input.vectorSimilarity`.
   */
  vectorSimilarity?: readonly number[];
}

/** Options for {@link applyCursorFromRequest}. */
export interface ApplyCursorFromRequestOptions extends ApplyFromRequestOptions {
  /** Primary-key column appended to the keyset as a stable tiebreaker. Default `'id'`. */
  primaryKey?: string;
}

/** Read the decoded query string off the ctx (empty object when absent). */
function rawQs(ctx: FilterRequestContext | undefined): Record<string, unknown> {
  const qs = ctx?.request?.qs;
  if (typeof qs === 'function') return qs.call(ctx?.request) ?? {};
  return {};
}

/**
 * Apply the server-side, non-client-tamperable scope to the query BEFORE the
 * allow-listed request filters: the tenant constraint (when the spec declares
 * one and a tenant id resolves from ctx) and any `defaultFilters`. These bypass
 * the allow-list on purpose — they are trusted server policy, mirroring how the
 * NestJS runner applied `@TenantScoped` via the adapter's auto-field path.
 */
function applyServerScope(
  query: QueryBuilderLike,
  spec: FilterSpec,
  ctx: FilterRequestContext | undefined,
): void {
  const serverFilters: ColumnFilter[] = [];

  if (spec.tenant) {
    const tenantId = spec.tenant.resolve(ctx);
    if (tenantId !== undefined && tenantId !== null) {
      serverFilters.push({ field: spec.tenant.column, operator: 'equals', value: tenantId });
    }
  }
  if (spec.defaultFilters.length > 0) {
    serverFilters.push(...(spec.defaultFilters as ColumnFilter[]));
  }
  if (serverFilters.length > 0) {
    applyColumnFilters(query, serverFilters);
  }
}

/** Fall back to the spec's `defaultSort` when the request supplied no sort. */
function withDefaultSort(input: FilterInput, spec: FilterSpec): FilterInput {
  if ((!input.sort || input.sort.length === 0) && spec.defaultSort.length > 0) {
    return { ...input, sort: [...spec.defaultSort] };
  }
  return input;
}

/**
 * Apply a {@link FilterSpec} to a Lucid query from a request context, returning
 * the resolved offset pagination — the single explicit call an AdonisJS
 * controller makes (the idiomatic replacement for the NestJS
 * `ApplyFilterInterceptor` + `@ApplyFilter` param decorator).
 *
 * It resolves the request input from `ctx.request.qs()`, injects the server
 * scope (tenant + default filters) that is never exposed to the allow-list, and
 * delegates the allow-listed filter/sort/search + pagination resolution to
 * {@link applyFilter}.
 *
 * ```ts
 * const spec = defineFilter({ filterable: ['name', 'age'], tenant: { column: 'tenantId', resolve: (ctx) => ctx.auth.user.tenantId } })
 *
 * // in a controller:
 * const query = User.query()
 * const { page, size } = applyFilterFromRequest(query, spec, ctx)
 * return query.paginate(page, size)
 * ```
 */
export function applyFilterFromRequest(
  query: QueryBuilderLike,
  spec: FilterSpec,
  ctx: FilterRequestContext | undefined,
  options?: ApplyFromRequestOptions,
): ResolvedPagination;
/**
 * The class form: the filter is resolved through the IoC container (so an `@inject()`ed
 * constructor works), its `setup()` runs before anything the request asked for, and every request
 * key the class owns a method for is dispatched to that method instead of the declarative path.
 * Resolution is async, so this overload returns a promise.
 */
export function applyFilterFromRequest(
  query: QueryBuilderLike,
  filter: FilterClass,
  ctx: FilterRequestContext | undefined,
  options?: ApplyFromRequestOptions,
): Promise<ResolvedPagination>;
export function applyFilterFromRequest(
  query: QueryBuilderLike,
  specOrClass: FilterSpec | FilterClass,
  ctx: FilterRequestContext | undefined,
  options: ApplyFromRequestOptions = {},
): ResolvedPagination | Promise<ResolvedPagination> {
  if (isFilterClass(specOrClass)) {
    return applyFilterClass(query, specOrClass, ctx, options);
  }
  return applySpec(query, specOrClass, ctx, options);
}

function applySpec(
  query: QueryBuilderLike,
  spec: FilterSpec,
  ctx: FilterRequestContext | undefined,
  options: ApplyFromRequestOptions,
): ResolvedPagination {
  const parsed = options.input ?? parseFilterRequest(rawQs(ctx));
  const withVector =
    options.vectorSimilarity !== undefined
      ? { ...parsed, vectorSimilarity: options.vectorSimilarity }
      : parsed;
  applyServerScope(query, spec, ctx);
  return applyFilter(query, withDefaultSort(withVector, spec), specToFilterConfig(spec));
}

/**
 * Resolve a filter class through the request's IoC container when there is one — the same
 * resolver a controller is constructed with, so `@inject()` on the filter behaves identically —
 * and fall back to plain construction outside an AdonisJS request (a test, a script).
 */
async function resolveFilter(
  cls: FilterClass,
  ctx: FilterRequestContext | undefined,
): Promise<BaseModelFilter> {
  const resolver = ctx?.containerResolver as
    | { make?: (c: unknown) => Promise<unknown> }
    | undefined;
  if (resolver && typeof resolver.make === 'function') {
    return (await resolver.make(cls)) as BaseModelFilter;
  }
  return new cls();
}

/**
 * Run a filter class against the query: bind the per-request state onto the instance, run
 * `setup()`, apply everything the class declared statically through the ordinary spec path, then
 * hand each key the class owns to its own method.
 *
 * The split matters: a key with a method is removed from the declarative input **before** the
 * runner sees it, so `fullName` never becomes `where "fullName" = ?` on a column that may not
 * exist — the method is the only thing that touches it.
 */
async function applyFilterClass(
  query: QueryBuilderLike,
  cls: FilterClass,
  ctx: FilterRequestContext | undefined,
  options: ApplyFromRequestOptions,
): Promise<ResolvedPagination> {
  const raw = rawQs(ctx);
  const parsed = options.input ?? parseFilterRequest(raw);
  const instance = await resolveFilter(cls, ctx);

  const owned: { method: string; value: unknown; operator: string }[] = [];
  const rest: ColumnFilter[] = [];
  for (const condition of parsed.filters ?? []) {
    const method = methodForKey(cls, condition.field);
    if (method === undefined) {
      rest.push(condition);
      continue;
    }
    owned.push({ method, value: condition.value, operator: condition.operator });
  }

  // A bare top-level key (`?minAge=21`) reaches a method of the same name too — the shape
  // `adonis-lucid-filter` dispatches on — as long as the wire format does not own the key.
  for (const [key, value] of Object.entries(raw)) {
    const method = methodForKey(cls, key);
    if (method !== undefined && !owned.some((entry) => entry.method === method)) {
      owned.push({ method, value, operator: 'equals' });
    }
  }

  Object.assign(instance, {
    $query: query,
    $input: raw,
    $parsed: parsed,
    $ctx: ctx,
  });

  await instance.setup?.();

  const pagination = applySpec(query, specFromFilterClass(cls), ctx, {
    ...options,
    input: { ...parsed, filters: rest },
  });

  for (const { method, value, operator } of owned) {
    const fn = (instance as unknown as Record<string, unknown>)[method];
    if (typeof fn === 'function') {
      await (fn as (v: unknown, op: string) => unknown).call(instance, value, operator);
    }
  }

  return pagination;
}

/** Parse cursor (keyset) params from a decoded query string (Spatie `page[...]` shapes). */
function parseCursorParams(qs: Record<string, unknown>): CursorParams {
  const out: CursorParams = {};
  const page =
    qs.page != null && typeof qs.page === 'object' && !Array.isArray(qs.page)
      ? (qs.page as Record<string, unknown>)
      : undefined;

  const after = qs.after ?? page?.after;
  const before = qs.before ?? page?.before;
  if (typeof after === 'string' && after.length > 0) out.after = after;
  else if (typeof before === 'string' && before.length > 0) out.before = before;

  const first = qs.first ?? page?.first;
  const last = qs.last ?? page?.last;
  const toInt = (v: unknown): number | undefined => {
    const n =
      typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const f = toInt(first);
  const l = toInt(last);
  if (f !== undefined) out.first = f;
  if (l !== undefined) out.last = l;

  return out;
}

/**
 * The keyset (cursor) counterpart of {@link applyFilterFromRequest}. Sources the
 * request filters and the `after`/`before`/`first`/`last` cursor params from ctx,
 * injects the same server scope, and delegates to {@link applyCursor}. Feed the
 * fetched rows and the returned {@link ResolvedCursor} to `buildCursorPage`.
 */
export function applyCursorFromRequest(
  query: QueryBuilderLike,
  spec: FilterSpec,
  ctx: FilterRequestContext | undefined,
  options: ApplyCursorFromRequestOptions = {},
): ResolvedCursor {
  const qs = rawQs(ctx);
  const parsed = options.input ?? parseFilterRequest(qs);
  const full: FilterInput & CursorParams = {
    ...withDefaultSort(parsed, spec),
    ...parseCursorParams(qs),
  };
  applyServerScope(query, spec, ctx);
  const config: CursorConfig = {
    ...specToFilterConfig(spec),
    ...(options.primaryKey !== undefined && { primaryKey: options.primaryKey }),
  };
  return applyCursor(query, full, config);
}
