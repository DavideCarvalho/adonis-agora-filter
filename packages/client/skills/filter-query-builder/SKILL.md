---
name: filter-query-builder
description: >
  Build filter requests in the browser/Node with @adonis-agora/filter-client —
  the zero-dependency fluent builder emitting exactly what @adonis-agora/filter
  parses. Covers filterQuery() chaining (where overloads, convenience methods
  equals/contains/in/between/gte/isNull…, accumulating add/addGte/addLte for
  ranges, remove/clear), or()/and() group callbacks, sort/sortDesc/search/
  include/distinct/set envelope keys, page() pagination, terminators
  toQueryString/build/toFlatObject, filterQueryTyped<Fields, FieldTypes>()
  compile-time field/operator/value narrowing, whereDynamic/sortDynamic runtime
  escape hatches, the reactive store contract (subscribe/getSnapshot/getVersion),
  TanStack Table sync (applyTanstackTableState, tanstackTableToFilterQuery,
  resolveOperator, fields allowlist), and exported serializers
  flatObjectToQueryString/columnFiltersToQueryString. Use when constructing
  filter requests client-side, typing queries against known fields, wiring UI
  state, or syncing TanStack Table state.
metadata:
  type: core
  library: "@adonis-agora/filter-client"
  library_version: "0.2.1"
sources:
  - "DavideCarvalho/adonis-filter:docs/guides/client.mdx"
  - "DavideCarvalho/adonis-filter:docs/getting-started.mdx"
---

# Client query builder: emit exactly what the server parses

`@adonis-agora/filter-client` is a zero-dependency builder (browser + Node).
Chain conditions on `filterQuery()` and terminate with `toQueryString()` (GET),
`build()` (POST body), or `toFlatObject()`. What it emits is what
`parseFilterRequest` reads — the round trip needs no server-side glue.

## Setup

```bash
npm install @adonis-agora/filter-client
```

```typescript
import { filterQuery } from '@adonis-agora/filter-client'

const qs = filterQuery()
  .equals('status', 'active')
  .contains('name', 'fleet')
  .gte('age', 18)
  .sort('createdAt', 'desc')
  .page(1, 25)
  .toQueryString()

await fetch(`/users?${qs}`)
```

## Core patterns

### 1. `where` replaces; convenience methods delegate; `add` accumulates

`where(field, op, value)` is explicit; `where(field, value)` auto-`equals`
scalars and auto-`in` arrays; `where(field, unaryOp)` takes no value. Every
operator has a named helper. `where` **replaces** prior conditions on the same
field; only range operators may **accumulate** via `add`:

```typescript
import { filterQuery } from '@adonis-agora/filter-client'

filterQuery()
  .equals('status', 'active')
  .notEquals('role', 'banned')
  .contains('name', 'fleet')       // whereILike-style substring on the server
  .in('id', [1, 2, 3])
  .between('age', 18, 65)
  .startsWith('code', 'AB')
  .isNull('deletedAt')
  .addGte('createdAt', '2026-01-01') // accumulate both bounds…
  .addLte('createdAt', '2026-12-31') // …on one field
  .remove('role')                    // drop all filters for `role`
  .toQueryString()
```

Values are validated against the operator at call time (`between` needs a
2-tuple, `in` an array, unary operators no value) — mismatches throw
synchronously.

Source: `docs/guides/client.mdx`

### 2. AND/OR groups and envelope keys

`.or(cb)` / `.and(cb)` receive a sub-builder whose conditions become a nested
group node. Sort, search, include, distinct, and extras fill the envelope:

```typescript
filterQuery()
  .equals('status', 'active')
  .or((q) => q.contains('name', 'sync').contains('email', 'sync'))
  .sortDesc('createdAt')
  .search('fleet')
  .include('role', 'posts') // deduped; a REQUEST the server must act on
  .distinct('status')
  .set('extraKey', 'value')
  .build()
// → { filter: { where: [..., { field: '', OR: [...] }] }, sort, search, include, distinct, extraKey }
```

Groups force `toQueryString()` into indexed `where[i][...]` notation and are
invisible to `toFlatObject()`.

Source: `docs/guides/client.mdx`

### 3. Compile-time safety with filterQueryTyped

Same builder at runtime; field names restrict to a union, and an optional
field-type map narrows operators/values per field:

```typescript
import { filterQueryTyped } from '@adonis-agora/filter-client'

type UserMap = {
  name: string
  age: number
  status: 'active' | 'inactive'
  deletedAt: Date | null
}

const q = filterQueryTyped<keyof UserMap & string, UserMap>()
  .contains('name', 'Al')     // ✅ string field
  .gte('age', 18)             // ✅ number field
  .equals('status', 'active') // ✅ enum member only
  .isNull('deletedAt')        // ✅ valid on every field
  .build()

// filterQueryTyped<keyof UserMap & string, UserMap>().contains('age', 'x')
// ❌ compile error — contains gated to string fields
```

Fields not known at compile time (AG-Grid column ids, saved views) go through
`whereDynamic` / `sortDynamic` — still operator/value-validated at runtime,
same replace semantics as `where`.

