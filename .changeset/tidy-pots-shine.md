---
'@adonis-agora/filter': patch
'@adonis-agora/filter-client': patch
---

Declare a supported Node range in `engines` again, instead of one exact version.

Both packages shipped `"engines": { "node": "v26.7.0" }` — an exact version, and
plainly the output of `node -v`, leading `v` and all. Every consumer on any other
Node got an unsatisfied-engine warning on install, and anyone running with
`engine-strict` (or a package manager that treats it as fatal) could not install
at all. The pinned version was also higher than anything the project itself uses:
CI runs Node 22 and `.nvmrc` names Node 20.

`engines` states the floor the package actually supports, which is `>=20.6.0` —
the same range it declared before, and the one the rest of the Agora packages
use. Nothing about the code changed; this only stops a false incompatibility
signal.
