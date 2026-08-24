---
name: filter-querying
description: >
  Advanced querying with @adonis-agora/filter beyond basic offset filtering —
  keyset/cursor pagination (applyCursor, applyCursorFromRequest, buildCursorPage,
  buildKeyset, opaque base64url encodeCursor/decodeCursor, after/before/first/last
  params), the three search modes (searchable ILIKE scan vs fullText tsvector
  websearch_to_tsquery/ts_rank vs vectorSimilarity pgvector distance metrics
  cosine/l2/innerProduct with threshold/topK), DISTINCT projections and their
  root-table-column restriction, and the richer request surface (parseSpatieRequest
  with include/sparse fieldsets/cursor params, resolveInputFromRequest sources,
  normalizeInput key casing). Use when serving stable deep pages, ranking by
  relevance or embeddings, projecting distinct column values, or accepting
  filters from a POST body.
metadata:
  type: core
  library: "@adonis-agora/filter"
  library_version: "0.7.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-filter:docs/pagination/index.mdx"
  - "DavideCarvalho/adonis-filter:docs/search/index.mdx"
  - "DavideCarvalho/adonis-filter:docs/search/full-text.mdx"
  - "DavideCarvalho/adonis-filter:docs/search/vector-similarity.mdx"
  - "DavideCarvalho/adonis-filter:docs/guides/lucid.mdx"
  - "DavideCarvalho/adonis-filter:docs/definitions/request-input.mdx"
---

# Structured querying: cursors, search modes, distinct

Offset pagination (`applyFilter` → `page`/`size`) drifts as rows are inserted
and gets slow on deep pages. Keyset pagination seeks from a boundary row; text
`search` routes through one of two engines you pick per policy; `distinct`
projects the values that exist under the current filters.

## Setup

```typescript
// app/controllers/users_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { applyCursorFromRequest, buildCursorPage } from '@adonis-agora/filter'
import { userFilter } from '#filters/user_filter'
import User from '#models/user'

export default class UsersController {
  async index(ctx: HttpContext) {
    const query = User.query()

    // same spec as offset flow; cursor params instead of page/size
    const resolved = applyCursorFromRequest(query, userFilter, ctx, { primaryKey: 'id' })

    const rows = await query.exec()
    const page = buildCursorPage(rows.map((r) => r.serialize()), resolved)

    return {
      data: page.items,
      nextCursor: page.nextCursor,
      prevCursor: page.prevCursor,
      hasNext: page.hasNext,
      hasPrev: page.hasPrev,
    }
  }
}
```

Cursor params arrive as `after`/`before`/`first`/`last` (or JSON:API
`page[after]`…). `after` wins if both bounds are sent. Filters, search, and sort
pass through the same allow-list boundary as `applyFilter`.

## Core patterns

### 1. Keyset building blocks

The effective sort plus a primary-key tiebreaker forms the keyset; the query is
limited to `size + 1` so `buildCursorPage` can detect a next page:

```typescript
import { applyCursor, buildCursorPage } from '@adonis-agora/filter'

const resolved = applyCursor(
  User.query(),
  { sort: [{ field: 'name', direction: 'asc' }], after: cursor, first: 20 },
  { allowed: ['name'], primaryKey: 'id' },
)

const rows = await query.exec()
const page = buildCursorPage(rows.map((r) => r.serialize()), resolved)
```

A malformed cursor is ignored, not fatal. Backward paging (`before`) reverses
the walk internally and `buildCursorPage` restores your requested order;
`prevCursor` from a forward page is a valid `before`.

Source: `docs/pagination/index.mdx`

### 2. Full-text search (keywords) via fullText

When the policy declares `fullText`, the request `search` term routes through
Postgres tsvector matching instead of ILIKE:

```typescript
import { defineFilter } from '@adonis-agora/filter'

export const articleFilter = defineFilter({
  filterable: ['status'],
  fullText: {
    column: 'search_vector', // stored, GIN-indexed tsvector column
    columnKind: 'tsvector',
    language: 'english',
    rank: true, // ORDER BY ts_rank(...) DESC
  },
})
```

`?search=quick brown fox` becomes
`WHERE "search_vector" @@ websearch_to_tsquery('english', ?)` — raw user input
is safe because `websearch_to_tsquery` tolerates stray punctuation and the term
always travels bound. Plain text columns work too (`columnKind: 'text'`),
wrapped in `to_tsvector` at query time. `applyFullTextSearch` is exported for
direct use outside the runner.

Source: `docs/search/full-text.mdx`

### 3. Vector similarity (embeddings) via vectorSimilarity

Rank rows nearest-first by pgvector distance to a query embedding — supplied in
code, never through the URL:

```typescript
export const docFilter = defineFilter({
  filterable: ['status'],
  vectorSimilarity: { column: 'embedding', metric: 'cosine', threshold: 0.25, topK: 20 },
})

// controller — compute the embedding, then pass it in options:
const embedding = await embeddingService.embed(q)
const { page, size } = applyFilterFromRequest(query, docFilter, ctx, {
  vectorSimilarity: embedding,
})
```

