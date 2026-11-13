---
'@adonis-agora/filter-client': minor
---

Cursor pagination on the builder: `.after(cursor)`, `.before(cursor)`, `.first(n)`, `.last(n)` (plain and typed builders), serialized by `toQueryString()` and `build()`. Offset (`.page()`) and cursor paging are mutually exclusive: whichever was set last wins. New response types `OffsetPage<T>`, `OffsetPageMeta`, `CursorPageResponse<T>`, `CursorPageMeta`, plus `CursorPagination`.
