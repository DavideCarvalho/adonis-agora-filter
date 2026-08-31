import type { FilterSpec, RelationSpec } from './filter_spec.js';

/**
 * Codegen for the typed client — the AdonisJS-idiomatic port of the NestJS
 * `nestjs-filter` codegen. Where the NestJS package ships a standalone
 * `reflect-metadata` bin that reads decorator metadata off entity classes and
 * emits `filterQuery: () => filterQueryTyped<Fields, TypeMap>()` members into a
 * generated `api.ts`, the Adonis port has no decorators: the filter declaration
 * is already a plain runtime {@link FilterSpec} produced by `defineFilter(...)`.
 *
 * So generation is a **pure function of the spec** — string in, string out, no
 * AST walk, no metadata reflection, no framework. The ace command
 * (`make:filter-client`) is the thin IO wrapper that loads the app's declared
 * specs and writes the emitted module to disk. Keeping the generator pure keeps
 * it trivially testable (snapshot/string assertions) and framework-free, exactly
 * like the rest of this core.
 *
 * The emitted module targets `@adonis-agora/filter-client`'s `filterQueryTyped<Fields,
 * FieldTypes>()` factory — the same client the NestJS codegen emitted against —
 * so the two ecosystems share one browser runtime.
 */

// Moved to types.ts — the kind now drives server-side value coercion too, not just codegen.
// Imported for local use and re-exported so existing `from '.../generate_client.js'` imports keep working.
import type { FilterFieldKind } from './types.js';

export type { FilterFieldKind };

/**
 * Optional per-field type information. A {@link FilterSpec} carries the
 * allow-list but not column value types (Lucid models aren't reflected here), so
 * the caller supplies types to unlock the client's type-aware operator narrowing.
 * Without it the emitted client is still field-name-safe, just operator-permissive.
 */
export interface FilterFieldTypeInfo {
  /** Classified value kind. Ignored when {@link typeRef} or {@link enumValues} is set. */
  kind?: FilterFieldKind;
  /** Enum literal members — emitted as a union (`"A" | "B"` or `1 | 2`). Wins over {@link kind}. */
  enumValues?: readonly (string | number)[];
  /** A named TS type (e.g. `'Role'`) — emitted verbatim. Wins over everything. */
  typeRef?: string;
  /** Nullable column — appends `| null` to the emitted type. */
  nullable?: boolean;
}

/** Options for {@link generateFilterClient}. */
export interface GenerateFilterClientOptions {
  /**
   * Base name for the emitted identifiers — e.g. `'people'` yields
   * `PeopleFilterFields`, `PeopleFilterFieldTypes`, `peopleFilterMeta` and
   * `peopleFilterQuery()`. Non-identifier characters are stripped.
   */
  name: string;
  /** Per-field value types keyed by (dotted) field path. Unlocks operator narrowing. */
  fieldTypes?: Record<string, FilterFieldTypeInfo>;
  /** Import specifier for `filterQueryTyped`. Default `'@adonis-agora/filter-client'`. */
  clientModule?: string;
  /** Cap relation-path depth of the emitted field union. Default {@link FilterSpec.maxDepth}. */
  maxDepth?: number;
  /** Emit the "generated — do not edit" banner. Default `true`. */
  banner?: boolean;
}

/** Enumerate the filterable field paths a spec admits, capped at `maxDepth` relation hops. */
export function filterableFieldPaths(spec: FilterSpec, maxDepth = spec.maxDepth): string[] {
  return collectPaths(spec, 'filterable', maxDepth);
}

/** Enumerate the sortable field paths a spec admits, capped at `maxDepth` relation hops. */
export function sortableFieldPaths(spec: FilterSpec, maxDepth = spec.maxDepth): string[] {
  return collectPaths(spec, 'sortable', maxDepth);
}

/**
 * Walk the spec's base allow-list + relation whitelist into a flat, de-duped list
 * of (dotted) field paths, bounded by `maxDepth` relation hops. A `'*'` allow-list
 * cannot be enumerated (any column), so it contributes no concrete base names —
 * the emitter then falls back to a permissive `string` field union.
 */
