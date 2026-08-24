---
name: filter-safety
description: >
  Lock down a public @adonis-agora/filter endpoint in AdonisJS. Covers the
  allowed/sortable/searchable allow-lists as the security boundary, AllowList
  forms ('*' | string[] | predicate), throwOnInvalid + InvalidColumnFilterError
  mapped to HTTP 400, built-in structural validation (validateColumnFilters,
  MAX_FILTER_DEPTH, field charset, operator aliases), query-string value
  coercion with fieldTypes/coerceFilterValue, escapeLike for hand-built ILIKE
  patterns, the trust boundary of low-level applyColumnFilters/applySort/
  applySearch inside whereHas callbacks, layering VineJS for domain validation,
  and unit-testing allow-listing with @adonis-agora/filter/testing
  MockQueryBuilder. Use when exposing filters to untrusted clients, preventing
  arbitrary-column probing, turning silent drops into 400s, or writing filter
  unit tests.
metadata:
  type: core
  library: "@adonis-agora/filter"
  library_version: "0.7.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-filter:docs/guides/filter-classes.mdx"
  - "DavideCarvalho/adonis-filter:docs/guides/validation.mdx"
  - "DavideCarvalho/adonis-filter:docs/guides/operators.mdx"
  - "DavideCarvalho/adonis-filter:docs/testing/index.mdx"
  - "DavideCarvalho/adonis-filter:docs/guides/lucid.mdx"
---

# Filter safety: the allow-list is the security boundary

`allowed`, `sortable`, and `searchable` are not conveniences — they are the only
thing standing between a client query string and your columns. Any field a
client references outside them is pruned before it reaches Lucid. This skill
covers enforcing that boundary loudly, coercing hostile string values, and
testing it without a database.

## Setup

```typescript
// app/controllers/users_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { parseFilterRequest, applyFilter } from '@adonis-agora/filter'
import User from '#models/user'

export default class UsersController {
  async index({ request, response }: HttpContext) {
    const input = parseFilterRequest(request.qs())
    const query = User.query()

    try {
      const { page, size } = applyFilter(query, input, {
        allowed: ['name', 'email', 'status'], // explicit array — never '*' on public endpoints
        sortable: ['name', 'createdAt'],
        searchable: ['name', 'email'],
        maxSize: 100,
        throwOnInvalid: true,
      })
      return query.paginate(page, size)
    } catch (err) {
      if (err instanceof InvalidColumnFilterError) {
        return response.badRequest({ message: err.message })
      }
      throw err
    }
  }
}
```

(Import `InvalidColumnFilterError` from `@adonis-agora/filter` alongside
`parseFilterRequest` / `applyFilter`.)

## Core patterns

### 1. The AllowList has three forms

`type AllowList = '*' | string[] | ((field) => boolean)`. Prefer an explicit
array everywhere a client can reach; use the predicate form for rules a flat
list cannot express — e.g. whitelisting one hop into `posts` under a cap:

```typescript
applyFilter(query, input, {
  allowed: (field) => !field.includes('.') || /^posts\.[a-z]+$/i.test(field),
})
```

The predicate receives the already alias-resolved target, never the client-facing alias key.

Source: `docs/guides/filter-classes.mdx`

### 2. throwOnInvalid — reject instead of silently dropping

By default disallowed fields are dropped silently. With `throwOnInvalid: true`,
both structural failures and allow-list rejections surface as
`InvalidColumnFilterError`; handle it once globally instead of per controller:

```typescript
// app/exceptions/handler.ts
import { InvalidColumnFilterError } from '@adonis-agora/filter'

async handle(error: unknown, ctx: HttpContext) {
  if (error instanceof InvalidColumnFilterError) {
    return ctx.response.badRequest({ message: error.message })
  }
  return super.handle(error, ctx)
}
```

Structural validation runs on every `applyFilter`: field charset
(`^[a-zA-Z_][a-zA-Z0-9_.]*$`), known operators or SQL-symbol aliases
(normalized in place), per-operator value shapes, and `AND`/`OR` nesting capped
at `MAX_FILTER_DEPTH` (10). `validateColumnFilters` is exported to run the same
checks manually.

Source: `docs/guides/validation.mdx`

### 3. Coerce query-string values with fieldTypes

Query-string values are always strings. Declare kinds so bad values are
rejected up front (dropped, or `InvalidColumnFilterError` → 400 under
`throwOnInvalid`) instead of surfacing as Postgres cast errors:

```typescript
applyFilter(query, input, {
  allowed: ['advisorId', 'dayOfWeek', 'isRecurring'],
  fieldTypes: {
    dayOfWeek: { kind: 'number' },
    isRecurring: { kind: 'boolean' },
  },
})
```

Kinds: `'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown'`.
Coercion rules worth knowing: an empty string is not a valid number;
`null` passes every kind (legitimate `IS NULL`); a `date` string is validated
but returned verbatim.

Source: `docs/definitions/index.mdx` (Field types & value coercion)

