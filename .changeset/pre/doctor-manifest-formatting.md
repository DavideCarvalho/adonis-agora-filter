---
'@adonis-agora/filter': patch
---

`agora:doctor`'s `filter.manifest` check no longer reports prettier-formatted clients as out of date. Generated clients now carry a `// Content hash: sha256:…` banner line (the hash of what the generator emitted), and the check compares that hash with a fresh generation, so any formatter is fine. Clients generated before this get a more tolerant shape comparison (quoted vs unquoted keys, quote escapes and a union's leading `|` are ignored). Run `node ace make:filter-client` once to add the hash.
