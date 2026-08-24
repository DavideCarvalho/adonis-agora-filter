# @adonis-agora/filter

## 0.7.1

### Patch Changes

- [#26](https://github.com/DavideCarvalho/adonis-agora-filter/pull/26) [`9b07c15`](https://github.com/DavideCarvalho/adonis-agora-filter/commit/9b07c159716c5032812bbf5c2360ff82df7be4c5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent AI-agent skills: five core skills under `packages/core/skills/` (filter-basics, filter-safety, filter-definitions, filter-querying, filter-codegen) and one under `packages/client/skills/` (filter-query-builder), plus repo-level `_artifacts/` (domain map, skill spec, skill tree) and a `check-skills` GitHub workflow validating them on PRs. Skills are included in each package's `files` so they land in `node_modules` on install.

## 0.7.0

### Minor Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-filter/pull/23) [`2bd4e7b`](https://github.com/DavideCarvalho/adonis-agora-filter/commit/2bd4e7baa50d3d0b4a25c834fc9edf612f7d854a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `parseSpatieRequest` now parses `distinct`, matching `parseFilterRequest`.

  `parseSpatieRequest` is documented as the additive counterpart to
  `parseFilterRequest` — same filter, sort and search shapes, plus cursor
  pagination, includes and sparse fieldsets — so a controller can swap one for the
  other. It did not read `distinct`, even though the runner applies it. Swapping
  the parser turned a working `?distinct=city` into a full, un-deduped result set
  with nothing to signal that the parameter had been dropped.

  Both string (`distinct=city,tier`) and repeated (`distinct[]=city&distinct[]=tier`)
  forms now parse identically in the two parsers.

- [#23](https://github.com/DavideCarvalho/adonis-agora-filter/pull/23) [`2bd4e7b`](https://github.com/DavideCarvalho/adonis-agora-filter/commit/2bd4e7baa50d3d0b4a25c834fc9edf612f7d854a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add the `configure` hook, so `node ace add @adonis-agora/filter` actually wires the package.

  The install instructions have always said to run `node ace add @adonis-agora/filter`,
  but the package shipped no `configure` hook, so the command installed the
  dependency and wired nothing. Two things silently did not happen: the provider
  was never added to `adonisrc.ts` (no `applyFilterFromRequest` / `filterPaginate`
  macros on `ModelQueryBuilder`), and the commands barrel was never registered, so
  `make:filter-client` never appeared in `node ace list`.

  `node ace add @adonis-agora/filter` — or `node ace configure @adonis-agora/filter`
  on an already-installed package — now registers both:

  ```ts
  // adonisrc.ts
  providers: [() => import('@adonis-agora/filter/filter_provider')],
  commands: [() => import('@adonis-agora/filter/commands')],
  ```

  Nothing is published to `config/`: a filter policy is a per-model
  `defineFilterSpec` call in your own code, not global configuration. Apps that
  wired those two entries by hand need no change — the codemod is idempotent.

- [#23](https://github.com/DavideCarvalho/adonis-agora-filter/pull/23) [`2bd4e7b`](https://github.com/DavideCarvalho/adonis-agora-filter/commit/2bd4e7baa50d3d0b4a25c834fc9edf612f7d854a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `parseFilterRequest` now understands the client builder's structured shape, closing a silent unfiltered-response bug.

  A POST search endpoint that hands `filterQuery()…build()` straight to
  `parseFilterRequest` — the pairing the guides describe — did not work. The
  builder returns

  ```ts
  { filter: { where: [{ field: 'status', operator: 'in', value: [...] }] },
    sort: [{ field: 'createdAt', direction: 'desc' }],
    paginate: { page: 2, size: 25 } }
  ```

  and the parser reshaped it as if `where` were a column: the entire condition list
  became one `in` filter on a field named `where`, which the allow-list then
  pruned, while `sort` and `paginate` were discarded for not being strings. The
  endpoint answered with **every row, unsorted and unpaginated**, and raised
  nothing — the failure looked like a working search with a broad result set.

  The same shape reaches a plain GET too, because OR/AND groups serialize to a
  top-level `where[0][field]=…`, so grouped queries were silently unfiltered as
  well.

  `parseFilterRequest` now recognises an already-structured condition list — under
  `filter.where` or at the top level — and takes it as the filters, with nested
  `AND`/`OR` groups intact. It also reads `sort` in the `[{ field, direction }]`
  form and maps `paginate: { page, size }` onto `page`/`size`.

  Existing requests are unaffected: `filter[field]=…`, `sort=-createdAt`,
  `page`/`size` and `page[number]`/`page[size]` parse exactly as before, and a real
  column named `where` (`filter[where]=lobby`, `filter[where][contains]=lob`,
  `filter[where][]=a&filter[where][]=b`) is still treated as a column — only an
  array of `{ field, operator }` records is read as a structured list, and a query
  string cannot produce one by accident.

  Note that `include` is still not consumed: eager-loading stays the caller's
  `preload` call.

### Patch Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-filter/pull/23) [`2bd4e7b`](https://github.com/DavideCarvalho/adonis-agora-filter/commit/2bd4e7baa50d3d0b4a25c834fc9edf612f7d854a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Report the real version from the exported `VERSION` constant.

  `VERSION` is a hand-written literal next to a "keep in sync with package.json"
  comment, and it had not been touched since the first release: the package shipped
  `0.2.0` through `0.6.0` while `VERSION` still answered `'0.1.0'`. Anything gating
  on it — a feature check, a bug report, a diagnostics banner — got a wrong answer.

  It now reads `0.6.0`, and a test compares it against `package.json` so the next
  release cannot silently drift again.

- [#22](https://github.com/DavideCarvalho/adonis-agora-filter/pull/22) [`a33b2fe`](https://github.com/DavideCarvalho/adonis-agora-filter/commit/a33b2febc48baa3dafcf6a703e4250bdebbde275) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix a 500 when `distinct` is given a relation path.

  `distinct` was gated on the `allowed` list and nothing else. A relation path like
  `posts.title` is filterable by design — declaring `relations: { posts: { filterable: ['title'] } }`
  whitelists it, and `make:filter-client` enumerates it into the generated field
  union — so `?distinct=posts.title` cleared the check and was handed to Lucid
  verbatim:

  ```sql
  select distinct "posts"."title" from "users"
  --> ERROR: missing FROM-clause entry for table "posts"
  ```

  Lucid filters a relation with a correlated `EXISTS` subquery, so the relation is
  never joined into the outer `FROM` and there is no alias to project a column
  from. A `whereHas` on the same relation in the same request does not help.

  **If your `distinct` works today, nothing changes.** Root-table columns —
  including ones qualified with the root table's own name — behave exactly as
  before, as do the alias resolution and the allow-list drop.

  **If you pass a relation path** (`posts.title`) or a to-many aggregate path
  (`posts.$count`), you now get a defined refusal instead of a database error: the
  field is dropped from the `distinct` list (the remaining fields still apply), or
  raises `InvalidColumnFilterError` — a 400, not a 500 — when your spec sets
  `throwOnInvalid`. The message names the cause: it is the missing join, not the
  allow-list, so adding the path to `filterable` will not (and should not) change
  it. Filtering on that path keeps working; only projecting it is refused.

- [#23](https://github.com/DavideCarvalho/adonis-agora-filter/pull/23) [`2bd4e7b`](https://github.com/DavideCarvalho/adonis-agora-filter/commit/2bd4e7baa50d3d0b4a25c834fc9edf612f7d854a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare a supported Node range in `engines` again, instead of one exact version.

  Both packages shipped `"engines": { "node": "v26.7.0" }` — an exact version, and
  plainly the output of `node -v`, leading `v` and all. Every consumer on any other
  Node got an unsatisfied-engine warning on install, and anyone running with
  `engine-strict` (or a package manager that treats it as fatal) could not install
  at all. The pinned version was also higher than anything the project itself uses:
  CI runs Node 22 and `.nvmrc` names Node 20.

  `engines` states the floor the package actually supports, which is `>=20.6.0` —
  the same range it declared before, and the one the rest of the Agora packages
  use. Nothing about the code changed; this only stops a false incompatibility
  signal.

## 0.6.0

### Minor Changes

- Parity sync from nestjs-filter: execute the server-side `distinct` projection (was a silent no-op), computed (virtual) fields for filter + sort (verbatim-string + `({alias}) => sql` forms), and native to-many aggregate fields (`$count`/`$sum`/`$avg`/`$min`/`$max`) auto-discovered from Lucid relation metadata — value stays parameterized (injection-safe), identifiers quoted.

## 0.5.0

### Minor Changes

- [#6](https://github.com/DavideCarvalho/adonis-filter/pull/6) [`e39da2c`](https://github.com/DavideCarvalho/adonis-filter/commit/e39da2c6f7e47553990f3295414b23d508894c9a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Os macros `query.applyFilterFromRequest(spec, ctx?)` e `query.filterPaginate(spec, ctx?)` passam a aceitar `ctx` opcional: quando omitido, leem o `HttpContext` ativo do AsyncLocalStorage do Adonis (`HttpContext.getOrFail()`). Nos controllers (99% dos casos) você chama `query.applyFilterFromRequest(spec)` sem passar o ctx. Fora de uma request (job/command), passe o ctx explicitamente. O default vive só no macro (camada Adonis); a função livre `applyFilterFromRequest` continua framework-agnostic, exigindo o ctx.

## 0.4.0

### Minor Changes

- [#4](https://github.com/DavideCarvalho/adonis-filter/pull/4) [`76b2ca8`](https://github.com/DavideCarvalho/adonis-filter/commit/76b2ca82d27811b09dbd98629be6964e9aee6167) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add chainable Lucid query-builder macros via an optional `FilterProvider`

  Register `@adonis-agora/filter/filter_provider` to get the method-call form of
  `applyFilterFromRequest` on any Lucid query builder:

  ```ts
  // filter + sort + search, then keep chaining:
  const rows = await User.query()
    .where("tenantId", tenant.id)
    .applyFilterFromRequest(userFilter, ctx)
    .orderBy("createdAt", "desc");

  // filter + paginate in one terminal call (returns Lucid's paginator):
  const page = await User.query().filterPaginate(userFilter, ctx);
  ```

  `applyFilterFromRequest` applies the spec's server scope + allow-listed
  filter/sort/search and returns the query for chaining (pagination resolved but
  not applied); `filterPaginate` additionally calls `paginate(page, size)`. The
  free functions are unchanged and work without the provider — the macros only add
  the chainable sugar, so `@adonisjs/lucid` is an optional peer. `registerFilterMacros`
  is also exported for manual registration.

## 0.3.1

### Patch Changes

- [`e6fb05c`](https://github.com/DavideCarvalho/adonis-filter/commit/e6fb05c0e137cd4ab3bad1f9ce5626216e670a8f) - Fix `QueryBuilderLike` rejecting every real Lucid query builder

  Passing a Lucid builder to `applyFilterFromRequest` (or any adapter entry
  point) failed to typecheck in consuming apps:

  ```
  Argument of type 'ModelQueryBuilderContract<typeof Post, Post>' is not
  assignable to parameter of type 'QueryBuilderLike'.
    Types of property 'where' are incompatible.
  ```

  The message blames `where`, but `where` was fine — TS reports the first member
  it tries. The real culprit was `whereHas`, declared here as
  `whereHas(relation: string, ...)`. Lucid types its own as
  `<Name extends ExtractModelRelations<Model>>(relation: Name, ...)`, a union of
  the model's literal relation names, and `string` is not assignable to that
  union under the contravariant parameter check — so no real builder ever
  satisfied the interface. Runtime was always fine; this was types-only.

  `relation` is now `any`, which is the only type that both accepts the `string`
  the adapter passes and is assignable to each model's relation-name union.
  Marking the member optional does not help: an optional member that is present
  is still checked.

  A compile-time guard against real `@adonisjs/lucid` types now covers this
  (`test/types/lucid_compat.types.ts`, run by `pnpm typecheck`). Lucid is a
  devDependency only — nothing under `src/` imports it, so the package stays
  framework-free. A hand-transcribed stub of Lucid's types was tried first and
  compiled clean while real Lucid did not, so the guard uses Lucid's own `.d.ts`.

## 0.3.0

### Minor Changes

- [`d20245c`](https://github.com/DavideCarvalho/adonis-filter/commit/d20245cc6818120098d0f9027b59284380fd9f7e) - `filterable` accepts a colocated map: field name and its kind in one place

  The array form makes every non-string field appear twice — once in `filterable`, once in
  `fieldTypes` — which is ceremony for what is usually a short list:

  ```ts
  filterable: ['advisorId', 'dayOfWeek', 'isRecurring'],
  fieldTypes: { dayOfWeek: { kind: 'number' }, isRecurring: { kind: 'boolean' } },
  ```

  `filterable` now also accepts a map, declaring both at once:

  ```ts
  filterable: { advisorId: 'string', dayOfWeek: 'number', isRecurring: 'boolean' },
  ```

  It desugars at the `defineFilter` boundary — the keys become the allow-list, the values become
  `fieldTypes` — so everything downstream (predicates, runner, codegen) sees exactly the spec the
  array form produces. An explicit `fieldTypes` entry still wins per field, which is how a caller
  adds codegen-only richness (`enumValues`/`typeRef`) on top of a bare kind.

  Both existing forms (`string[]` and `'*'`) are untouched and remain the right choice when no field
  needs a declared type — `'string'` is the no-op kind, so a spec of only string columns should keep
  using the array.

## 0.2.0

### Minor Changes

- [`058f0c0`](https://github.com/DavideCarvalho/adonis-filter/commit/058f0c0ef3dd224277663e6a5d40c0ef58e6bbd7) - `fieldTypes` on `defineFilter`: server-side value validation, and one type declaration for both ends

  A filter value arriving over a query string is always a string, and Postgres implicitly casts the
  benign cases — `day_of_week = '3'` and `is_recurring = 'false'` both work — so the gap stayed
  invisible. It surfaces when a client sends something uncastable: `?filter[isRecurring][equals]=xyz`
  becomes `is_recurring = 'xyz'`, which Postgres rejects with `invalid input syntax for type boolean`.
  That is a **500 on a public endpoint, driven entirely by user input**. The allow-list guarded which
  FIELD could be filtered; nothing guarded the VALUE that reached the column.

  `defineFilter` now accepts `fieldTypes`, and a declared field has its value coerced before it ever
  reaches the driver. An uncoercible value is treated exactly like a disallowed field — dropped by
  default, or a loud `InvalidColumnFilterError` (→ 400 instead of 500) under `throwOnInvalid`. The
  existing semantics are reused rather than a second error path invented.

  ```ts
  export const availabilityFilter = defineFilter({
    filterable: ["advisorId", "dayOfWeek", "isRecurring"],
    fieldTypes: {
      dayOfWeek: { kind: "number" },
      isRecurring: { kind: "boolean" },
    },
  });
  ```

  The same declaration now also feeds `make:filter-client`, which previously required repeating the
  types in the codegen manifest. Declaring a kind once drives both value coercion and the client's
  operator narrowing; an explicit manifest `fieldTypes` still wins when the client wants richer
  codegen-only info (`enumValues`/`typeRef`).

  Details:

  - Array-valued operators (`in`, `between`, ...) coerce element-wise and fail as a whole if any
    element fails — a partially-coerced list would filter on something the client never asked for.
  - Pattern operators (`contains`, `startsWith`, ...) are never coerced: their argument is a LIKE
    pattern, so turning `contains: '3'` into the number `3` would destroy it.
  - `date` values are validated but handed back verbatim, never rewritten — converting `'2026-07-15'`
    to a `Date` would silently re-zone a date-only value and shift the day for negative-offset clients.
  - Undeclared fields are untouched, so this is backwards compatible and opt-in.
  - `FilterFieldKind` moved from `generate_client.ts` to `types.ts` (it is no longer codegen-only) and
    is re-exported from its old path.
