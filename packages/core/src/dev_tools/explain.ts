import type { FilterSpec } from '../filter_spec.js';
import { specToFilterConfig } from '../filter_spec.js';
import { filterableFieldPaths, sortableFieldPaths } from '../generate_client.js';
import type { QueryBuilderLike } from '../lucid_adapter.js';
import { FILTER_OPERATORS, OPERATOR_ALIASES } from '../operators.js';
import { parseFilterRequest } from '../parse_request.js';
import { applyFilter } from '../runner.js';
import type { FilterConfig, FilterInput } from '../types.js';
import { parseQueryString } from './query_string.js';

/** One query-builder call a dry run recorded. */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

/** What a request part (one filter, one sort…) does under the spec. */
export interface ExplainIssue {
  part: 'filter' | 'sort' | 'distinct' | 'search' | 'size';
  /** The field (or the raw value) the issue is about. */
  subject: string;
  message: string;
  /** `rejected`: the request fails; `dropped`: silently ignored; `clamped`/`ignored`: adjusted. */
  effect: 'rejected' | 'dropped' | 'clamped' | 'ignored';
}

/** The result of {@link explainFilterQuery}. */
export interface FilterQueryExplanation {
  /** What the query string decodes to (`ctx.request.qs()`). */
  decoded: Record<string, unknown>;
  /** The filters, sorts, search and pagination the server reads from it. */
  parsed: FilterInput;
  /** `true` when the request would be refused (a 4xx from `InvalidColumnFilterError`). */
  rejected: boolean;
  rejection: string | null;
  issues: ExplainIssue[];
  /** The query-builder calls the request filters, search and sort produce (no tenant scope). */
  calls: RecordedCall[];
  pagination: { page: number; size: number } | null;
  /** What the server adds on its own, outside the client's control. */
  serverScope: { tenantColumn: string | null; defaultFilters: unknown[] };
}

const MAX_VALUE = 200;

function show(value: unknown): unknown {
  if (typeof value === 'string')
    return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(show);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) out[k] = show(v);
    return out;
  }
  return value;
}

/**
 * A query builder that records every call instead of running SQL: the dry-run target. Callback
 * arguments (sub-queries, `whereHas`) are run against a nested recorder and kept as `calls`.
 */
export function recordingBuilder(calls: RecordedCall[] = []): {
  qb: QueryBuilderLike;
  calls: RecordedCall[];
} {
  const qb: QueryBuilderLike = new Proxy({} as QueryBuilderLike, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args: unknown[]) => {
        const recorded = args.map((arg) => {
          if (typeof arg !== 'function') return show(arg);
          const nested = recordingBuilder();
          (arg as (q: QueryBuilderLike) => unknown)(nested.qb);
          return { callback: nested.calls };
        });
        calls.push({ method: prop, args: recorded });
        return qb;
      };
    },
  });
  return { qb, calls };
}

function attempt(input: FilterInput, config: FilterConfig): string | null {
  try {
    applyFilter(recordingBuilder().qb, input, config);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Dry-run a query string against a spec, through the same parse, alias, validation, allow-list
 * and builder code a request runs, with no database: what is kept, what is dropped or refused, and
 * the builder calls it would make.
 */
export function explainFilterQuery(spec: FilterSpec, query: string): FilterQueryExplanation {
  const decoded = parseQueryString(query);
  const parsed = parseFilterRequest(decoded);
  const config = specToFilterConfig(spec);
  const strict: FilterConfig = { ...config, throwOnInvalid: true };
  const input: FilterInput =
    (!parsed.sort || parsed.sort.length === 0) && spec.defaultSort.length > 0
      ? { ...parsed, sort: [...spec.defaultSort] }
      : parsed;

  const issues: ExplainIssue[] = [];
  const check = (part: ExplainIssue['part'], subject: string, single: FilterInput) => {
    const asConfigured = attempt(single, config);
    if (asConfigured !== null) {
      issues.push({ part, subject, message: asConfigured, effect: 'rejected' });
      return;
    }
    const asStrict = attempt(single, strict);
    if (asStrict !== null) issues.push({ part, subject, message: asStrict, effect: 'dropped' });
  };
  for (const filter of parsed.filters ?? []) {
    const subject = filter.field || (filter.AND ? 'AND group' : filter.OR ? 'OR group' : '?');
    check('filter', subject, { filters: [filter] });
  }
  for (const sort of parsed.sort ?? []) check('sort', sort.field, { sort: [sort] });
  for (const field of parsed.distinct ?? []) check('distinct', field, { distinct: [field] });
  if (parsed.search !== undefined && !spec.fullText && spec.searchable.length === 0) {
    issues.push({
      part: 'search',
      subject: parsed.search,
      message: 'the spec declares no `searchable` fields or `fullText`, so `search` does nothing',
      effect: 'ignored',
    });
  }
  const maxSize = spec.maxSize ?? 100;
  if (parsed.size !== undefined && (parsed.size > maxSize || parsed.size < 1)) {
    issues.push({
      part: 'size',
      subject: String(parsed.size),
      message: `size is clamped to 1..${maxSize}`,
      effect: 'clamped',
    });
  }

  const recorder = recordingBuilder();
  let rejection: string | null = null;
  let pagination: { page: number; size: number } | null = null;
  try {
    pagination = applyFilter(recorder.qb, input, config);
  } catch (error) {
    rejection = error instanceof Error ? error.message : String(error);
  }

  return {
    decoded,
    parsed,
    rejected: rejection !== null,
    rejection,
    issues,
    calls: rejection === null ? recorder.calls : [],
    pagination,
    serverScope: {
      tenantColumn: spec.tenant?.column ?? null,
      defaultFilters: spec.defaultFilters.map(show),
    },
  };
}

/** The spec as data: allow-lists with field types and operators, relations and defaults. */
export function describeSpec(spec: FilterSpec, name: string) {
  return {
    name,
    filterable: spec.filterable,
    sortable: spec.sortable,
    /** Every filterable path, relation-dotted (`'*'` lists contribute none). */
    filterablePaths: filterableFieldPaths(spec),
    sortablePaths: sortableFieldPaths(spec),
    operators: [...FILTER_OPERATORS],
    operatorAliases: { ...OPERATOR_ALIASES },
    searchable: [...spec.searchable],
    fullText: spec.fullText ? { column: spec.fullText.column } : null,
    fieldTypes: spec.fieldTypes ?? {},
    relations: describeRelations(spec.relations),
    maxDepth: spec.maxDepth,
    aliases: spec.aliases ?? {},
    computed: spec.computed
      ? Object.fromEntries(
          Object.entries(spec.computed).map(([key, source]) => [
            key,
            typeof source === 'string' ? source : '(function)',
          ]),
        )
      : {},
    tenantColumn: spec.tenant?.column ?? null,
    defaultFilters: spec.defaultFilters.map(show),
    defaultSort: [...spec.defaultSort],
    defaultSize: spec.defaultSize ?? null,
    maxSize: spec.maxSize ?? null,
    throwOnInvalid: spec.throwOnInvalid,
  };
}

function describeRelations(
  relations: FilterSpec['relations'],
): Record<string, { filterable: unknown; sortable: unknown; relations: unknown }> {
  const out: Record<string, { filterable: unknown; sortable: unknown; relations: unknown }> = {};
  for (const [key, rel] of Object.entries(relations)) {
    out[key] = {
      filterable: rel.filterable,
      sortable: rel.sortable ?? rel.filterable,
      relations: rel.relations ? describeRelations(rel.relations) : {},
    };
  }
  return out;
}
