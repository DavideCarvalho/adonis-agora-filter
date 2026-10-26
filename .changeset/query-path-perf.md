---
"@adonis-agora/filter": patch
---

Faster list queries, and a `notContains` fix.

- `filterPaginate` (the query macro and `Model.filterPaginate`) reads the page before the total and skips Lucid's `COUNT(*)` when the page comes back short, since `offset + rows` already is the total. Full pages, and empty pages past the first, still count. Models with `before:paginate` / `before:fetch` hooks, and select lists that can change the row count (`distinct`, aggregates, raw expressions, `union`), keep Lucid's own `paginate`. The paginator and its meta are unchanged.
- The keyset seek ANDs a redundant `c0 >= v0` (`<=` for a `desc` lead) in front of its OR-of-tiers predicate, so Postgres can seek a `(c0, id)` index to the cursor instead of scanning from the start of it. Skipped when the boundary value is NULL.
- A to-many `$count` filter that only tests emptiness (`gt 0`, `gte 1`, `notEquals 0`, `equals 0`, `lte 0`, `lt 1`) compiles to `EXISTS` / `NOT EXISTS` instead of a correlated `COUNT(*)`. Same rows.
- Fix: `notContains` compiled to a not-equals test. It now is the negation of `contains` — `field IS NOT NULL AND NOT (field ILIKE '%v%')` — with the same case-insensitivity and LIKE escaping. `QueryBuilderLike` gains the `whereNot(callback)` overload this needs (Lucid, the in-memory builder and `MockQueryBuilder` implement it).
