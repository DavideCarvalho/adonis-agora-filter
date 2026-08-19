---
'@adonis-agora/filter': minor
---

`parseSpatieRequest` now parses `distinct`, matching `parseFilterRequest`.

`parseSpatieRequest` is documented as the additive counterpart to
`parseFilterRequest` — same filter, sort and search shapes, plus cursor
pagination, includes and sparse fieldsets — so a controller can swap one for the
other. It did not read `distinct`, even though the runner applies it. Swapping
the parser turned a working `?distinct=city` into a full, un-deduped result set
with nothing to signal that the parameter had been dropped.

Both string (`distinct=city,tier`) and repeated (`distinct[]=city&distinct[]=tier`)
forms now parse identically in the two parsers.
