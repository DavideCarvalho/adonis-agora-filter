# `@adonis-agora/filter`

Server-side query filtering, sorting, and pagination for AdonisJS. Parses the
Spatie/JSON:API query the `@adonis-agora/filter-client` builder emits, applies it to a
Lucid query through a field allow-list, and resolves offset or keyset (cursor)
pagination.

```ts
import { parseFilterRequest, applyFilter } from '@adonis-agora/filter'

const input = parseFilterRequest(ctx.request.qs())
const query = User.query()
const { page, size } = applyFilter(query, input, {
  allowed: ['name', 'email', 'age'],
  searchable: ['name', 'email'],
})
return query.paginate(page, size)
```

### Chainable macros (optional)

Register the `FilterProvider` to get the method-call form of
`applyFilterFromRequest` on any Lucid query builder — the same operation, but
chainable:

```ts
// adonisrc.ts → providers
() => import('@adonis-agora/filter/filter_provider')
```

```ts
// filter + sort + search, then keep chaining:
const rows = await User.query()
  .where('tenantId', tenant.id)
  .applyFilterFromRequest(userFilter, ctx)
  .orderBy('createdAt', 'desc')

// filter + paginate in one terminal call (returns Lucid's paginator):
const page = await User.query().filterPaginate(userFilter, ctx)
```

`applyFilterFromRequest` returns the query (pagination resolved but not applied);
`filterPaginate` applies `paginate(page, size)` with the resolved values. The free
functions work without the provider — the macros only add the chainable sugar, so
`@adonisjs/lucid` stays an optional peer.

Operators: equals/notEquals, contains/iContains/startsWith/endsWith, gt/gte/lt/lte,
between/notBetween, in/notIn/isAnyOf, isNull/isNotNull/isEmpty/isNotEmpty, plus
AND/OR composition. The `allowed`/`sortable`/`searchable` lists are the security
boundary. The Lucid binding is structural (`QueryBuilderLike`) so any Lucid query
builder works and the adapter is unit-testable.

See the [repository README](https://github.com/DavideCarvalho/adonis-filter).

## License

MIT © Davi Carvalho
