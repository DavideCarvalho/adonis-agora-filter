---
"@adonis-agora/filter": major
"@adonis-agora/filter-client": major
---

First stable release. The public API is the one 0.11.x shipped, so moving from 0.11.x needs no code changes.

- Supported runtime: Node.js 24 and later (`engines.node: ">=24"`), the same requirement 0.11.x declared.
- `node ace add @adonis-agora/filter` runs the configure hook from the package's main entry. The `@adonis-agora/filter/configure` subpath still works too.
