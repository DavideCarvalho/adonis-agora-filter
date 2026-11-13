---
'@adonis-agora/filter': minor
---

List API helpers for any backend: `offsetPage(rows, { total, page, size })` and `cursorPage(rows, { nextCursor, prevCursor, hasNext, hasPrev })` / `cursorPage(buildCursorPage(...), map?)` build the `{ data, meta }` list envelopes; `parsePageParams(qs, { defaultSize, maxSize })` and `parseCursorParams(qs, { defaultSize, maxSize })` read paging params from a query string; `resolveSort(sort, { sortable, default })` checks a sort against an allow-list and throws `InvalidColumnFilterError` for anything else. Types `OffsetPage`, `OffsetPageMeta`, `CursorPageResponse`, `CursorPageMeta`, `PageParams`, `ParsedCursorParams` are exported. `readCursorParams(qs)` exposes the raw `after`/`before`/`first`/`last` read `applyCursorFromRequest` uses.
