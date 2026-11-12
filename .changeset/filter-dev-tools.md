---
'@adonis-agora/filter': minor
---

Dev MCP tools on `@adonis-agora/agent`'s `/mcp/agora` endpoint (gated by its `devTools.authorize`): `filter_list_specs`, `filter_get_spec`, `filter_explain_query` (dry run of a query string against a spec, no database). New exports `explainFilterQuery`, `parseQueryString` and `loadFilterManifest`.
