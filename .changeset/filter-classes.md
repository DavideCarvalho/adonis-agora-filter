---
'@adonis-agora/filter': minor
---

Filter classes — the `adonis-lucid-filter` authoring shape, with the whole pipeline behind it.

A filter can now be a class:

```ts
@inject()
export default class UserFilter extends BaseModelFilter {
  declare $query: ModelQueryBuilderContract<typeof User>
  constructor(private tenants: TenantsService) { super() }

  static model = User
  static filterable = ['name', 'email', 'status']
  static sortable = ['name', 'createdAt']
  static searchable = ['name', 'email']

  setup() { this.$query.where('tenantId', this.tenants.current(this.$ctx)) }

  fullName(value: string) {
    this.$query.whereRaw("first_name || ' ' || last_name ilike ?", [`%${value}%`])
  }
}
```

- **`BaseModelFilter`** — a method per request key, the builder on `this.$query`, a `setup()` that
  runs before anything the request asked for. Writing the method is what exposes the key, so it
  needs no allow-list entry; plain columns stay declarative in the statics.
- **Container-resolved** — the class is constructed through the request's IoC resolver, so
  `@inject()` on the constructor works exactly as it does in a controller.
- **`Filterable` model mixin** — `static $filter = () => UserFilter`, then
  `User.filterPaginate(ctx)` for the whole endpoint, or `const { query } = await User.filter(ctx)`
  to keep composing and `query.filterPaginate()` to page it with what the request asked for.
- **The macros take a class** too, and `filterPaginate()` with no arguments pages a query a
  previous call already filtered.
- **`node ace make:filter user`** scaffolds the class.
- Key matching follows the same conventions as `adonis-lucid-filter`: `static blacklist`,
  `static dropId`, `static camelCase`, and a bare top-level key (`?minAge=21`) reaching a method of
  that name. Keys the wire format owns (`sort`, `page`, `search`, …) are never dispatched.

Everything compiles to the same `FilterSpec` the declarative `defineFilter` produces, so classes
and specs share one runner — same allow-listing, operators, search, sort and page clamping.

Note for the class form: `applyFilterFromRequest(query, UserFilter, ctx)` and `User.filter(ctx)`
resolve to `{ page, size }` and `{ query, page, size }` respectively, never to the builder as the
promise's own value — a Lucid query builder is thenable, so a promise resolving to one would run
the query instead of handing it back.
