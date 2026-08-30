---
'@adonis-agora/filter': patch
---

Declare `@adonisjs/core` as a required peer, not an optional one.

The package's main entry point reads the ambient `HttpContext` (the Lucid macros and the
`Filterable` mixin both resolve the request context from AsyncLocalStorage when no `ctx` is
passed), so importing `@adonis-agora/filter` without `@adonisjs/core` installed failed at load
with `ERR_MODULE_NOT_FOUND` rather than warning at install. The peer now says what the code does.

`@adonisjs/lucid` stays optional and structural — the library talks to any `QueryBuilderLike`. A
new test walks the barrel's import graph and fails on any value import of `@adonisjs/lucid`, which
is the promise that *is* kept.
