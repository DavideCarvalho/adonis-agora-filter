# adonis-filter — Skill Spec

`@adonis-agora/filter` turns Spatie/JSON:API-style query strings (`filter[field][op]=value`, `sort=-createdAt`, `page`/`size`) into safe, allow-listed Lucid queries on AdonisJS servers; `@adonis-agora/filter-client` builds exactly that wire format in the browser/Node, with optional TanStack Table sync. The server's allow-list is the security boundary; everything else (operators, AND/OR groups, ILIKE/tsvector/pgvector search, offset + cursor pagination, computed fields, to-many aggregates) composes around it. This spec targets `@adonis-agora/filter@0.7.0` and `@adonis-agora/filter-client@0.2.1`.

> Generated autonomously (no maintainer interview). All failure modes are grounded in
> `README.md`, `docs/**`, or `packages/*/src`; open questions are listed under
> Remaining Gaps.

## Domains

| Domain | Description | Skills |
| ------ | ----------- | ------ |
| Wiring a filtered endpoint | Parse request → apply to Lucid query under an allow-list → resolve pagination; declarative flow and optional macros | filter-basics |
| Guarding the query surface | Allow-listing, validation, strict vs lenient rejection, tenant scoping, escaping, testing the boundary | filter-safety |
| Declaring filter policies | defineFilter specs — relations, aliases, computed fields, aggregates, field types, server defaults | filter-definitions |
| Paging, searching, projecting | Cursor pagination, three search modes, DISTINCT projection, richer Spatie input surface | filter-querying |
| Sharing the contract with clients | Codegen from spec → typed client; hand-built typed query strings | filter-codegen, filter-query-builder |

## Skill Inventory

| Skill | Type | Domain | Package | What it covers | Failure modes |
| ----- | ---- | ------ | ------- | -------------- | ------------- |
| filter-basics | core | endpoint-wiring | @adonis-agora/filter | parseFilterRequest, applyFilter, FilterConfig, defineFilter, applyFilterFromRequest, provider macros, resolved pagination | 3 |
| filter-safety | core | query-safety | @adonis-agora/filter | allow-lists, throwOnInvalid, InvalidColumnFilterError, structural validation, escapeLike, fieldTypes coercion, testing mock | 5 |
| filter-definitions | core | policy-declaration | @adonis-agora/filter | defineFilter options, relations + depth cap, aliases, computed fields, aggregates, colocated field-type map, tenant scope | 6 |
| filter-querying | core | paging-search-projection | @adonis-agora/filter | applyCursor*, buildCursorPage, fullText, vectorSimilarity, distinct rules, parseSpatieRequest / resolveInputFromRequest / normalizeInput | 6 |
| filter-codegen | core | client-contract | @adonis-agora/filter | generateFilterClient(s), make:filter-client, FilterClientManifest, fieldTypes narrowing, field-path enumerators | 4 |
| filter-query-builder | core | client-contract | @adonis-agora/filter-client | filterQuery() chaining, where vs add, or()/and(), output formats, filterQueryTyped, whereDynamic, reactivity, TanStack Table sync | 6 |

## Failure Mode Inventory

### Filter basics (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Using raw request page/size instead of resolved values | CRITICAL | docs/getting-started.mdx · docs/guides/filter-classes.mdx | — |
| 2 | Adding tenant-scoped columns to the allow-list | HIGH | docs/definitions/index.mdx · docs/guides/controllers.mdx | — |
| 3 | Expecting search to work without a searchable list | MEDIUM | docs/guides/filter-classes.mdx | — |

### Filter safety (5 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Allowing every column with a star allow-list | CRITICAL | docs/guides/filter-classes.mdx | — |
| 2 | Feeding client filters to low-level apply functions unpruned | CRITICAL | docs/guides/lucid.mdx · docs/guides/relations.mdx | — |
| 3 | Trusting silent-drop while debugging a broken filter | HIGH | docs/guides/validation.mdx | — |
| 4 | Assuming query-string numbers arrive as numbers | HIGH | docs/definitions/index.mdx · docs/guides/operators.mdx | filter-definitions |
| 5 | Building LIKE patterns without escaping wildcards | MEDIUM | docs/guides/operators.mdx | — |

### Filter definitions (6 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Declaring aggregate paths without the owning model | HIGH | docs/definitions/aggregates.mdx | — |
| 2 | Function-form computed fields without a root table | HIGH | docs/definitions/computed.mdx | — |
| 3 | Reading a dotted alias target as a JSON path | HIGH | docs/definitions/aliases.mdx | — |
| 4 | Nesting computed aliases inside AND/OR groups | MEDIUM | docs/definitions/computed.mdx | — |
| 5 | Chaining aliases expecting multi-hop resolution | MEDIUM | docs/definitions/aliases.mdx | — |
| 6 | Expecting date-coerced values back as Date objects | MEDIUM | docs/definitions/index.mdx | — |

### Structured querying (6 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Passing model instances to buildCursorPage | HIGH | docs/pagination/index.mdx | — |
| 2 | Projecting distinct on a relation path | HIGH | docs/guides/lucid.mdx | — |
| 3 | Expecting include and select to be applied | HIGH | docs/guides/client.mdx · docs/definitions/request-input.mdx | filter-query-builder |
| 4 | Confusing full-text search with vector similarity | HIGH | docs/search/index.mdx | — |
| 5 | Counting on distinct paginated totals | MEDIUM | docs/guides/lucid.mdx | — |
| 6 | Wrapping text columns in to_tsvector on large tables | MEDIUM | docs/search/full-text.mdx | — |