function collectPaths(
  spec: FilterSpec,
  kind: 'filterable' | 'sortable',
  maxDepth: number,
): string[] {
  const out: string[] = [];
  const base = kind === 'filterable' ? spec.filterable : spec.sortable;
  if (Array.isArray(base)) out.push(...base);

  // Computed/virtual fields are both filterable and sortable — surface their
  // declared aliases in the client's field union so a generated client can
  // reference `fullName`/`postCount` exactly like a real column.
  if (spec.computed) out.push(...Object.keys(spec.computed));

  const walk = (
    relations: Readonly<Record<string, RelationSpec>>,
    prefix: string[],
    depth: number,
  ): void => {
    if (depth > maxDepth) return;
    for (const [relName, rel] of Object.entries(relations)) {
      const cols = kind === 'filterable' ? rel.filterable : (rel.sortable ?? rel.filterable);
      if (Array.isArray(cols)) {
        for (const col of cols) out.push([...prefix, relName, col].join('.'));
      }
      if (rel.relations) walk(rel.relations, [...prefix, relName], depth + 1);
    }
  };
  walk(spec.relations, [], 1);

  return [...new Set(out)];
}

/** `foo-bar_baz` → `FooBarBaz`. Strips non-identifier chars, PascalCases the rest. */
function toPascalCase(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal || 'Filter';
}

