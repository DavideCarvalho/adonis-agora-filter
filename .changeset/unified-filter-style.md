---
'@adonis-agora/filter': minor
---

One class style that does everything: `BaseFilter<TQuery>` — the generic base behind `BaseModelFilter` (Lucid) and custom backends alike — plus `applyCustomFilter` (methods per key over a caller-created draft, same envelope, loud rejections) and `groupByCount` end to end (`FilterQueryBuilder.groupByCount()` + `groupByCount[field]` envelope + `groupByCountFromRequest` over Lucid `GROUP BY` or a `GroupByCountAdapter`, with scope, search and paging). Lucid gains the `select`/`count`/`groupBy`/`offset` aggregation seam (optional, non-breaking).
