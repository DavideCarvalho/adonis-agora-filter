---
'@adonis-agora/filter': minor
---

`node ace agora:doctor` (the shared Agora health check) and `node ace filter:doctor`, with the `filter.manifest` check: `config/filter.ts` loads, and the clients in `app/generated/filters` match it (out of date, missing or orphaned → run `make:filter-client`). New `@adonis-agora/filter/doctor` entry for `--no-boot`.
