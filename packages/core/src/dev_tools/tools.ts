import type { FilterClientManifest } from '../generate_client.js';
import type { ManifestLoad } from '../manifest.js';
import type { DevTool, DevToolInputProperty, DevToolsHub } from './contract.js';
import { DEV_TOOLS_BINDING } from './contract.js';
import { describeSpec, explainFilterQuery } from './explain.js';

/** How the tools reach the app's `filters` manifest (resolved at call time). */
export interface FilterDevToolsDeps {
  manifest: () => Promise<ManifestLoad>;
}

const limit: DevToolInputProperty = {
  type: 'integer',
  description: 'How many items to return (default 20, max 100).',
  minimum: 1,
  maximum: 100,
};
const page: DevToolInputProperty = {
  type: 'integer',
  description: 'Page number, from 1 (the `next` of the previous answer).',
  minimum: 1,
};
const name: DevToolInputProperty = {
  type: 'string',
  description: 'The spec name: a key of the `filters` manifest in config/filter.ts.',
};

function intOf(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(max, Math.floor(value)))
    : fallback;
}

/** One page of `items` in the `{ items, next }` shape every dev-tools list returns. */
export function pageOf<T>(items: readonly T[], input: Record<string, unknown>) {
  const size = intOf(input.limit, 20, 100);
  const number = intOf(input.page, 1);
  const start = (number - 1) * size;
  return {
    items: items.slice(start, start + size),
    next: start + size < items.length ? number + 1 : null,
  };
}

/** Why the manifest could not be read, as one sentence for a person. */
export function manifestProblem(load: Exclude<ManifestLoad, { status: 'loaded' }>): string {
  switch (load.status) {
    case 'missing':
      return `No ${load.entrypoint.replace(/\.js$/, '.ts')}: declare an exported \`filters\` manifest there to list your specs.`;
    case 'empty':
      return `${load.entrypoint.replace(/\.js$/, '.ts')} exports no \`filters\` manifest of defineFilter specs.`;
    case 'failed':
      return `${load.entrypoint.replace(/\.js$/, '.ts')} failed to load: ${load.error}`;
  }
}

async function manifestOrThrow(deps: FilterDevToolsDeps): Promise<FilterClientManifest> {
  const load = await deps.manifest();
  if (load.status !== 'loaded') throw new Error(manifestProblem(load));
  return load.manifest;
}

async function entryOf(deps: FilterDevToolsDeps, name: unknown) {
  const key = typeof name === 'string' ? name.trim() : '';
  if (key === '') throw new Error('`name` is required: a spec name from filter_list_specs');
  const manifest = await manifestOrThrow(deps);
  if (!Object.hasOwn(manifest, key)) {
    throw new Error(`No spec "${key}". Known: ${Object.keys(manifest).sort().join(', ')}`);
  }
  return { key, entry: manifest[key] as FilterClientManifest[string] };
}

/** One row of {@link listFilterSpecs}. */
export interface FilterSpecSummary {
  name: string;
  filterable: number | '*';
  sortable: number | '*';
  searchable: string[];
  relations: string[];
  tenantScoped: boolean;
}

/**
 * Every spec of the `filters` manifest, sorted by name, as `filter_list_specs` and
 * `filter:specs:list` show them. A manifest that cannot be read gives no specs and a `hint`.
 */
export async function listFilterSpecs(
  deps: FilterDevToolsDeps,
): Promise<{ items: FilterSpecSummary[]; hint?: string }> {
  const load = await deps.manifest();
  if (load.status !== 'loaded') return { items: [], hint: manifestProblem(load) };
  const items = Object.entries(load.manifest)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]): FilterSpecSummary => {
      const spec = describeSpec(entry.spec, key);
      return {
        name: key,
        filterable: spec.filterable === '*' ? '*' : spec.filterablePaths.length,
        sortable: spec.sortable === '*' ? '*' : spec.sortablePaths.length,
        searchable: spec.searchable,
        relations: Object.keys(spec.relations),
        tenantScoped: spec.tenantColumn !== null,
      };
    });
  return { items };
}

/** One spec in full (`filter_get_spec`, `filter:specs:show`). Throws on an unknown name. */
export async function getFilterSpec(deps: FilterDevToolsDeps, name: unknown) {
  const { key, entry } = await entryOf(deps, name);
  return { ...describeSpec(entry.spec, key), clientFieldTypes: entry.fieldTypes ?? {} };
}

/** Dry run of a query string against a spec (`filter_explain_query`, `filter:query:explain`). */
export async function explainFilterSpecQuery(
  deps: FilterDevToolsDeps,
  name: unknown,
  query: unknown,
) {
  const { key, entry } = await entryOf(deps, name);
  return { spec: key, ...explainFilterQuery(entry.spec, typeof query === 'string' ? query : '') };
}

/** The filter developer tools (all read-only, no database). */
export function filterDevTools(deps: FilterDevToolsDeps): DevTool[] {
  return [
    {
      name: 'filter_list_specs',
      kind: 'read',
      description:
        'The filter specs declared in the `filters` manifest of config/filter.ts: name, how many ' +
        'filterable/sortable fields, searchable fields and relations. Paged: { items, next }.',
      input: { type: 'object', properties: { limit, page } },
      async run(input) {
        const { items, hint } = await listFilterSpecs(deps);
        return hint === undefined ? pageOf(items, input) : { items, next: null, hint };
      },
    },
    {
      name: 'filter_get_spec',
      kind: 'read',
      description:
        'One filter spec in full: filterable and sortable paths (relation-dotted), field types, ' +
        'operators, searchable/full-text, relations, maxDepth, aliases, computed fields, tenant ' +
        'column, default filters/sort and page sizes.',
      input: { type: 'object', properties: { name }, required: ['name'] },
      async run(input) {
        return getFilterSpec(deps, input.name);
      },
    },
    {
      name: 'filter_explain_query',
      kind: 'read',
      description:
        'Dry-run a query string (filter[name][contains]=Al&sort=-age&page=2) against a spec, with ' +
        'no database: what the server parses, which filters/sorts are dropped or make the request ' +
        'fail and why, the query-builder calls it would make, and the resolved page/size.',
      input: {
        type: 'object',
        properties: {
          name,
          query: {
            type: 'string',
            description: 'The query string, with or without the leading `?`.',
          },
        },
        required: ['name', 'query'],
      },
      async run(input) {
        return explainFilterSpecQuery(deps, input.name, input.query);
      },
    },
  ];
}

/** The slice of the AdonisJS container {@link registerFilterDevTools} uses. */
export interface DevToolsContainer {
  hasBinding(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

/**
 * Register the filter tools into the dev-tools hub, when the agent's MCP provider bound one and it
 * can gate a lib without a console (`supports('endpoint-authorize')`). Never throws: returns why it
 * did not register.
 */
export async function registerFilterDevTools(
  container: DevToolsContainer,
  deps: FilterDevToolsDeps,
): Promise<'registered' | 'no-hub' | 'unsupported' | 'failed'> {
  if (!container.hasBinding(DEV_TOOLS_BINDING)) return 'no-hub';
  try {
    const hub = (await container.make(DEV_TOOLS_BINDING)) as DevToolsHub | undefined;
    if (hub?.version !== 1) return 'unsupported';
    if (typeof hub.supports !== 'function' || !hub.supports('endpoint-authorize')) {
      return 'unsupported';
    }
    hub.register({ lib: 'filter', title: 'Query filters', tools: filterDevTools(deps) });
    return 'registered';
  } catch {
    return 'failed';
  }
}