/** PascalCase but a lowercased first char — the value-identifier form (`peopleFilterQuery`). */
function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** `BlogPost`/`blog-post` → `blog_post` — the AdonisJS file-name convention. */
function toSnakeCase(name: string): string {
  return toPascalCase(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** Map a field's type info to a TS type literal. Mirrors the NestJS `kindToTs` emitter. */
function fieldTypeToTs(info: FilterFieldTypeInfo): string {
  if (info.typeRef) return info.typeRef;
  if (info.enumValues && info.enumValues.length > 0) {
    return info.enumValues
      .map((v) => (typeof v === 'number' ? String(v) : JSON.stringify(v)))
      .join(' | ');
  }
  switch (info.kind) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'Date';
    case 'json':
      return 'Record<string, unknown>';
    default:
      return 'unknown';
  }
}

/** The classifier kind stored in runtime meta (`typeRef`/enum collapse to their base bucket). */
function metaKind(info: FilterFieldTypeInfo): FilterFieldKind {
  return info.kind ?? 'unknown';
}

/**
 * Generate a typed filter client module for one {@link FilterSpec} — a pure
 * string transform. The emitted module exports, for a spec named `people`:
 *
 * - `type PeopleFilterFields` — the union of filterable field paths (the security
 *   boundary, as concrete string literals);
 * - `interface PeopleFilterFieldTypes` — the per-field value-type map (only when
 *   `fieldTypes` is supplied), which drives the client's operator/value narrowing;
 * - `const peopleFilterMeta` — runtime metadata (filterable/sortable/searchable
 *   fields, whitelisted relations, per-field kinds, and the default sort / page
 *   size / max size + cursor keyset the runner paginates by);
 * - `function peopleFilterQuery()` — a `filterQueryTyped<Fields, FieldTypes>()`
 *   factory returning a type-safe builder scoped to this spec.
 */
export function generateFilterClient(
  spec: FilterSpec,
  options: GenerateFilterClientOptions,
): string {
  const pascal = toPascalCase(options.name);
  const camel = toCamelCase(options.name);
  const clientModule = options.clientModule ?? '@adonis-agora/filter-client';
  const maxDepth = options.maxDepth ?? spec.maxDepth;
  // The spec's own `fieldTypes` are the default source: declaring a kind there already drives
  // server-side value coercion, so inheriting it here means one declaration feeds both ends
  // instead of asking callers to repeat themselves in the manifest. An explicit `options.fieldTypes`
  // still wins, for a caller that wants richer codegen-only info (enumValues/typeRef) than the
  // server needs.
  const fieldTypes = options.fieldTypes ?? spec.fieldTypes ?? {};
  const hasTypes = Object.keys(fieldTypes).length > 0;

  const fields = filterableFieldPaths(spec, maxDepth);
  const sortable = sortableFieldPaths(spec, maxDepth);
  const relations = Object.keys(spec.relations);
  const cursorKeyset = spec.defaultSort.map((s) => s.field);

  const fieldsUnion =
    fields.length > 0 ? fields.map((f) => JSON.stringify(f)).join(' | ') : 'string';

  const typesTypeName = `${pascal}FilterFieldTypes`;
  const fieldsTypeName = `${pascal}FilterFields`;
  const typeArgs = hasTypes ? `${fieldsTypeName}, ${typesTypeName}` : fieldsTypeName;

  const lines: string[] = [];

  if (options.banner ?? true) {
    lines.push(
      '// Code generated by @adonis-agora/filter. DO NOT EDIT.',
      `// Source: filter spec "${options.name}".`,
      '',
    );
  }

  lines.push(
    `import { filterQueryTyped as _filterQueryTyped } from '${clientModule}';`,
    '',
    `/** Filterable field paths for \`${options.name}\` — the client's field-name allow-list. */`,
    `export type ${fieldsTypeName} = ${fieldsUnion};`,
    '',
  );

  if (hasTypes) {
    lines.push(`/** Per-field value types for \`${options.name}\` (drives operator narrowing). */`);
    lines.push(`export interface ${typesTypeName} {`);
    for (const [field, info] of Object.entries(fieldTypes)) {
      let ts = fieldTypeToTs(info);
      if (info.nullable) ts = `${ts} | null`;
      lines.push(`  ${JSON.stringify(field)}: ${ts};`);
    }
    lines.push('}', '');
  }

  const typesMeta = hasTypes
    ? `{ ${Object.entries(fieldTypes)
        .map(([field, info]) => `${JSON.stringify(field)}: ${JSON.stringify(metaKind(info))}`)
        .join(', ')} }`
    : '{}';

  lines.push(
    `/** Runtime filter metadata for \`${options.name}\`. */`,
    `export const ${camel}FilterMeta = {`,
    `  fields: [${fields.map((f) => JSON.stringify(f)).join(', ')}],`,
    `  sortable: [${sortable.map((f) => JSON.stringify(f)).join(', ')}],`,
    `  searchable: [${spec.searchable.map((f) => JSON.stringify(f)).join(', ')}],`,
    `  relations: [${relations.map((r) => JSON.stringify(r)).join(', ')}],`,
    `  types: ${typesMeta},`,
    `  defaultSort: [${spec.defaultSort
      .map(
        (s) => `{ field: ${JSON.stringify(s.field)}, direction: ${JSON.stringify(s.direction)} }`,
      )
      .join(', ')}],`,
    `  cursorKeyset: [${cursorKeyset.map((f) => JSON.stringify(f)).join(', ')}],`,
    `  defaultSize: ${spec.defaultSize ?? 'undefined'},`,
    `  maxSize: ${spec.maxSize ?? 'undefined'},`,
    '} as const;',
    '',
    `/** A type-safe filter-query builder scoped to \`${options.name}\`'s filterable fields. */`,
    `export function ${camel}FilterQuery() {`,
    `  return _filterQueryTyped<${typeArgs}>();`,
    '}',
    '',
  );

  return lines.join('\n');
}

/**
 * One entry in a {@link FilterClientManifest}: a declared spec plus the optional
 * type info / codegen overrides the emitter needs. This is what an app exports
 * from `config/filter.ts` (as `filters`) for the `make:filter-client` command to
 * consume — the specs are already `defineFilter(...)` results, so no reflection.
 */
export interface FilterClientEntry {
  /** The `defineFilter(...)` result to generate a client for. */
  spec: FilterSpec;
  /** Per-field value types (see {@link GenerateFilterClientOptions.fieldTypes}). */
  fieldTypes?: Record<string, FilterFieldTypeInfo>;
  /** Override the client import specifier for this entry. */
  clientModule?: string;
  /** Override the relation-path depth cap for this entry. */
  maxDepth?: number;
}

/** A map of client name → declared spec, keyed by the emitted client's base name. */
export type FilterClientManifest = Record<string, FilterClientEntry>;

/** A single generated client: its name, its AdonisJS-conventional file name, and its code. */
export interface GeneratedFilterClient {
  name: string;
  /** `snake_case`d file name, e.g. `blog_post_filter_client.ts`. */
  filename: string;
  code: string;
}

/**
 * Expand a whole {@link FilterClientManifest} into per-spec generated modules —
 * the pure core the `make:filter-client` ace command writes to disk. Kept pure
 * (manifest in, modules out) so the command stays a thin IO wrapper and the
 * expansion is itself testable without a running app.
 */
export function generateFilterClients(manifest: FilterClientManifest): GeneratedFilterClient[] {
  return Object.entries(manifest).map(([name, entry]) => ({
    name,
    filename: `${toSnakeCase(name)}_filter_client.ts`,
    code: generateFilterClient(entry.spec, {
      name,
      ...(entry.fieldTypes && { fieldTypes: entry.fieldTypes }),
      ...(entry.clientModule && { clientModule: entry.clientModule }),
      ...(entry.maxDepth !== undefined && { maxDepth: entry.maxDepth }),
    }),
  }));
}
