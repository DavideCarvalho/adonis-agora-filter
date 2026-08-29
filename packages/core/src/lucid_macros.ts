import { HttpContext } from '@adonisjs/core/http';
import type { LucidModel } from '@adonisjs/lucid/types/model';
import {
  type ApplyFromRequestOptions,
  type FilterRequestContext,
  applyFilterFromRequest,
} from './apply_from_request.js';
import { type FilterClass, isFilterClass } from './filter_class.js';
import type { FilterSpec } from './filter_spec.js';
import type { QueryBuilderLike } from './lucid_adapter.js';
import { readPagination, stashPagination } from './pagination_stash.js';
import type { ResolvedPagination } from './runner.js';

/**
 * O ctx da request para o macro: explícito, ou o `HttpContext` ativo lido do AsyncLocalStorage do
 * Adonis quando omitido. `getOrFail()` lança quando não há request em escopo (ex.: chamada dentro de
 * um job/command) — nesse caso passe o ctx explicitamente. Fica no macro (camada Adonis); o
 * `applyFilterFromRequest` livre continua framework-agnostic, exigindo o ctx.
 */
function resolveCtx(ctx: FilterRequestContext | undefined): FilterRequestContext {
  return ctx ?? HttpContext.getOrFail();
}

/**
 * The static slice of a Lucid query-builder class we register onto: Adonis'
 * `Macroable.macro(name, fn)` adds `fn` to the builder prototype so every query
 * instance gains the method. Declared structurally so this module never
 * hard-imports `@adonisjs/lucid` at runtime (the provider passes the real
 * `ModelQueryBuilder` in) — matching how the rest of the package stays
 * framework-free.
 */
export interface MacroableQueryBuilder {
  macro(name: string, fn: (this: unknown, ...args: never[]) => unknown): void;
}

/**
 * Register the chainable filter macros onto a Lucid query-builder class (the
 * method-call form of {@link applyFilterFromRequest}). Call this from a provider's
 * `boot()` with `ModelQueryBuilder` (from `@adonisjs/lucid/orm`); the
 * `@adonis-agora/filter` provider does exactly that.
 *
 * Two macros are added:
 *
 * - `query.applyFilterFromRequest(spec, ctx, options?)` — applies the spec's
 *   server scope + allow-listed filter/sort/search and returns the query so it
 *   chains (`User.query().applyFilterFromRequest(spec, ctx).orderBy(...)`). The
 *   resolved pagination is dropped; use `filterPaginate` (or the free function)
 *   when you need it.
 * - `query.filterPaginate(spec, ctx, options?)` — applies the same and then
 *   `paginate(page, size)` with the resolved pagination, returning Lucid's
 *   paginator (`await User.query().filterPaginate(spec, ctx)`).
 *
 * Idempotent enough to call once at boot; calling twice re-defines the macros to
 * the same implementations.
 */
