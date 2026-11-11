---
"@adonis-agora/filter": major
"@adonis-agora/filter-client": major
---

First stable release.

**Breaking (`@adonis-agora/filter-client`): pages are 1-based.** `.page(n)` now numbers pages from `1`, the same as the server and Lucid's `paginate`. Before, `.page()` took a 0-based index, so `.page(0)` and `.page(1)` both returned the first page and every later page was off by one.

- Replace `.page(0, 25)` with `.page(1, 25)`, and `.page(i)` with `.page(i + 1)`.
- `.page()` throws a `RangeError` when `page` or `size` is below 1 or not an integer.
- `applyTanstackTableState` / `tanstackTableToFilterQuery` send TanStack's 0-based `pageIndex` as `pageIndex + 1`. If you added the `+ 1` yourself before calling them, remove it.
- New `tanstackPaginationFromMeta(meta)` (from `@adonis-agora/filter-client/tanstack`) maps a paginated response's `meta` back to TanStack state (`pageIndex = currentPage - 1`, plus `pageCount` and `rowCount`).

`@adonis-agora/filter` (the server) is unchanged: it was already 1-based.

- Supported runtime: Node.js 24 and later (`engines.node: ">=24"`), the same requirement 0.x declared.
- `node ace add @adonis-agora/filter` runs the configure hook from the package's main entry. The `@adonis-agora/filter/configure` subpath still works too.
