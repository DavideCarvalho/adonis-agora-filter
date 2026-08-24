---
name: filter-codegen
description: >
  Generate a typed @adonis-agora/filter-client builder from a defineFilter spec
  in @adonis-agora/filter — generateFilterClient(spec, options) pure string
  transform, generateFilterClients(manifest), the make:filter-client ace command
  with a FilterClientManifest in config/filter.ts, emitted artifacts
  (<Name>FilterFields union, <Name>FilterFieldTypes interface,
  <Name>FilterFieldMeta, <Name>FilterQuery factory), fieldTypes operator
  narrowing (kind | enumValues | typeRef | nullable), maxDepth/banner/clientModule
  options, filterableFieldPaths/sortableFieldPaths enumerators, and adonisrc.ts
  commands-barrel registration. Use when sharing one field allow-list between
  browser and server, regenerating clients after spec changes, or emitting
  enum-aware typed builders.
metadata:
  type: core
  library: "@adonis-agora/filter"
  library_version: "0.7.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-filter:docs/codegen/index.mdx"
  - "DavideCarvalho/adonis-filter:docs/definitions/index.mdx"
---

# Client codegen: one spec, both ends of the wire

A `defineFilter` spec already knows which fields are filterable. Codegen turns
that spec into a typed front-end module — a `filterQueryTyped<Fields, FieldTypes>()`
builder scoped to the spec's fields — so browser and server share one
field-name allow-list, checked at compile time. Generation is a pure function
of the spec: string in, string out, no AST walk, no reflection.

## Setup

Register the command barrel, declare a manifest, run the command:

```typescript
// adonisrc.ts
{
  commands: [
    // ...
    () => import('@adonis-agora/filter/commands'),
  ],
}
```

```typescript
// config/filter.ts
import { defineFilter } from '@adonis-agora/filter'
import type { FilterClientManifest } from '@adonis-agora/filter'

export const filters: FilterClientManifest = {
  people: {
    spec: defineFilter({
      filterable: ['age', 'name', 'status'],
      sortable: ['age', 'name'],
      searchable: ['name'],
      relations: { posts: { filterable: ['title', 'published'] } },
      defaultSort: [{ field: 'name', direction: 'asc' }],
      defaultSize: 25,
      maxSize: 100,
    }),
    fieldTypes: { age: { kind: 'number' }, status: { enumValues: ['active', 'inactive'] } },
  },
}
```

```bash
node ace make:filter-client
# create app/generated/filters/people_filter_client.ts
```

Defaults: entrypoint `config/filter.js`, output `app/generated/filters`. Pass
an explicit entrypoint/dir with
`node ace make:filter-client config/filter.js --output app/generated/filters`.

## Core patterns

### 1. The pure core — generateFilterClient

Skip the command entirely when you want to own the IO:

```typescript
import { defineFilter, generateFilterClient } from '@adonis-agora/filter'

const spec = defineFilter({
  filterable: ['age', 'name', 'status'],
  sortable: ['age', 'name'],
})

const code = generateFilterClient(spec, {
  name: 'people',
  fieldTypes: { age: { kind: 'number' }, status: { enumValues: ['active', 'inactive'] } },
})
// code is a TypeScript module string — write it wherever you like
```

For `name: 'people'` the module exports: `type PeopleFilterFields` (union of
filterable paths — base plus relation-dotted), `interface PeopleFilterFieldTypes`
(only when `fieldTypes` supplied), `const peopleFilterMeta` (runtime metadata),
and `function peopleFilterQuery()` (a `filterQueryTyped` factory).

Options: `clientModule` (import specifier, default `@adonis-agora/filter-client`),
`maxDepth` (relation-path cap, defaults to `spec.maxDepth`), `banner`
(the DO NOT EDIT header, default `true`).

Source: `docs/codegen/index.mdx`

### 2. Consume the generated client

Import the generated factory and get field-name-checked, operator-narrowed
queries:

