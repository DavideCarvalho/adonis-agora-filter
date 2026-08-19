# `@adonis-agora/filter`

> Query filtering, sorting, and pagination for **AdonisJS** — Spatie/JSON:API
> style. Part of the [Agora](https://github.com/DavideCarvalho) ecosystem.

## Packages

| Package | What |
|---|---|
| [`@adonis-agora/filter`](./packages/core) | server-side: parse request → apply to a Lucid query under a field allow-list, resolve pagination |
| [`@adonis-agora/filter-client`](./packages/client) | framework-agnostic client query builder (+ TanStack Table sync) |

```ts
// client
import { filterQuery } from '@adonis-agora/filter-client'
const qs = filterQuery().where('age', 'gte', 18).sort('createdAt', 'desc').toQueryString()

// server (AdonisJS controller)
import { parseFilterRequest, applyFilter } from '@adonis-agora/filter'
const input = parseFilterRequest(ctx.request.qs())
const query = User.query()
const { page, size } = applyFilter(query, input, { allowed: ['age', 'createdAt'] })
return query.paginate(page, size)
```

The server core covers column operators, AND/OR, sort, ILIKE search, offset
pagination, and field allow-listing. The advanced surfaces from the NestJS
original have **shipped**: relation filtering with a depth cap, cursor (keyset)
pagination, `computed`/virtual fields, to-many aggregates (`$count`/`$sum`/…),
`distinct` projection, Postgres tsvector full-text search, and pgvector
embedding-similarity ordering. There is also a declarative `defineFilter` spec
(tenant scope, default filters/sort, field aliases, server-side value coercion),
an optional provider registering chainable Lucid macros (`applyFilterFromRequest`
/ `filterPaginate`), and a `make:filter-client` codegen. Everything is built on
the structural `QueryBuilderLike` adapter, so Lucid stays a peer, not a hard
dependency.

See the [documentation](./docs) for the full surface.

## License

MIT © Davi Carvalho