Similarity ordering lands before user sort (sort becomes the tiebreaker) and
runs only when both policy and request carry an embedding. The embedding binds
as `?::vector`; NaN/Infinity components throw rather than emitting bad SQL.
`applyVectorSimilarity` is exported for direct use.

Source: `docs/search/vector-similarity.mdx`

### 4. DISTINCT projections come free on the wire format

`?distinct=status` parses into `input.distinct`, is allow-listed like any
field, and applies itself:

```typescript
const input = parseFilterRequest(request.qs())
applyFilter(query, input, { allowed: ['status', 'baseId'] })
const rows = await query.select('status') // DISTINCT already applied
```

### 5. Richer request shapes

```typescript
import {
  parseSpatieRequest,
  resolveInputFromRequest,
  normalizeInput,
} from '@adonis-agora/filter'

// Spatie/JSON:API superset: includes, sparse fieldsets, cursor page params
const input = parseSpatieRequest(request.qs())

// source filters from body (POST /search), auto-merging query+body on writes
const raw = resolveInputFromRequest(request, 'auto')

// snake_case API → camelCase columns (top-level keys only)
normalizeInput({ company_id: 5 }, { normalizer: 'camelCase' })
```

Source: `docs/definitions/request-input.mdx`

## Common mistakes

### [HIGH] Passing model instances to buildCursorPage

Wrong:

```typescript
const rows = await query.exec()
const page = buildCursorPage(rows, resolved) // Lucid model instances
```

Correct:

```typescript
const rows = await query.exec()
const page = buildCursorPage(rows.map((r) => r.serialize()), resolved)
```

`buildCursorPage` reads keyset values off plain objects by field name; model
instances do not expose those plain keys, so boundary cursors encode garbage
and the next page silently starts from the wrong row.

Source: docs/pagination/index.mdx ("Feed buildCursorPage plain rows")

### [HIGH] Projecting distinct on a relation path

Wrong:

```typescript
applyFilter(User.query(), input, { allowed: ['status', 'posts.title'] })
// ?distinct=posts.title → dropped / InvalidColumnFilterError under throwOnInvalid
```

Correct:

```typescript
// distinct only names root-table columns: ?distinct=status
applyFilter(User.query(), input, { allowed: ['status'] })
```

Relation filtering compiles to correlated EXISTS subqueries, so the relation is
never joined and there is no alias to project from — the emitted SQL would be a
missing-FROM error at the database. Adding the path to allow-lists cannot
change this; it is structural, not a policy decision.

Source: docs/guides/lucid.mdx ("distinct takes root-table columns only")

### [HIGH] Expecting include/select to be applied

Wrong:

```typescript
const input = parseSpatieRequest(request.qs())
applyFilter(query, input, { allowed: ['name'] })
return query.paginate(1, 25) // ?include=posts ignored — posts never loaded
```

Correct:

```typescript
const input = parseSpatieRequest(request.qs())
applyFilter(query, input, { allowed: ['name'] })
for (const relation of input.include ?? []) {
  if (PRELOADABLE.includes(relation)) query.preload(relation as any)
}
return query.paginate(1, 25)
```

`include` and sparse fieldset `select` are parsed but deliberately applied by no
runner — eager-loading which relations are safe stays your validated decision.
The client builder's `.include(...)` is likewise only a request.

Source: docs/guides/client.mdx ("include is a request, not an action"); docs/definitions/request-input.mdx

### [HIGH] Confusing full-text search with vector similarity

Wrong:

```typescript
defineFilter({ fullText: { column: 'embedding' } }) // tsvector @@ against a vector column
```

Correct:

```typescript
defineFilter({
  vectorSimilarity: { column: 'embedding', metric: 'cosine' }, // embeddings rank nearest-first
  // fullText: { column: 'search_vector' },                    // keywords match lexemes
})
```

Full-text matches words against a tsvector document; vector similarity ranks by
embedding distance. Configuring one while sending the other's input yields
silently wrong search semantics. They are additive — filter by keywords, rank
by embedding.

Source: docs/search/index.mdx ("Full-text search ≠ vector similarity")

### [MEDIUM] Trusting paginate() totals alongside distinct

Wrong:

```typescript
const result = await query.distinct('status').paginate(page, size)
result.totalCount // counts UN-deduped rows
```

Correct:

```typescript
// run your own countDistinct when the total must match the deduped page
```

Lucid's count leg rebuilds the SELECT, so the reported total counts un-deduped
rows while the page itself is deduped.

Source: docs/guides/lucid.mdx (distinct/paginate total callout)

### [MEDIUM] Wrapping large text columns in query-time to_tsvector

Wrong:

```typescript
fullText: { column: ['title', 'body'], columnKind: 'text' } // re-tokenizes every row
```

Correct:

```typescript
fullText: { column: 'search_vector', columnKind: 'tsvector' } // GIN-indexable
```

Query-time `to_tsvector` cannot use an index — fine for small tables, a
sequential scan on anything big.

Source: docs/search/full-text.mdx (text-columns warning)

See also: `../filter-definitions/SKILL.md` (where fullText/vectorSimilarity are
declared), `../filter-safety/SKILL.md` (the allow-list these paths respect).
