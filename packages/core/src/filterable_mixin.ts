import { HttpContext } from '@adonisjs/core/http';
import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import type {
  LucidModel,
  ModelPaginatorContract,
  ModelQueryBuilderContract,
} from '@adonisjs/lucid/types/model';
import {
  type ApplyFromRequestOptions,
  type FilterRequestContext,
  applyFilterFromRequest,
} from './apply_from_request.js';
import type { FilterClass } from './filter_class.js';
import type { FilterSpec } from './filter_spec.js';
import { stashPagination } from './pagination_stash.js';
import type { ResolvedPagination } from './runner.js';

/**
 * Opt a Lucid model into filtering — the `adonis-lucid-filter` shape, with the rest of the
 * pipeline (search, sort, page bounds) included.
 *
 * ```ts
 * export default class User extends compose(BaseModel, Filterable) {
 *   static $filter = () => UserFilter
 * }
 * ```
 *
 * The model then answers two calls, and the first **hands the query builder back** — nothing is
 * executed until you say so:
 *
 * ```ts
 * // keep composing, then page it with what the request asked for
 * const { query } = await User.filter(ctx)
 * query.whereNotNull('confirmedAt').preload('team')
 * return query.filterPaginate()
 *
 * // or the one-liner
 * return User.filterPaginate(ctx)
 * ```
 *
 * The builder comes back inside an object rather than as the promise's own value on purpose: a
 * Lucid query builder is *thenable*, so `await`ing a promise that resolves to one would run the
 * query and hand you rows instead of the builder. Destructuring keeps the builder a builder.
 */
/**
 * What {@link Filterable} adds to a model, spelled out so the mixin's return type can be named
 * (an inferred anonymous class would drag Lucid's internals into every consumer's build).
 */
export interface FilteredQuery<M extends LucidModel> extends ResolvedPagination {
  /** The query builder, filtered/searched/sorted — yours to keep composing on, not yet executed. */
  query: ModelQueryBuilderContract<M>;
}

export interface FilterableModelStatics {
  /** The filter this model is read through. A thunk, so the filter may import the model back. */
  $filter?: () => FilterClass | FilterSpec;
  filter<M extends LucidModel>(
    this: M,
    ctx?: FilterRequestContext,
    filter?: FilterClass | FilterSpec,
    options?: ApplyFromRequestOptions,
  ): Promise<FilteredQuery<M>>;
  filterPaginate<M extends LucidModel>(
    this: M,
    ctx?: FilterRequestContext,
    filter?: FilterClass | FilterSpec,
    options?: ApplyFromRequestOptions,
  ): Promise<ModelPaginatorContract<InstanceType<M>>>;
}

export function Filterable<T extends NormalizeConstructor<LucidModel>>(
  superclass: T,
): T & FilterableModelStatics {
  class FilterableModel extends superclass {
    /** The filter this model is read through. A thunk, so the filter may import the model back. */
    static $filter?: () => FilterClass | FilterSpec;

    /**
     * Apply the model's filter to a fresh query and hand back the **query builder** plus the
     * pagination the request resolved to — filters, search and sort applied, nothing executed.
     * Compose whatever else the endpoint needs on the builder, then page it with
     * `filterPaginate()` (no arguments) or `paginate(page, size)`.
     */
    static async filter<M extends LucidModel>(
      this: M,
      ctx?: FilterRequestContext,
      filter?: FilterClass | FilterSpec,
      options?: ApplyFromRequestOptions,
    ): Promise<FilteredQuery<M>> {
      // `this` is the model the static was called on (a subclass of the mixin), which is exactly
      // what these helpers need — the rule's suggestion (name the class) would pin every model to
      // the anonymous mixin class instead.
      // biome-ignore lint/complexity/noThisInStatic: `this` is the calling model, by design.
      const model = this as unknown as typeof FilterableModel;
      const target = filter ?? model.$filter?.();
      if (!target) {
        throw new Error(
          // biome-ignore lint/complexity/noThisInStatic: names the model the call was made on.
          `${this.name} has no filter — declare \`static $filter = () => YourFilter\` on the model, or pass one to filter().`,
        );
      }

      // biome-ignore lint/complexity/noThisInStatic: the calling model builds its own query.
      const query = this.query() as ModelQueryBuilderContract<M>;
      const pagination = await applyFilterFromRequest(
        query as never,
        target as never,
        ctx ?? HttpContext.getOrFail(),
        options,
      );
      stashPagination(query, pagination);
      return { query, page: pagination.page, size: pagination.size };
    }

    /**
     * The same, then `paginate(page, size)` with the pagination the request resolved to — the
     * whole list endpoint in one call.
     */
    static async filterPaginate<M extends LucidModel>(
      this: M,
      ctx?: FilterRequestContext,
      filter?: FilterClass | FilterSpec,
      options?: ApplyFromRequestOptions,
    ): Promise<ModelPaginatorContract<InstanceType<M>>> {
      // biome-ignore lint/complexity/noThisInStatic: `this` is the calling model, by design.
      const model = this as unknown as typeof FilterableModel;
      // biome-ignore lint/complexity/noThisInStatic: forwards the call to the same model.
      const { query, page, size } = await model.filter.call(this, ctx, filter, options);
      return (query as ModelQueryBuilderContract<M>).paginate(page, size) as Promise<
        ModelPaginatorContract<InstanceType<M>>
      >;
    }
  }

  return FilterableModel as unknown as T & FilterableModelStatics;
}