Source: `docs/guides/client.mdx`

### 4. Reactivity and TanStack Table sync

The builder is an observable store — exactly the contract
`useSyncExternalStore` needs — and an optional adapter maps vanilla TanStack
Table state onto it:

```typescript
import { useSyncExternalStore, useRef } from 'react'
import { filterQuery } from '@adonis-agora/filter-client'
import { applyTanstackTableState } from '@adonis-agora/filter-client/tanstack'

function useFilterQuery() {
  const ref = useRef(filterQuery())
  const builder = ref.current
  const snapshot = useSyncExternalStore(builder.subscribe, builder.getSnapshot)
  return [builder, snapshot] as const
}

const body = applyTanstackTableState(filterQuery(), {
  columnFilters: table.getState().columnFilters,
  sorting: table.getState().sorting,
  pagination: table.getState().pagination,
  resolveOperator: (id) => (id === 'createdAt' ? 'gte' : 'iContains'),
  fields: ['name', 'status', 'createdAt'], // optional allowlist; others dropped
}).build()
```

`resolveOperator` is the seam where column filters gain an operator (default:
array → `in`, string → `iContains`, else `equals`). One-shot variant:
`tanstackTableToFilterQuery(state)`.

Source: `docs/guides/client.mdx`

## Common mistakes

### [HIGH] Stacking range methods that overwrite each other

Wrong:

```typescript
filterQuery().gte('age', 18).lte('age', 65).toQueryString() // only lte survives
```

Correct:

```typescript
filterQuery().between('age', 18, 65).toQueryString()
// or accumulate both bounds:
filterQuery().addGte('age', 18).addLte('age', 65).toQueryString()
```

Convenience methods delegate to `where`, which replaces any existing filter for
the same field — the second bound silently erases the first.

Source: docs/guides/client.mdx ("where replaces… add accumulates")

### [HIGH] Sending the zero-based client page straight through

Wrong:

```typescript
// TanStack pageIndex 1 → server page 1 again
filterQuery().page(table.getState().pagination.pageIndex, 25).toQueryString()
```

Correct:

```typescript
// normalize at the boundary: serverPage = pageIndex + 1
.filterQuery().page(table.getState().pagination.pageIndex + 1, 25).toQueryString()
// …or read page[size]/page[number] server-side and add 1 there
```

The builder's `.page()` is 0-based (TanStack convention); `applyFilter` and
Lucid's `paginate()` resolve 1-based pages — passing the raw value serves the
previous page with no error anywhere.

Source: docs/guides/client.mdx (0-based vs 1-based warning); docs/guides/filter-classes.mdx

### [HIGH] Treating whereDynamic/type-safety as a security control

Wrong:

```typescript
// assuming fields are safe because the typed builder compiled
builder.whereDynamic(untrustedField, 'equals', value)
```

Correct:

```typescript
// keep the server allow-list authoritative; mirror it here via `fields`
applyTanstackTableState(filterQuery(), { ...state, fields: ALLOWED_FIELDS })
```

`whereDynamic`/`sortDynamic` bypass only the client compile-time union — the
server drops (or rejects) any non-whitelisted field regardless of what the
client sent.

Source: docs/guides/client.mdx ("The server allow-list is still the real boundary")

### [MEDIUM] Asserting decoded bracket notation in tests

Wrong:

```typescript
assert.equal(qs, 'filter[age][gte]=18&sort=-createdAt')
```

Correct:

```typescript
assert.equal(qs, 'filter%5Bage%5D[gte]=18&sort=-createdAt')
// or compare decodeURIComponent(qs)
```

`toQueryString()` percent-encodes field-name brackets while leaving operator
brackets literal; both spellings decode identically, but literal-string
assertions fail.

Source: docs/guides/client.mdx ("Why the output has %5B in it")

### [MEDIUM] Reading groups back through toFlatObject

Wrong:

```typescript
filterQuery().equals('a', 1).or((q) => q.contains('n', 'x')).toFlatObject()
// the OR group silently disappears
```

Correct:

```typescript
filterQuery().equals('a', 1).or((q) => q.contains('n', 'x')).toQueryString()
// falls back to indexed where[i] notation, groups intact
```

Groups have no flat representation, so `toFlatObject()` ignores them entirely —
use `build()` or `toQueryString()` whenever `.or()`/`.and()` is in play.

Source: docs/guides/client.mdx (AND/OR groups callout)

### [MEDIUM] Mutating the cached reactive snapshot

Wrong:

```typescript
const snap = builder.getSnapshot()
snap.filter.where.push(myFilter) // poisons the cached snapshot, no re-render
```

Correct:

```typescript
builder.gte('age', 18) // mutate through the builder — bumps version, notifies subscribers
```

`getSnapshot()` returns the same object reference until the next mutation
(required by `useSyncExternalStore`); mutating it corrupts that cache.

Source: docs/guides/client.mdx (Reactivity callout)

See also: `packages/core/skills/filter-codegen/SKILL.md` (generate this builder
typed from a spec), `packages/core/skills/filter-basics/SKILL.md` (the server
half of the round trip).
