---
"@adonis-agora/filter": major
---

**Breaking (security): relation columns are deny-by-default.** A `RelationSpec` declared without `filterable` (`relations: { author: {} }`) used to make every column of the related model filterable and sortable, so `?filter[author.password][startsWith]=$2a$` could recover a secret one character at a time. A relation's `filterable` now defaults to `[]` (its `sortable` still defaults to `filterable`); list the columns clients may use, or set `filterable: '*'` to opt a harmless relation back in.

- A request filtering or sorting on an unlisted column of a declared relation throws `InvalidColumnFilterError` even without `throwOnInvalid`, with a message naming the option to add, e.g. ``add 'name' to `relations.author.filterable` ``. Fields on undeclared relations are still dropped as before.
- Outside production, `defineFilter` emits a warning (code `AGORA_FILTER_RELATION_COLUMNS`) for each relation declared without `filterable`, `sortable` or `aggregates`; set `filterable: []` for a relation that is only a hop to a deeper one.
- New `agora:doctor` check `filter.relations` warns about the same relations, by file and line (or filter class). It needs no configuration: it loads `config/filter.ts`, the filter classes under `app/filters`, and any spec the app already defined.
- `agora:doctor` (`filter.manifest`) no longer reports a generated client as out of date when its code matches a fresh generation and only the banner's content hash is stale, as happens after a hand edit. The hash depends only on the generated output, never on the lib version.
- A filter or sort through a relation the spec doesn't declare (`filter[medication.nome]` without `relations.medication`) is still dropped, or refused under `throwOnInvalid`. It is no longer silent: outside production it warns once per spec and path (code `AGORA_FILTER_UNDECLARED_RELATION`). `filter:query:explain` reports the part as dropped because the relation is not declared, instead of printing a plain "Accepted by".
- `InvalidColumnFilterError` now has `status: 400` and `code: 'E_INVALID_COLUMN_FILTER'`, so AdonisJS renders it as a `400 Bad Request` without a custom handler.

To upgrade, add `filterable: [...]` to every relation in your specs and filter classes; `node ace agora:doctor` and the startup warnings list the ones to fix. See "Migrating to 1.0".
