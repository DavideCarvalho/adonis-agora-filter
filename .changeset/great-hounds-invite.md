---
'@adonis-agora/filter': minor
---

Add the `configure` hook, so `node ace add @adonis-agora/filter` actually wires the package.

The install instructions have always said to run `node ace add @adonis-agora/filter`,
but the package shipped no `configure` hook, so the command installed the
dependency and wired nothing. Two things silently did not happen: the provider
was never added to `adonisrc.ts` (no `applyFilterFromRequest` / `filterPaginate`
macros on `ModelQueryBuilder`), and the commands barrel was never registered, so
`make:filter-client` never appeared in `node ace list`.

`node ace add @adonis-agora/filter` — or `node ace configure @adonis-agora/filter`
on an already-installed package — now registers both:

```ts
// adonisrc.ts
providers: [() => import('@adonis-agora/filter/filter_provider')],
commands: [() => import('@adonis-agora/filter/commands')],
```

Nothing is published to `config/`: a filter policy is a per-model
`defineFilterSpec` call in your own code, not global configuration. Apps that
wired those two entries by hand need no change — the codemod is idempotent.
