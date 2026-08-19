# @adonis-agora/filter-client

## 0.2.1

### Patch Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-filter/pull/23) [`2bd4e7b`](https://github.com/DavideCarvalho/adonis-agora-filter/commit/2bd4e7baa50d3d0b4a25c834fc9edf612f7d854a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Refer to the package by its published name, `@adonis-agora/filter-client`.

  The package was renamed from `@agora/filter-client` to `@adonis-agora/filter-client`,
  but its own `description`, README and source comments still named the old scope —
  so the README's install line and first import example, the first thing a reader
  copies, could not resolve.

- [#23](https://github.com/DavideCarvalho/adonis-agora-filter/pull/23) [`2bd4e7b`](https://github.com/DavideCarvalho/adonis-agora-filter/commit/2bd4e7baa50d3d0b4a25c834fc9edf612f7d854a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare a supported Node range in `engines` again, instead of one exact version.

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

## 0.2.0

### Minor Changes

- Add `whereDynamic`/`sortDynamic` runtime escape hatches on the typed query builder for fields not known at codegen time.
