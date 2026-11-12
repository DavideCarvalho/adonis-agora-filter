---
"@adonis-agora/filter": patch
---

`agora:doctor` now checks the generated clients wherever they live. Set `codegen.output` in `config/filter.ts` (`export const codegen = { output: 'inertia/generated/filters' }`): `make:filter-client` writes there by default (`--output` still overrides) and the `filter.manifest` check compares the clients there. Without `codegen.output`, clients generated elsewhere are found by their banner, checked, and the doctor asks you to set it; with no generated clients anywhere the check reports a skip naming the directory it looked in instead of passing silently.
