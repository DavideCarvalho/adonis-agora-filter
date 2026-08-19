# Plan 001: `distinct` on a relation path emits SQL against a table nothing joined

> Read this plan fully before starting. Honor the STOP conditions. Verify every
> excerpt against the live file before acting.

## Status

TODO. Found by comparing `~/personal/oss/nestjs/nestjs-filter`'s July work against
this port. Aviary shipped three commits here (#74, #80, #82); **their fix does not
transfer**, because the two libraries translate relation paths in fundamentally
different ways. This is a design task, not a port.

## The bug

`resolveSafeDistinct` (`packages/core/src/runner.ts:253`) gates a distinct field on
`isAllowed` **and nothing else**:

```ts
for (const field of aliased) {
  if (isAllowed(field, config.allowed)) { … safe.push(field) }
```

and `isAllowed` (`runner.ts:39-43`) is:

```ts
if (allow === '*') return true;
if (typeof allow === 'function') return allow(field);
return allow.includes(field);
```

No check that the field is a column of the root table. So a dotted path passes, and
`applyDistinct` (`lucid_adapter.ts:441`) hands it straight to Lucid:

```ts
qb.distinct(...columns);   // → distinct "posts"."title"
```

Nothing joined `posts`. On Postgres that is
`missing FROM-clause entry for table "posts"`.

**This is reachable through the library's own documented features, not a misuse:**

- Relation-path *filtering* is supported and idiomatic — `applyLeaf`
  (`lucid_adapter.ts:323-330`) splits on the first dot and recurses into
  `qb.whereHas(relation, sub => applyLeaf(sub, rest, …))`. To use it you must
  whitelist `posts.title` in `allowed`.
- `filterableFieldPaths` (`generate_client.ts:64`) *enumerates relation paths up to
  `maxDepth`* into the generated client's field union, so the typed client offers
  `posts.title` as a field.
- `allowed: '*'` accepts everything unconditionally.

So a spec configured to filter by a relation column — the documented case — makes
`distinct=posts.title` a 500. **Verify this end to end before you fix anything**
(step 1): the advisor reasoned it from the code and did not execute it.

## Why aviary's fix does not transfer

Aviary's `applyDistinct` `leftJoin`s each hop and projects
`<alias>.<column> as "base.name"`. That works because MikroORM's relation filtering
*already* joins.

**Lucid's does not.** `whereHas` compiles to a correlated `EXISTS` subquery; the
relation never enters the outer `FROM`, so there is no alias to project. Copying
aviary here would mean introducing joins into a query builder whose relation
support is deliberately subquery-based — changing the row cardinality of every
query that uses it, and diverging from the idiom the rest of this adapter follows.

Do not do that on this plan's authority alone. Choose:

**Option 1 — reject, loudly.** A dotted distinct is refused: dropped with the
existing `throwOnInvalid` semantics honoured (throw when set, skip when not). Small,
honest, and strictly better than today's 500. Costs the feature.

**Option 2 — a `leftJoin` path used only for `distinct`.** Delivers the feature.
`leftJoin`, never `join` — an inner join drops rows with a null FK and turns a
projection into a filter. To-one hops only; a to-many hop multiplies rows, which is
not what a column-values lookup asked for. And it must compose with `whereHas`
filters on the same relation without double-counting.

**Recommendation: Option 1 in this plan.** It converts a 500 into a defined
behaviour, it cannot regress any working query, and it is verifiable without a
schema. Option 2 needs relation metadata this package does not currently read
(to-one vs to-many, the FK columns), which is a genuinely larger change and
deserves its own plan with the cardinality question examined properly. If you
believe Option 2 is small here, **STOP and make that case** rather than starting it.

Whichever you choose, `distinct` must never again emit an identifier the query has
no `FROM` entry for.

## What aviary added beyond the relation case — assess, do not build

- **#82 JSON sub-paths in `distinct`.** Needs an extract expression. Aviary
  explicitly *rejects* these on the path this plan touches.
- **#74/#82 to-many aggregate paths in `distinct`.** Depends on aviary's aggregate
  model.

Both are out of scope. Note in your report whether this package's `aggregate.ts`
(which merges aggregate fields into the `computed` map — see `aggregate.ts:136-137`)
gives distinct a cheaper route to the same result, since **computed fields are
already parenthesized unconditionally** in this adapter. That observation is the
useful deliverable, not an implementation.

## Current state

Read before editing:
- `packages/core/src/runner.ts:253-268` (`resolveSafeDistinct`), `:39-43`
  (`isAllowed`), `:366-371` (the distinct call site).
- `packages/core/src/lucid_adapter.ts:441` (`applyDistinct`), `:315-330`
  (`applyLeaf` and its docblock on relation hops), `:452` and `:465-478`
  (computed resolution and the unconditional `(${expression})` wrap).
- `packages/core/src/generate_client.ts:57-64` — `maxDepth` and
  `filterableFieldPaths`.
- `packages/core/test/distinct_pg.spec.ts` — the existing coverage: root scalar,
  alias resolution, disallowed field. **No relation path, no JSON sub-path.**
- `packages/core/src/aggregate.ts:130-145`.
- `docs/definitions/relations.mdx` — what is promised about relation paths.

## Commands you will need

```
cd /home/dudousxd/personal/oss/adonis/adonis-filter
export PATH=/home/dudousxd/.local/share/mise/installs/node/22/bin:$PATH   # NOT nvm; mise
pnpm typecheck && pnpm lint
cd packages/core && npx vitest run
```

`*_pg.spec.ts` files skip without a live Postgres (`describe.skipIf(!pgUp)`).
**Report whether they ran.** The relation case is exactly the one an in-memory mock
cannot prove, because the bug *is* the SQL the database rejects — so if you cannot
reach a Postgres, say so plainly and mark step 1 unproven rather than claiming it.

There are Postgres containers on this machine (`docker ps`); `adopt-oidc-pgvector`
on port 55433 has a full schema and pgvector, password via
`docker inspect` — **never print it**. Use it read-only or with throwaway tables.

**Measure the baseline yourself and report it.**

## Scope

**In scope:**
- `packages/core/src/runner.ts` — `resolveSafeDistinct`
- `packages/core/src/lucid_adapter.ts` — `applyDistinct`, only if your option needs it
- `packages/core/test/`
- `docs/` — the distinct page, if it promises something now untrue
- `.changeset/<generated>.md`

**Out of scope:**
- `applyLeaf` / `whereHas` relation filtering. Working and idiomatic; do not convert
  it to joins.
- Computed-field parenthesization. Already unconditional and correct — aviary's
  `EXISTS` fix (#85) has no counterpart here, and this plan is not the place to
  revisit it.
- JSON sub-paths and to-many aggregates in distinct.
- `generate_client.ts`'s emitted union.

## Git workflow

- **Main checkout**, currently `master` at `57d69a6`. **Create a branch
  `advisor/filter-wave-1` before touching anything.** Never commit to `master`.
- Do NOT push, merge or rebase.
- Commit the failing test separately from the fix.

## Steps

### 1 — Prove the bug, against a real Postgres

A spec whose `allowed` includes a relation path (as the relation-filter feature
requires), a request with `distinct=<relation>.<column>`, executed. Report the exact
database error.

If it does **not** fail — for instance because a `whereHas` in the same request
happens to bring the table into scope, or because Lucid quotes it into something
harmless — **STOP and report**. The plan's premise would be wrong and the fix would
be solving nothing. That has happened repeatedly in this audit; assume it can happen
here.

Also record what happens with `distinct` **plus a total/count**, which is where
aviary's equivalent bug got worse.

### 2 — State your option and reasoning

Before implementing. If you pick Option 2 against the recommendation, that is a STOP
— report the case.

### 3 — Implement

Option 1: `resolveSafeDistinct` refuses a field that is not a root-table scalar,
honouring `throwOnInvalid` exactly as the disallowed-field path already does. Match
the existing error type and message shape (`InvalidColumnFilterError`) — the message
must say *why* (a relation path cannot be projected without a join), because
"not distinct-able" alone will read as an allow-list problem and send someone to
edit their `allowed`.

### 4 — Regression guards, must pass before AND after

The three existing behaviours: root scalar dedups; alias resolves before the
allow-list; a disallowed field is dropped. Plus: a request with a relation-path
**filter** and a root-scalar **distinct** still works — that is the combination most
likely to break.

### 5 — Mutation

Revert your check → step 1's test fails while all four guards stay green. Report the
split. Restore; `git diff --stat` clean.

### Final

`pnpm typecheck`, `pnpm lint`, suite vs baseline, plus whether the `_pg` specs ran.

Changeset: **patch** if you rejected (a 500 becomes a defined refusal); **minor** if
you delivered projection. The text must tell a reader who has `distinct` working
today that nothing changes for them, and tell anyone passing a relation path what
they now get instead of a 500.

## Done criteria

ALL must hold:

- [ ] Step 1 reproduced the failure against a real Postgres, with the error quoted — or is explicitly marked unproven with the reason
- [ ] The `distinct` + count variant is reported
- [ ] Your option and its reasoning are stated before the implementation
- [ ] `distinct` can no longer emit an identifier with no `FROM` entry
- [ ] The error message explains the cause, not just the refusal
- [ ] All four regression guards passed BEFORE and AFTER
- [ ] The mutation produced the described split
- [ ] The aggregate/`computed` observation is reported (no implementation)
- [ ] `pnpm typecheck` and `pnpm lint` exit 0
- [ ] Suite ≥ baseline, 0 failed; `_pg` spec status reported
- [ ] Work is on `advisor/filter-wave-1`, not `master`
- [ ] No files outside the in-scope list modified

## STOP conditions

Stop and report back if:

- Step 1 does not reproduce.
- Rejecting relation paths breaks an existing test — that would mean something
  already depends on the behaviour, and the finding needs revising.
- You conclude Option 2 belongs in this plan.
- `isAllowed`'s function form makes "is this a root scalar column" undecidable
  without new configuration. Report the seam; do not invent a config key here.
- No Postgres is reachable. Do steps 2–5 anyway with the mock, and mark step 1
  unproven — but say it plainly in the report, not only in a comment.

## Maintenance notes

- **Two libraries, one feature, opposite bugs.** Aviary *dropped* the dotted
  distinct (wrong result, silently); this port *forwards* it (a 500). Same missing
  validation, different downstream. Worth remembering when diffing the two: a
  shared gap does not imply a shared symptom, and the fix that suits one adapter's
  relation model can be wrong for the other's.
- **The generated client is what makes this reachable.** `filterableFieldPaths`
  enumerates relation paths into the typed field union, so `distinct('posts.title')`
  type-checks. A union that offers a field the runtime cannot serve is the same
  declaration-vs-enforcement pattern this audit has now found nine times.
