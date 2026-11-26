---
"@adonis-agora/filter": minor
---

**Security (breaking):** relation columns are now deny-by-default. A relation declared in a filter spec without a `filterable` list (for example `relations: { author: {} }`) used to make every column of the related model filterable and sortable from the query string. Its `filterable` now defaults to `[]` (and `sortable` to `filterable`), so a filter or sort on an unlisted relation column is dropped, or refused under `throwOnInvalid`, like any other disallowed field.

To keep filtering on a relation, list its columns explicitly: `relations: { author: { filterable: ['name'] } }`. `filterable: '*'` opts a harmless relation back in to every column. Outside production, `defineFilter` warns about each relation declared without an allow-list.