export function registerFilterMacros(ModelQueryBuilder: MacroableQueryBuilder): void {
  ModelQueryBuilder.macro('applyFilterFromRequest', function (
    this: QueryBuilderLike,
    filter: FilterSpec | FilterClass,
    ctx?: FilterRequestContext,
    options?: ApplyFromRequestOptions,
  ) {
    // A class is resolved through the container, so this leg is async — and it resolves to the
    // pagination rather than to the builder: a Lucid query builder is thenable, so a promise that
    // resolved to one would execute the query instead of handing it back. You already hold the
    // builder; `await query.applyFilterFromRequest(UserFilter)` gives you its `{ page, size }`.
    if (isFilterClass(filter)) {
      return applyFilterFromRequest(this, filter, resolveCtx(ctx), options).then((pagination) => {
        stashPagination(this, pagination);
        return pagination;
      });
    }
    stashPagination(this, applyFilterFromRequest(this, filter, resolveCtx(ctx), options));
    return this;
  } as (this: unknown, ...args: never[]) => unknown);

  ModelQueryBuilder.macro('filterPaginate', function (
    this: QueryBuilderLike & { paginate(page: number, perPage: number): unknown },
    filter?: FilterSpec | FilterClass,
    ctx?: FilterRequestContext,
    options?: ApplyFromRequestOptions,
  ) {
    // No filter argument: this query has already been through one (the model's `filter()`, or the
    // `applyFilterFromRequest` macro), so page it with the pagination that call resolved.
    if (filter === undefined) {
      const stashed = readPagination(this);
      if (!stashed) {
        throw new Error(
          'filterPaginate() was called with no filter on a query that has not been filtered. Pass the filter — filterPaginate(UserFilter) — or apply one first.',
        );
      }
      return this.paginate(stashed.page, stashed.size);
    }

    if (isFilterClass(filter)) {
      return applyFilterFromRequest(this, filter, resolveCtx(ctx), options).then(
        ({ page, size }: ResolvedPagination) => this.paginate(page, size),
      );
    }
    const { page, size } = applyFilterFromRequest(this, filter, resolveCtx(ctx), options);
    return this.paginate(page, size);
  } as (this: unknown, ...args: never[]) => unknown);
}

declare module '@adonisjs/lucid/types/model' {
  interface ModelQueryBuilderContract<Model extends LucidModel, Result = InstanceType<Model>> {
    /**
     * Apply a {@link FilterSpec} from the request context (server scope +
     * allow-listed filter/sort/search) and return the query for chaining — the
     * method form of the free `applyFilterFromRequest`. Pagination is resolved
     * but not returned here; use {@link filterPaginate} when you need it.
     *
     * `ctx` is optional: when omitted, the active `HttpContext` is read from
     * AsyncLocalStorage (`HttpContext.getOrFail()`). Pass it explicitly outside a
     * request scope (e.g. a job/command), where there is no ambient context.
     */
    applyFilterFromRequest(
      spec: FilterSpec,
      ctx?: FilterRequestContext,
      options?: ApplyFromRequestOptions,
    ): this;
    /**
     * The same for a filter **class**: resolved through the IoC container (so `@inject()` works),
     * `setup()` first, then every request key the class owns a method for.
     *
     * Resolution is async, so this returns a promise — of the resolved `{ page, size }`, not of
     * the builder (a Lucid builder is thenable, so awaiting a promise of one would run the query).
     * The builder is the one you called it on, still yours to compose on:
     *
     * ```ts
     * const query = User.query().whereNull('deletedAt')
     * const { page, size } = await query.applyFilterFromRequest(UserFilter)
     * return query.preload('team').paginate(page, size)
     * ```
     */
    applyFilterFromRequest(
      filter: FilterClass,
      ctx?: FilterRequestContext,
      options?: ApplyFromRequestOptions,
    ): Promise<ResolvedPagination>;
    /**
     * Apply a {@link FilterSpec} from the request context and paginate with the
     * resolved `{ page, size }`, returning Lucid's paginator — filter + paginate
     * in one terminal call. `ctx` is optional (see {@link applyFilterFromRequest}).
     */
    filterPaginate(
      spec: FilterSpec,
      ctx?: FilterRequestContext,
      options?: ApplyFromRequestOptions,
    ): ReturnType<this['paginate']>;
    /** The filter-class form of {@link filterPaginate} — async, for the same reason. */
    filterPaginate(
      filter: FilterClass,
      ctx?: FilterRequestContext,
      options?: ApplyFromRequestOptions,
    ): Promise<Awaited<ReturnType<this['paginate']>>>;
    /**
     * Page a query that has **already** been filtered (by the model's `filter()` or by the
     * `applyFilterFromRequest` macro) with the `{ page, size }` that call resolved — so a
     * controller can keep composing on the builder and still page it the way the request asked.
     *
     * ```ts
     * const query = await User.filter(ctx)
     * query.whereNotNull('confirmedAt')
     * return query.filterPaginate()
     * ```
     */
    filterPaginate(): ReturnType<this['paginate']>;
  }
}
