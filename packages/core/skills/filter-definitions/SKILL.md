---
name: filter-definitions
description: >
  Declare reusable FilterSpec policies with defineFilter from @adonis-agora/filter.
  Covers the full options map — filterable (array, '*', or colocated kind map),
  sortable/searchable defaults, relations whitelists translating dotted paths
  into Lucid whereHas subqueries with maxDepth caps, aliases remapping client
  names to real targets (one hop, cycle-free), computed virtual columns
  (string vs correlated-subquery function forms, table/model requirement),
  to-many aggregates ($count/$sum/$avg/$min/$max unlocked via model +
  RelationSpec.aggregates), fieldTypes value coercion and the colocated
  filterable map form, tenant scope, defaultFilters/defaultSort/defaultSize/
  maxSize, throwOnInvalid, FilterDefinitionError at wiring time, specToFilterConfig,
  and resolveFieldAlias/remap* helpers. Use when authoring a filter policy,
  exposing relation/computed/aggregate fields, or renaming public field names.
metadata:
  type: core
  library: "@adonis-agora/filter"
  library_version: "0.7.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-filter:docs/definitions/index.mdx"
  - "DavideCarvalho/adonis-filter:docs/definitions/relations.mdx"
  - "DavideCarvalho/adonis-filter:docs/definitions/computed.mdx"
  - "DavideCarvalho/adonis-filter:docs/definitions/aggregates.mdx"
  - "DavideCarvalho/adonis-filter:docs/definitions/aliases.mdx"
---

# Filter definitions: declare the policy once with defineFilter

A `FilterSpec` is a plain, framework-free object built once at module scope by
`defineFilter`. It captures what is filterable/sortable, which relations are
reachable, tenant scoping, and server-side defaults — then
`applyFilterFromRequest(query, spec, ctx)` applies it on every request. The same
object also drives client codegen (`generateFilterClient`).

## Setup

```typescript
// app/filters/user_filter.ts
import type { HttpContext } from '@adonisjs/core/http'
import { defineFilter } from '@adonis-agora/filter'
import User from '#models/user'

export const userFilter = defineFilter({
  filterable: ['name', 'email', 'age', 'status'],
  sortable: ['name', 'createdAt'],
  searchable: ['name', 'email'],

  relations: {
    posts: {
      filterable: ['title', 'status'],
      sortable: ['createdAt'],
      relations: { comments: { filterable: ['body'] } }, // posts.comments.body
    },
  },

  tenant: {
    column: 'tenantId',
    resolve: (ctx) => (ctx as HttpContext).auth.user!.tenantId,
  },

  defaultFilters: [{ field: 'deletedAt', operator: 'isNull' }],
  defaultSort: [{ field: 'createdAt', direction: 'desc' }],
  defaultSize: 25,
  maxSize: 100,
})
```

Apply it in the controller:

```typescript
import { applyFilterFromRequest } from '@adonis-agora/filter'
import { userFilter } from '#filters/user_filter'
import User from '#models/user'

export default class UsersController {
  async index(ctx: HttpContext) {
    const query = User.query()
    const { page, size } = applyFilterFromRequest(query, userFilter, ctx)
    return query.paginate(page, size)
  }
}
```

`defineFilter` validates the declaration itself: a missing `filterable` or a
negative/non-integer `maxDepth` throws `FilterDefinitionError` at wiring time —
distinct from request-time `InvalidColumnFilterError`.

## Core patterns

### 1. Relations — dotted request paths become whereHas subqueries

Declare each relation by its model name; columns stay bare. Every dotted path
segment but the last is a relation hop, translated into nested
`whereHas` subqueries — no manual join:

```
?filter[posts.title]=Release
→ whereHas('posts', (sub) => sub.where('title', 'Release'))
```

