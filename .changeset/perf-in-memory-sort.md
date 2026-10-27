---
"@adonis-agora/filter": patch
---

perf(in-memory): read each row's sort values at most once (lazily memoized) instead of twice per comparison, memoize the reader used for to-one relation hops, and hoist per-field kind lookups out of the distinct/group-by row loops. Sorting 20k rows by a virtual field is ~2x faster and by a to-one relation path ~5x faster; results and error behaviour are unchanged.
