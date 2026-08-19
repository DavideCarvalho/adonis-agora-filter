---
'@adonis-agora/filter': minor
---

`parseFilterRequest` now understands the client builder's structured shape, closing a silent unfiltered-response bug.

A POST search endpoint that hands `filterQuery()…build()` straight to
`parseFilterRequest` — the pairing the guides describe — did not work. The
builder returns

```ts
{ filter: { where: [{ field: 'status', operator: 'in', value: [...] }] },
  sort: [{ field: 'createdAt', direction: 'desc' }],
  paginate: { page: 2, size: 25 } }
```

and the parser reshaped it as if `where` were a column: the entire condition list
became one `in` filter on a field named `where`, which the allow-list then
pruned, while `sort` and `paginate` were discarded for not being strings. The
endpoint answered with **every row, unsorted and unpaginated**, and raised
nothing — the failure looked like a working search with a broad result set.

The same shape reaches a plain GET too, because OR/AND groups serialize to a
top-level `where[0][field]=…`, so grouped queries were silently unfiltered as
well.

`parseFilterRequest` now recognises an already-structured condition list — under
`filter.where` or at the top level — and takes it as the filters, with nested
`AND`/`OR` groups intact. It also reads `sort` in the `[{ field, direction }]`
form and maps `paginate: { page, size }` onto `page`/`size`.

Existing requests are unaffected: `filter[field]=…`, `sort=-createdAt`,
`page`/`size` and `page[number]`/`page[size]` parse exactly as before, and a real
column named `where` (`filter[where]=lobby`, `filter[where][contains]=lob`,
`filter[where][]=a&filter[where][]=b`) is still treated as a column — only an
array of `{ field, operator }` records is read as a structured list, and a query
string cannot produce one by accident.

Note that `include` is still not consumed: eager-loading stays the caller's
`preload` call.
