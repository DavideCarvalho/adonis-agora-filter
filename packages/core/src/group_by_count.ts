import { applyServerScope, type FilterRequestContext } from './apply_from_request.js';
import type { CustomFilterClass } from './custom_filter.js';
import { applyCustomFilter } from './custom_filter.js';
import { type FilterClass, isFilterClass, specFromFilterClass } from './filter_class.js';
import type { FilterSpec } from './filter_spec.js';
import { specToFilterConfig } from './filter_spec.js';
import type { QueryBuilderLike } from './lucid_adapter.js';
import { applyGroupByCount } from './lucid_adapter.js';
import { parseFilterRequest } from './parse_request.js';
import { applyFilterConditions, resolveSafeDistinct } from './runner.js';
import type { FilterConfig, FilterInput, GroupByCountOptions } from './types.js';
import { InvalidColumnFilterError } from './validate-column-filter.js';

/** One enumerated value and how many matching rows carry it — the rows behind a picker. */
export interface GroupByCountRow {
  value: unknown;
  count: number;
}

/**
 * Count the distinct values of one field over a CUSTOM backend — the seam a non-Lucide store
 * implements so its consoles get pickers too. The helper runs the filter class over the active
 * scope first (unknown fields fail there, loudly), then hands the narrowed draft over: the
 * adapter never parses a query string, it only counts.
 */
export interface GroupByCountAdapter<D> {
  groupByCount(field: string, draft: D, opts: GroupByCountOptions): Promise<GroupByCountRow[]>;
}

/** Options for {@link groupByCountFromRequest}. */
export interface GroupByCountFromRequestOptions<D = unknown> {
  /**
   * Pre-parsed input to use instead of reading `ctx.request.qs()`. Useful for non-HTTP callers
   * and tests.
   */
  input?: FilterInput;
  /** The axis to enumerate, when the request does not carry a `groupByCount[field]`. */
  field?: string;
  /** Cap the returned groups (highest count first). */
  limit?: number;
  /** Skip groups — pages the fixed count-desc/value-asc ordering. */
  offset?: number;
  /** Narrow to groups whose value contains this text. */
  search?: string;
  /**
   * Custom-backend counting: the narrowed draft is handed to this adapter instead of running a
   * `GROUP BY` on the builder. Required when the first argument is a draft rather than a Lucid
   * builder.
   */
  adapter?: GroupByCountAdapter<D>;
}

/**
 * Check a grouping field against the allow-list — the same boundary `sort`/`distinct` enforce
 * (aliases resolve first; relation paths never project). Unknown fields are rejected outright,
 * never silently ignored: the grouping column IS the whole query, so there is no safe default
 * for a typo.
 */
function resolveGroupField(field: string | undefined, config: FilterConfig): string {
  if (!field || typeof field !== 'string' || field.trim() === '') {
    throw new InvalidColumnFilterError('groupByCount needs a `field` — `groupByCount[field]=tag`.');
  }
  const [column] = resolveSafeDistinct([field], { ...config, throwOnInvalid: false });
  if (column === undefined) {
    throw new InvalidColumnFilterError(`Cannot group by unlisted field: "${field}".`);
  }
  return column;
}

/**
 * Terminal group-by-count aggregation — the value pickers' query: the distinct values of one
 * field with counts, over the rows the active filters select.
 *
 * Lucid mode (a query builder, no adapter): the server scope plus the request filters and search
 * apply on the builder, then a `GROUP BY` replaces entity-row output — most groups first, so the
 * answer is pageable. Sort/pagination/distinct of the listing do not apply: this mode replaces
 * entity rows.
 *
 * Custom mode (a draft + `adapter`): the filter class narrows the draft over the same scope,
 * then the adapter counts it — a Lucid builder never enters the picture.
 *
 * ```ts
 * // Lucid — in a controller:
 * const rows = await groupByCountFromRequest(User.query(), UserFilter, ctx);
 *
 * // custom backend — same shape, a draft instead of a builder:
 * const rows = await groupByCountFromRequest(draft, RunFilter, ctx, { adapter });
 * ```
 */
export async function groupByCountFromRequest(
  qb: QueryBuilderLike,
  spec: FilterSpec | FilterClass,
  ctx: FilterRequestContext | undefined,
  opts?: GroupByCountFromRequestOptions<never>,
): Promise<GroupByCountRow[]>;
export async function groupByCountFromRequest<D>(
  draft: D,
  cls: CustomFilterClass<D>,
  ctx: FilterRequestContext | undefined,
  opts: GroupByCountFromRequestOptions<D> & { adapter: GroupByCountAdapter<D> },
): Promise<GroupByCountRow[]>;
export async function groupByCountFromRequest<D>(
  qbOrDraft: QueryBuilderLike | D,
  specOrClass: FilterSpec | FilterClass | CustomFilterClass<D>,
  ctx: FilterRequestContext | undefined,
  opts: GroupByCountFromRequestOptions<D> = {},
): Promise<GroupByCountRow[]> {
  const raw: Record<string, unknown> = ctx?.request?.qs?.() ?? {};
  const parsed = opts.input ?? parseFilterRequest(raw);
  const limit = opts.limit ?? parsed.groupByCount?.limit;
  const offset = opts.offset ?? parsed.groupByCount?.offset;
  const search = opts.search ?? parsed.groupByCount?.search;

  if (opts.adapter) {
    const draft = qbOrDraft as D;
    await applyCustomFilter(draft, specOrClass as CustomFilterClass<D>, ctx, { input: parsed });
    const field = opts.field ?? parsed.groupByCount?.field;
    if (!field || typeof field !== 'string' || field.trim() === '') {
      throw new InvalidColumnFilterError(
        'groupByCount needs a `field` — `groupByCount[field]=tag`.',
      );
    }
    return opts.adapter.groupByCount(field, draft, {
      ...(limit !== undefined && { limit }),
      ...(offset !== undefined && { offset }),
      ...(search !== undefined && { search }),
    });
  }

  const spec =
    typeof specOrClass === 'function' && isFilterClass(specOrClass as FilterClass)
      ? specFromFilterClass(specOrClass as FilterClass)
      : (specOrClass as FilterSpec);
  const config = specToFilterConfig(spec);
  const column = resolveGroupField(opts.field ?? parsed.groupByCount?.field, config);
  const qb = qbOrDraft as QueryBuilderLike;
  applyServerScope(qb, spec, ctx);
  applyFilterConditions(
    qb,
    {
      ...(parsed.filters !== undefined && { filters: parsed.filters }),
      ...(parsed.search !== undefined && { search: parsed.search }),
    },
    config,
  );
  applyGroupByCount(qb, column, {
    ...(limit !== undefined && { limit }),
    ...(offset !== undefined && { offset }),
    ...(search !== undefined && { search }),
  });
  // Lucid builders are thenable (awaiting runs the query) — outside the structural seam's
  // vocabulary, hence the cast at the single point that executes. Model queries hydrate rows
  // into model instances, where ad-hoc selects land in `$extras` rather than as direct props;
  // plain builders return the raw `{ value, count }` rows. Both shapes map to the same answer.
  const rows = (await qb) as unknown as Array<{
    value?: unknown;
    count?: number | string;
    $extras?: Record<string, unknown>;
  }>;
  return rows.map((row) => {
    const value = row.value ?? row.$extras?.value ?? null;
    const count = row.count ?? row.$extras?.count;
    return { value, count: Number(count) };
  });
}
