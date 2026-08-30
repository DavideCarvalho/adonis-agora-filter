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

// server — app/filters/user_filter.ts
import { BaseModelFilter } from '@adonis-agora/filter'
export default class UserFilter extends BaseModelFilter {
  static filterable = ['age', 'status']
  static sortable = ['createdAt']

  setup() { this.$query.whereNull('deletedAt') }          // the scope no query string can relax
  fullName(value: string) {                               // a key with no column behind it
    this.$query.whereILike('full_name', `%${value}%`)
  }
}

// server — app/controllers/users_controller.ts
return User.filterPaginate(ctx)                            // filter + search + sort + page

// or keep the builder
const { query } = await User.filter(ctx)
query.preload('team')
return query.filterPaginate()
```

The server core covers column operators, AND/OR, sort, ILIKE search, offset
pagination, and field allow-listing. The advanced surfaces from the NestJS
original have **shipped**: relation filtering with a depth cap, cursor (keyset)
pagination, `computed`/virtual fields, to-many aggregates (`$count`/`$sum`/…),
`distinct` projection, Postgres tsvector full-text search, and pgvector
embedding-similarity ordering. A filter is authored as a **class** (`BaseModelFilter` — a method per request key,
`this.$query`, a `setup()` scope, constructor injection through the container,
`node ace make:filter`, and optional `@filterFor` / `@filterable` decorators) or as
a declarative `defineFilter` spec (tenant scope,
default filters/sort, field aliases, server-side value coercion); both compile to
the same pipeline. There is an optional provider registering chainable Lucid
macros (`applyFilterFromRequest` / `filterPaginate`), a `Filterable` model mixin,
and a `make:filter-client` codegen. Everything is built on
the structural `QueryBuilderLike` adapter, so Lucid stays a peer, not a hard
dependency.

See the [documentation](./docs) for the full surface.

## License

MIT © Davi Carvalho