`maxDepth` bounds hops (base column = 0) and defaults to your deepest declared
nesting; an explicit smaller value caps paths even when deeper ones exist.
Relation sorting forwards through the sort stage, but ordering across a to-many
relation may need joins/aggregation — prefer relation filters, and sort by
aggregate aliases (`withCount`'s `posts_count`) where possible.

Source: `docs/definitions/relations.mdx`, `docs/guides/relations.mdx`

### 2. Computed fields — virtual columns backed by your SQL

String sources inline verbatim; function sources receive `{ alias }` (the root
table name) for correlated subqueries. A declared alias is filterable and
sortable like any column, and its *declaration* is its allow-list — never add
it to `filterable`:

```typescript
export const userFilter = defineFilter({
  filterable: ['status'],
  model: User, // supplies table: 'users' — required for the function form
  computed: {
    fullName: "first_name || ' ' || last_name",
    postCount: ({ alias }) =>
      `(SELECT COUNT(*) FROM posts WHERE posts.author_id = ${alias}.id)`,
  },
})
```

Client values always ride as positional bindings; only dev-authored SQL is
inlined. Keep computed conditions at top level — see mistakes below.

Source: `docs/definitions/computed.mdx`

### 3. To-many aggregates — `$count` / `$sum` / `$avg` / `$min` / `$max`

Aggregates are auto-generated computed fields, off until the spec can
introspect relations: pass `model` plus a `relations` entry naming the to-many
relations; column functions additionally require those child columns listed
under `aggregates` (you assert numericness — Lucid does not reflect SQL types):

```typescript
export const userFilter = defineFilter({
  filterable: ['status'],
  model: User,
  relations: {
    posts: { filterable: ['status'], aggregates: ['views'] },
  },
})
```

This makes `posts.$count` plus `posts.$sum.views` / `$avg` / `$min` / `$max`
filterable and sortable. Discovery degrades gracefully — no introspection means
no aggregates, never a wiring-time throw. Each aggregate is a correlated
subquery evaluated per row; index the child FK (or materialise a counter) on
hot paths.

Source: `docs/definitions/aggregates.mdx`

### 4. Aliases and field types

Aliases remap a public name onto a whitelisted target (base column or relation
path); resolution runs before allow-listing, exactly one hop:

```typescript
export const userFilter = defineFilter({
  filterable: ['status', 'name'],
  relations: { posts: { filterable: ['title'] } },
  aliases: {
    legacyStatus: 'status',
    postTitle: 'posts.title',
  },
  fieldTypes: { age: { kind: 'number' } },
})
```

Prefer the colocated map form when several fields have non-string kinds —
`filterable: { advisorId: 'string', dayOfWeek: 'number', isRecurring: 'boolean' }`
desugars into the array plus `fieldTypes`. An explicit `fieldTypes` entry still
wins per field, which is how you add codegen-only richness (`enumValues`,
`typeRef`).

Source: `docs/definitions/aliases.mdx`, `docs/definitions/index.mdx`

### 5. Reuse the spec outside HTTP

`specToFilterConfig(spec)` projects the spec onto the per-call `FilterConfig`;
pass pre-parsed input via `options.input` for jobs/tests;
`resolveFieldAlias` / `remapFilterAliases` / `remapSortAliases` are exported
for custom pipelines:

```typescript
import { applyFilterFromRequest } from '@adonis-agora/filter'

applyFilterFromRequest(query, userFilter, ctx, {
  input: { filters: [{ field: 'status', operator: 'equals', value: 'active' }] },
})
```

Source: `docs/definitions/index.mdx` (Under the hood)

## Common mistakes

### [HIGH] Declaring aggregate paths without the owning `model`

Wrong:

```typescript
defineFilter({
  filterable: ['status'],
  relations: { posts: { filterable: ['title'], aggregates: ['views'] } },
}) // posts.$count etc. simply don't exist — referencing requests get pruned
```

Correct:

```typescript
defineFilter({
  filterable: ['status'],
  model: User,
  relations: { posts: { filterable: ['title'], aggregates: ['views'] } },
})
```

Aggregates activate only when the spec can read relation metadata off the model
— without `model`, nothing is synthesised and no error points at the cause.

Source: docs/definitions/aggregates.mdx ("Unlocking aggregates — the model option")

### [HIGH] Function-form computed fields without a root table

Wrong:

```typescript
defineFilter({
  filterable: ['status'],
  computed: { postCount: ({ alias }) => `(SELECT COUNT(*) FROM posts WHERE posts.author_id = ${alias}.id)` },
}) // alias resolves to '' → malformed SQL
```

Correct:

```typescript
defineFilter({
  filterable: ['status'],
  model: User, // or table: 'users'
  computed: { postCount: ({ alias }) => `(SELECT COUNT(*) FROM posts WHERE posts.author_id = ${alias}.id)` },
})
```

Correlated subqueries splice `spec.table` as the outer alias; with neither
`table` nor `model` set, the alias is an empty string and the SQL breaks at the
database.

Source: docs/definitions/computed.mdx ("table is required for the function form")

### [HIGH] Reading a dotted alias target as a JSON path

Wrong:

```typescript
aliases: { tier: 'metadata.tier' }
// → whereHas('metadata') — looks for a RELATION named metadata, fails at the DB
```

Correct:

```typescript
computed: { tier: "metadata->>'tier'" } // JSON access needs computed SQL you write
```

In alias targets everything before the last dot is a relation hop; there is no
JSON-path reading, and adding the path to `relations` will not make it one.

Source: docs/definitions/aliases.mdx ("A dot in the target means a relation, not a JSON path")

### [MEDIUM] Nesting computed aliases inside AND/OR groups

Wrong:

```
filter[OR][0][postCount][gte]=5   // treated as a normal column → dropped
```

Correct:

```
filter[postCount][gte]=5          // keep computed conditions top-level
```

Computed filtering is recognized only on top-level leaf filters; inside a
group the alias falls back to the column pipeline and vanishes unless it is
also a real column.

Source: docs/definitions/computed.mdx ("How a computed filter is routed")

### [MEDIUM] Chaining aliases expecting multi-hop resolution

Wrong:

```typescript
resolveFieldAlias({ a: 'b', b: 'c' }, 'a') // expecting 'c' — actually returns 'b'
```

Correct:

```typescript
resolveFieldAlias({ a: 'c', b: 'c' }, 'a') // point aliases directly at real targets
```

Resolution runs exactly one hop and never re-runs the target through the map,
which makes cycles structurally impossible — and multi-hop chains silently
resolve short.

Source: docs/definitions/aliases.mdx ("No cascading, no cycles")

### [MEDIUM] Expecting date-coerced values back as Date objects

Wrong:

```typescript
// fieldTypes: { bornOn: { kind: 'date' } } — then expecting value instanceof Date downstream
```

Correct:

```typescript
// the bound value stays the validated ISO string ('2026-07-15'); the driver parses it
```

A `date` kind validates syntax but hands the string back verbatim — re-zoning
it to midnight UTC would shift days for negative-offset clients.

Source: docs/definitions/index.mdx (coercion rules)

See also: `../filter-codegen/SKILL.md` (the same spec generates the typed
client), `../filter-safety/SKILL.md` (the boundary these declarations enforce).
