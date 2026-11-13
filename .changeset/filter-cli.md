---
'@adonis-agora/filter': minor
---

New ace commands for what the dev MCP tools answer: `filter:specs:list` (`--page`, `--size`, `--json` as `{ data, meta }`), `filter:specs:show <name>` and `filter:query:explain <name> <query>` (exits with 1 when the request would be refused). They run the same code as the `filter_*` tools.
