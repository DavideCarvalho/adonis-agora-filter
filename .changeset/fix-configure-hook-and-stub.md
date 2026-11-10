---
"@adonis-agora/filter": patch
---

Fix `node ace add @adonis-agora/filter`: the package's main entry now exports the `configure` hook, so the provider and the commands barrel get registered in `adonisrc.ts`.

Fix `node ace make:filter`, which crashed with `SyntaxError: Unexpected identifier 'filterable'` while compiling its stub.
