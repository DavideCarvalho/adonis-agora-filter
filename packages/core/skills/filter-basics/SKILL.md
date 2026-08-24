---
name: filter-basics
description: >
  Add Spatie/JSON:API-style query filtering to an AdonisJS endpoint with
  @adonis-agora/filter. Covers parseFilterRequest(qs), applyFilter(query, input,
  { allowed, sortable, searchable }) with the returned/clamped { page, size },
  the declarative defineFilter + applyFilterFromRequest flow (tenant scope,
  defaultFilters, defaultSort, defaultSize/maxSize), the optional provider
  macros .applyFilterFromRequest() / .filterPaginate(), wire format parsing
  (filter[field][op]=value, sort=-createdAt, page/size), and input sourcing from
  query string, POST body, or a nested key. Use when building a filtered list
  endpoint, wiring a reusable filter policy, or deciding free functions vs macros.
metadata:
  type: core
  library: "@adonis-agora/filter"
  library_version: "0.7.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-filter:docs/getting-started.mdx"
  - "DavideCarvalho/adonis-filter:docs/guides/controllers.mdx"
  - "DavideCarvalho/adonis-filter:docs/guides/filter-classes.mdx"
  - "DavideCarvalho/adonis-filter:docs/guides/provider.mdx"
  - "DavideCarvalho/adonis-filter:docs/guides/operators.mdx"
---

# Filter basics: parse a request, apply it to a Lucid query

The whole server surface is two functions: `parseFilterRequest(request.qs())`
reshapes the request into a structured `FilterInput`, then
`applyFilter(query, input, config)` validates it, prunes it against an
allow-list, mutates your Lucid query in place, and returns the resolved
`{ page, size }`. No config file, no decorators; the optional service provider
only adds chainable macros.

## Setup

```bash
npm install @adonis-agora/filter
```

```typescript
// app/controllers/users_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { parseFilterRequest, applyFilter } from '@adonis-agora/filter'
import User from '#models/user'

export default class UsersController {
  async index({ request }: HttpContext) {
    const input = parseFilterRequest(request.qs())
    const query = User.query()

    const { page, size } = applyFilter(query, input, {
      allowed: ['name', 'email', 'age', 'status'],
      sortable: ['name', 'createdAt'],
      searchable: ['name', 'email'],
      defaultSize: 25,
      maxSize: 100,
    })

    return query.paginate(page, size)
  }
}
```

```typescript
// start/routes.ts
import router from '@adonisjs/core/services/router'
const UsersController = () => import('#controllers/users_controller')

router.get('/users', [UsersController, 'index'])
```

A request like
`GET /users?filter[status]=active&filter[age][gte]=18&search=fleet&sort=-createdAt&page=1&size=25`
parses, validates, prunes against the allow-list, applies WHERE/ORDER BY/ILIKE,
and returns `{ page: 1, size: 25 }` for `query.paginate()`.

## Core patterns

### 1. Two-function primitive — parse once, apply once

`parseFilterRequest` is a pure reshape (no validation, no allow-listing);
`applyFilter` owns validation and pruning. It reads any decoded object, so the
same controller serves GET query strings and structured POST bodies:

```typescript
import { parseFilterRequest, applyFilter } from '@adonis-agora/filter'

// GET — decoded query string
const input = parseFilterRequest(request.qs())

// POST /search — the body may be the flat Spatie shape or the structured
// object the client builder's .build() returns ({ filter: { where }, sort, paginate })
const bodyInput = parseFilterRequest(request.body())
```

Source: `docs/guides/controllers.mdx`, `docs/guides/operators.mdx`

### 2. Reusable policies with defineFilter + applyFilterFromRequest

When a policy spans endpoints, declare a `FilterSpec` once at module scope and
apply it in one call. Server scope (tenant + `defaultFilters`) is injected
before allow-listed request filters; `defaultSort` applies when the request has
none:

```typescript
// app/filters/user_filter.ts
import { defineFilter } from '@adonis-agora/filter'
import User from '#models/user'

export const userFilter = defineFilter({
  filterable: ['name', 'email', 'age', 'status'],
  sortable: ['name', 'createdAt'],
  searchable: ['name', 'email'],
  relations: { posts: { filterable: ['title', 'status'] } },
  tenant: { column: 'tenantId', resolve: (ctx) => (ctx as any).auth.user!.tenantId },
  defaultFilters: [{ field: 'deletedAt', operator: 'isNull' }],
  defaultSort: [{ field: 'createdAt', direction: 'desc' }],
  defaultSize: 25,
  maxSize: 100,
})
```