### Client codegen (4 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Running make:filter-client with the commands barrel unregistered | HIGH | docs/codegen/index.mdx | — |
| 2 | Hand-editing or not regenerating generated clients | HIGH | docs/codegen/index.mdx | — |
| 3 | Relying on codegen unions from a star allow-list | MEDIUM | docs/codegen/index.mdx | — |
| 4 | Skipping fieldTypes and expecting operator narrowing | MEDIUM | docs/codegen/index.mdx | — |

### Client query builder (6 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Stacking range methods that overwrite each other | HIGH | docs/guides/client.mdx | — |
| 2 | Sending the zero-based client page straight to the server | HIGH | docs/guides/client.mdx · docs/guides/filter-classes.mdx | filter-basics |
| 3 | Treating whereDynamic as a security control | HIGH | docs/guides/client.mdx | filter-safety |
| 4 | Asserting the decoded bracket notation in tests | MEDIUM | docs/guides/client.mdx | — |
| 5 | Losing AND/OR groups through toFlatObject | MEDIUM | docs/guides/client.mdx | — |
| 6 | Mutating the cached reactive snapshot | MEDIUM | docs/guides/client.mdx | — |

## Tensions

| Tension | Skills | Agent implication |
| ------- | ------ | ----------------- |
| Lenient UX vs contract strictness | filter-basics ↔ filter-safety | Agents ship default silent-drop, then debug "broken" filters that were pruned; or enable throwOnInvalid without mapping InvalidColumnFilterError to a 400. |
| Virtual-field expressiveness vs query cost | filter-definitions ↔ filter-querying | Agents make aggregate aliases sortable on big tables without indexing child FKs or considering materialised counters. |
| Client type-safety vs server authority | filter-query-builder ↔ filter-safety | Agents treat compile-checked clients as authorization and skip mirroring the server allow-list (e.g. the tanstack adapter `fields` option). |

## Cross-References

| From | To | Reason |
| ---- | -- | ------ |
| filter-basics | filter-definitions | Grow from the two-function primitive to a reusable spec once policies span endpoints. |
| filter-basics | filter-safety | Tighten the allow-list story before exposing an endpoint publicly. |
| filter-definitions | filter-codegen | A spec is also the codegen source — one declaration drives both ends. |
| filter-querying | filter-definitions | fullText and vectorSimilarity are options declared alongside the policy. |
| filter-query-builder | filter-codegen | Generated modules wrap filterQueryTyped — hand-written builders should follow suit. |
| filter-safety | filter-querying | Cursor pagination and search route through the same allow-list boundary. |

## Subsystems & Reference Candidates

| Skill | Subsystems | Reference candidates |
| ----- | ---------- | -------------------- |
| filter-basics | free functions vs macros (provider) | — |
| filter-safety | structural validation vs VineJS application validation | — |
| filter-definitions | relations, aliases, computed, aggregates | operators × field-kind operator matrix (>10 shapes) — kept inline in client skill instead of a references/ file for v1 |
| filter-querying | ILIKE / fullText / vectorSimilarity; offset / cursor | — |
| filter-codegen | generateFilterClient API / make:filter-client command | — |
| filter-query-builder | vanilla builder / typed builder / tanstack adapter | — |

## Remaining Gaps

| Skill | Question | Status |
| ----- | -------- | ------ |
| filter-basics | `packages/core/src/index.ts` exports `VERSION = '0.6.0'` while package.json is 0.7.0 — which is authoritative at publish time? | open |
| all | No maintainer interview (autonomous run); priorities/tensions derive from docs callouts, not maintainer answers. | open |
| filter-definitions | Whether a dotted path in the base `filterable` array authorizes relation filtering without a `relations` entry was inferred from docs, not verified in runner.ts. | open |
| filter-querying | GitHub issues/discussions not scanned (offline constraint); all failure modes are doc/source-grounded. | open |

## Recommended Skill File Structure

- **Core skills:** all six are framework-agnostic at the API level; AdonisJS controller snippets appear only as wiring examples inside filter-basics/safety/querying.
- **Framework skills:** none — the library has no React/Vue adapter packages (client reactivity is a store contract documented inside filter-query-builder).
- **Lifecycle skills:** none standalone — setup lives in filter-basics (server) and filter-query-builder/codegen (client), matching the docs' getting-started split.
- **Composition skills:** none standalone — TanStack Table sync is part of filter-query-builder (@tanstack/table-core is an optional peer).
- **Reference files:** none required for v1; revisit if any SKILL.md approaches the 500-line limit.

## Composition Opportunities

| Library | Integration points | Composition skill needed? |
| ------- | ------------------ | ------------------------- |
| @adonisjs/lucid | QueryBuilderLike adapter, paginate(), preload/whereHas/withCount | no — covered across filter-basics/safety/querying |
| @tanstack/table-core | applyTanstackTableState / tanstackTableToFilterQuery | no — covered in filter-query-builder |
| @vinejs/vine | value coercion layer over parsed input | no — covered in filter-safety |
