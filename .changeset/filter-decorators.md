---
'@adonis-agora/filter': minor
---

Decorators for the class form, and a `FilterClass` type fix.

`@filterFor('team.name')` binds a filter method to the request key(s) it answers, for keys a method
name could never spell and for one method answering several keys; a bound method stops answering to
its own name, so the public key survives a rename. A key the wire format owns (`sort`, `page`, …)
is refused when the class is defined.

`@filterable()`, `@sortable()` and `@searchable()` declare a model's filterable surface on the
columns themselves, stacked under Lucid's `@column()`; a filter picks them up through its
`static model`, and a static on the filter still replaces the list outright so a stricter filter can
narrow a shared model. `@filterable('number')` also declares the field's kind.

Both work under legacy (`experimentalDecorators`, what AdonisJS compiles) and standard TC39
decorators — the flavour is detected at call time.

Fixes `FilterClass`, which intersected `Record<string, unknown>`: no concrete
`class UserFilter extends BaseModelFilter` satisfied that, so `static $filter = () => UserFilter`
on a model did not typecheck. A type test over a real Lucid model now covers it.