```typescript
// app/controllers/users_controller.ts
import { applyFilterFromRequest } from '@adonis-agora/filter'
import { userFilter } from '#filters/user_filter'
import User from '#models/user'

async index(ctx: HttpContext) {
  const query = User.query()
  const { page, size } = applyFilterFromRequest(query, userFilter, ctx)
  return query.paginate(page, size)
}
```

Source: `docs/definitions/index.mdx`

### 3. Optional macros — inline chaining

Register the provider (`node ace add @adonis-agora/filter`, or add
`() => import('@adonis-agora/filter/filter_provider')` under `providers` in
`adonisrc.ts`) and every model query gains `.applyFilterFromRequest(spec)` /
`.filterPaginate(spec)`:

```typescript
import { userFilter } from '#filters/user_filter'
import User from '#models/user'

// ctx read from AsyncLocalStorage inside a request
return User.query().where('active', true).applyFilterFromRequest(userFilter)

// filter + paginate in one terminal call
return User.query().filterPaginate(userFilter)
```

The free `applyFilterFromRequest(query, spec, ctx, options?)` always needs an
explicit `ctx` — the AsyncLocalStorage fallback exists only in the macro layer.

Source: `docs/guides/provider.mdx`

### 4. Pagination is returned, not applied

`applyFilter` resolves `size = clamp(input.size ?? defaultSize ?? 25, 1, maxSize ?? 100)`
and `page = max(1, input.page ?? 1)` but leaves execution to you — so you can
paginate, run plain `.exec()`, or layer a DISTINCT projection on the same
filtered query.

Source: `docs/getting-started.mdx`, `docs/guides/filter-classes.mdx`

## Common mistakes

### [CRITICAL] Feeding raw request page/size to paginate()

Wrong:

```typescript
const input = parseFilterRequest(request.qs())
await User.query().paginate(input.page ?? 1, input.size ?? 25)
```

Correct:

```typescript
const query = User.query()
const { page, size } = applyFilter(query, input, { allowed: ['name'], maxSize: 100 })
return query.paginate(page, size)
```

`applyFilter` clamps size into `[1, maxSize]` and floors page at 1; values taken
straight off the query string skip the clamp entirely, so `?size=500000`
executes against the database.

Source: docs/getting-started.mdx ("Why pagination is returned, not applied"); docs/guides/filter-classes.mdx (Pagination bounds)

### [HIGH] Putting the tenant column in the allow-list

Wrong:

```typescript
export const userFilter = defineFilter({
  filterable: ['name', 'tenantId'], // client can now constrain tenantId too
  tenant: { column: 'tenantId', resolve: (ctx) => ctx.tenantId },
})
```

Correct:

```typescript
export const userFilter = defineFilter({
  filterable: ['name'],
  tenant: { column: 'tenantId', resolve: (ctx) => ctx.tenantId },
})
```

The tenant scope always lands as trusted server policy; if the same column is
also client-filterable, a sent value AND-combines with it and silently returns
an empty result set. Same rule for pre-scoped queries: constrain before
`applyFilter` and leave the column out of `allowed`.

Source: docs/definitions/index.mdx ("Tenant scope is un-tamperable"); docs/guides/controllers.mdx

### [MEDIUM] Expecting `search` to work without `searchable`

Wrong:

```typescript
applyFilter(query, input, { allowed: ['name'] })
// ?search=fleet is silently skipped — no searchable columns declared
```

Correct:

```typescript
applyFilter(query, input, {
  allowed: ['name'],
  searchable: ['name', 'email'],
})
```

The free-text term only routes anywhere when `searchable` is non-empty;
otherwise it is dropped with no error and rows come back unfiltered by search.

Source: docs/guides/filter-classes.mdx ("searchable enables free-text search")

See also: `../filter-safety/SKILL.md` (tightening the boundary before exposing
the endpoint publicly), `../filter-definitions/SKILL.md` (growing the policy
into a reusable spec).