```typescript
// web/people-table.ts
import { peopleFilterQuery } from '#generated/filters/people_filter_client'

const qs = peopleFilterQuery()
  .contains('name', 'Al')   // 'name' checked against PeopleFilterFields
  .gte('age', 18)           // number ops via fieldTypes narrowing
  .toQueryString()

await fetch(`/people?${qs}`)
```

Source: `docs/codegen/index.mdx`

### 3. fieldTypes drives operator narrowing

The spec carries the allow-list but not column value types (Lucid models are
not reflected). Supply kinds per field path to unlock type-aware narrowing:

| `FilterFieldTypeInfo` | Emits |
|---|---|
| `{ kind: 'string' \| 'number' \| 'boolean' \| 'date' \| 'json' }` | matching TS type |
| `{ enumValues: ['A', 'B'] }` | union `"A" \| "B"` (wins over `kind`) |
| `{ typeRef: 'Role' }` | named type verbatim (wins over everything) |
| `{ nullable: true }` | appends `\| null` |

Without `fieldTypes` the client stays field-name-safe but operator-permissive.
On the server side the same declaration powers value coercion — one
declaration, both ends.

Source: `docs/codegen/index.mdx`, `docs/definitions/index.mdx`

### 4. Just enumerate the paths

`filterableFieldPaths(spec)` / `sortableFieldPaths(spec)` export the enumerated
field-path lists if you're building your own artifact:

```typescript
import { filterableFieldPaths } from '@adonis-agora/filter'

const paths = filterableFieldPaths(peopleSpec)
// ['age', 'name', 'status', 'posts.title', 'posts.published']
```

Source: `docs/codegen/index.mdx`

## Common mistakes

### [HIGH] Running make:filter-client with the commands barrel unregistered

Wrong:

```typescript
// adonisrc.ts — no filter commands entry
{ commands: [] }
```

Correct:

```typescript
{ commands: [() => import('@adonis-agora/filter/commands')] }
```

Ace only sees commands an app opts into; without the barrel the command fails
with "command not found", which reads as though it does not exist.
`node ace add @adonis-agora/filter` adds the entry for you.

Source: docs/codegen/index.mdx (Step 1 callout)

### [HIGH] Hand-editing generated clients instead of regenerating

Wrong:

```typescript
// renamed a spec field, then edited people_filter_client.ts by hand
```

Correct:

```bash
node ace make:filter-client # regenerate after every spec change
```

Generated modules carry a DO NOT EDIT banner and are a pure function of the
spec; a stale client keeps sending fields the server now drops, so filters
silently stop applying with no error on either end.

Source: docs/codegen/index.mdx (banner option, Step 4)

### [MEDIUM] Expecting codegen unions from a '*' allow-list

Wrong:

```typescript
defineFilter({ filterable: ['*'] }) // PeopleFilterFields falls back to string
```

Correct:

```typescript
defineFilter({ filterable: ['age', 'name', 'status'] }) // enumerable literal union
```

A star list cannot be enumerated, so the emitter degrades to a permissive
string union — the generated client looks typed but checks nothing.

Source: docs/codegen/index.mdx (filterableFieldPaths callout)

### [MEDIUM] Skipping fieldTypes then expecting operator narrowing

Wrong:

```typescript
generateFilterClient(spec, { name: 'people' })
peopleFilterQuery().gte('name', 5) // compiles — gte gated to orderable fields only
```

Correct:

```typescript
generateFilterClient(spec, {
  name: 'people',
  fieldTypes: { age: { kind: 'number' }, status: { enumValues: ['active', 'inactive'] } },
})
```

Without a field-type map every field is kind-unknown, so all operators compile
and mismatches surface only server-side as drops or coercion errors.

Source: docs/codegen/index.mdx ("fieldTypes — unlock operator narrowing")

See also: `packages/client/skills/filter-query-builder/SKILL.md` (the runtime
the generated code targets), `../filter-definitions/SKILL.md` (spec authoring).
