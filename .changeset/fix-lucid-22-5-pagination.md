---
"@adonis-agora/filter": patch
---

Fix pagination with `@adonisjs/lucid` 22.5: pagination dropped one row per page and produced `?undefined=N` links with @adonisjs/lucid 22.5. Lucid 22.5 added a `pageName` argument to its paginator constructors ahead of the rows, and the filter's page-then-count `paginate()` passed the rows in that slot. It now passes `'page'` (Lucid's default) when the installed Lucid expects it, so every version in the `^22.0.0` peer range pages correctly. Backport of the 1.0.1 fix to the 0.x line, published under the `v0` dist-tag.
