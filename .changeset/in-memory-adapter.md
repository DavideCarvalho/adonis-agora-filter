---
'@adonis-agora/filter': minor
---

In-memory adapter at `@adonis-agora/filter/in-memory`: `defineCollection({ fields, primaryKey, relations })` declares a row source (field types incl. `'string[]'`-style arrays, virtual fields, to-one/to-many relations), and `collection.query(rows)` is a `QueryBuilderLike` the existing runner drives unchanged — `applyFilter`, `applyCursor`, `applyFilterFromRequest`, `applyCursorFromRequest` and `groupByCountFromRequest` all work over a plain array with the same parsing, allow-listing and coercion. Evaluation mirrors the SQL the Lucid adapter emits (ILIKE, three-valued NULL logic, NULLS LAST asc / FIRST desc, EXISTS for to-many paths). `filterInMemory` / `cursorInMemory` do it in one call; `InMemoryQueryError` is thrown for SQL-only features (`computed`, `fullText`, `vectorSimilarity`).