### 4. Escape LIKE patterns you build by hand

All library string operators escape `%`, `_`, and `\` via `escapeLike()`
before building patterns. If you build an ILIKE pattern yourself (outside the
adapter), do the same:

```typescript
import { escapeLike } from '@adonis-agora/filter'

qb.whereILike('code', `${escapeLike(prefix)}%`)
```

Source: `docs/guides/operators.mdx` (Security)

### 5. Unit-test the boundary with the shipped mock

`@adonis-agora/filter/testing` exports a recording `QueryBuilderLike` stand-in,
so allow-listing is assertable with no database:

```typescript
import { test } from '@japa/runner'
import { applyFilter } from '@adonis-agora/filter'
import { makeMockQueryBuilder } from '@adonis-agora/filter/testing'

test('drops disallowed fields', ({ assert }) => {
  const qb = makeMockQueryBuilder()
  applyFilter(
    qb,
    { filters: [
      { field: 'name', operator: 'equals', value: 'Al' },
      { field: 'secret', operator: 'equals', value: 'x' },
    ] },
    { allowed: ['name'] },
  )
  const flat = qb.flatten()
  assert.deepInclude(flat, { method: 'where', args: ['name', 'Al'] })
  assert.isUndefined(flat.find((c) => c.args.includes('secret')))
})
```

Source: `docs/testing/index.mdx`, `docs/guides/testing.mdx`

## Common mistakes

### [CRITICAL] Allowing every column with `'*'`

Wrong:

```typescript
applyFilter(query, input, { allowed: '*' })
```

Correct:

```typescript
applyFilter(query, input, { allowed: ['name', 'email', 'status'] })
```

A star allow-list disables column filtering entirely — any base column
(`passwordHash`, internal flags) becomes probeable through filter values and
result counts. Reserve it for trusted internal endpoints.

Source: docs/guides/filter-classes.mdx ("The allow-list is the security boundary" warning)

### [CRITICAL] Feeding client filters to low-level apply functions unpruned

Wrong:

```typescript
const raw = parseFilterRequest(request.qs())
query.whereHas('posts', (p) => applyColumnFilters(p, raw.filters ?? []))
```

Correct:

```typescript
const raw = parseFilterRequest(request.qs())
// prune against a policy first (or validate fields yourself)…
const scratch = User.query()
applyFilter(scratch, raw, { allowed: ['title', 'status'] })
query.whereHas('posts', (p) =>
  applyColumnFilters(p, [{ field: 'title', operator: 'equals', value: 'Hi' }]),
)
```

`applyColumnFilters` / `applySort` / `applySearch` trust their input — they
enforce no allow-list — so client-derived filters handed straight to them can
reference arbitrary columns inside the subquery.

Source: docs/guides/lucid.mdx (low-level functions warning); docs/guides/relations.mdx

### [HIGH] Trusting silent-drop while debugging

Wrong:

```typescript
applyFilter(query, input, { allowed: ['name', 'createdAt'] })
// ?sort=-craetedAt does nothing, no error anywhere
```

Correct:

```typescript
try {
  const { page, size } = applyFilter(query, input, {
    allowed: ['name', 'createdAt'],
    throwOnInvalid: true,
  })
} catch (err) {
  if (err instanceof InvalidColumnFilterError) {
    return response.badRequest({ message: err.message })
  }
  throw err
}
```

With defaults, a typo'd sort or filter just vanishes and the query "works" but
ignores the client's intent — contract drift ships unnoticed.

Source: docs/guides/validation.mdx (throwOnInvalid)

### [HIGH] Assuming query-string numbers arrive as numbers

Wrong:

```typescript
// ?filter[isRecurring]=xyz → Postgres: invalid input syntax for type boolean → 500
applyFilter(query, input, { allowed: ['isRecurring'] })
```

Correct:

```typescript
applyFilter(query, input, {
  allowed: ['isRecurring'],
  fieldTypes: { isRecurring: { kind: 'boolean' } }, // rejected up front → drop or 400
})
```

Every query-string value parses as a string; SQL implicit casts hide the gap
until an uncastable value raises at the database as a user-input-driven 500.

Source: docs/definitions/index.mdx (Field types & value coercion); docs/guides/operators.mdx

### [MEDIUM] Building ILIKE patterns from unescaped user input

Wrong:

```typescript
qb.whereILike('name', `%${userInput}%`) // userInput '%%' widens the match arbitrarily
```

Correct:

```typescript
import { escapeLike } from '@adonis-agora/filter'
qb.whereILike('name', `%${escapeLike(userInput)}%`)
```

The adapter escapes `%`, `_` and `\` on every string operator it emits, but a
pattern you interpolate yourself skips that protection entirely.

Source: docs/guides/operators.mdx (Security — LIKE escaping)

See also: `../filter-querying/SKILL.md` (cursor pagination and search route
through this same boundary), `../filter-basics/SKILL.md` (endpoint wiring).
