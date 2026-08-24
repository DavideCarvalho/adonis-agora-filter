---
'@adonis-agora/filter': patch
'@adonis-agora/filter-client': patch
---

Ship TanStack Intent AI-agent skills: five core skills under `packages/core/skills/` (filter-basics, filter-safety, filter-definitions, filter-querying, filter-codegen) and one under `packages/client/skills/` (filter-query-builder), plus repo-level `_artifacts/` (domain map, skill spec, skill tree) and a `check-skills` GitHub workflow validating them on PRs. Skills are included in each package's `files` so they land in `node_modules` on install.
