---
'@adonis-agora/filter': patch
---

Fix a 500 when `distinct` is given a relation path.

`distinct` was gated on the `allowed` list and nothing else. A relation path like
`posts.title` is filterable by design — declaring `relations: { posts: { filterable: ['title'] } }`
whitelists it, and `make:filter-client` enumerates it into the generated field
union — so `?distinct=posts.title` cleared the check and was handed to Lucid
verbatim:

```sql
select distinct "posts"."title" from "users"
--> ERROR: missing FROM-clause entry for table "posts"
```

Lucid filters a relation with a correlated `EXISTS` subquery, so the relation is
never joined into the outer `FROM` and there is no alias to project a column
from. A `whereHas` on the same relation in the same request does not help.

**If your `distinct` works today, nothing changes.** Root-table columns —
including ones qualified with the root table's own name — behave exactly as
before, as do the alias resolution and the allow-list drop.

**If you pass a relation path** (`posts.title`) or a to-many aggregate path
(`posts.$count`), you now get a defined refusal instead of a database error: the
field is dropped from the `distinct` list (the remaining fields still apply), or
raises `InvalidColumnFilterError` — a 400, not a 500 — when your spec sets
`throwOnInvalid`. The message names the cause: it is the missing join, not the
allow-list, so adding the path to `filterable` will not (and should not) change
it. Filtering on that path keeps working; only projecting it is refused.
