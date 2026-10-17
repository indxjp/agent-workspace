# ADR-W9-FILES-131 — `renameFilesByPrefix`/`deleteFilesByPrefix` are optional on `ResourceCatalogRepository`

Status: accepted
Date: 2026-09-11
Decided by: W9-FILES-131 agent
Scope: `packages/core/src/db/repositories/resource-catalogs.ts`'s `ResourceCatalogRepository`
interface; every consumer of it across `apps/web`

## Context

This task's Owns globs are `packages/core/src/storage/**`,
`packages/core/src/db/repositories/resource-catalogs*.ts`, `apps/web/server/files/**`,
`apps/web/app/api/files/**`, and this task's own ADR/index files — nothing under
`apps/web/server/compose/**`. Adding `renameFilesByPrefix` and `deleteFilesByPrefix` as *required*
members of `ResourceCatalogRepository` broke `apps/web/server/compose/resource-loader.test.ts`'s
typecheck: that file builds a hand-rolled fake implementing the interface for its own narrower
purpose (loading an agent's assigned files/skills into a run) and has no reason to know about
subtree operations. That file is outside this task's declared globs, is not claimed by either
Wave 9.2 sibling (`W9-AUTH-118`, `W9-PROV-126`) per the Wave 9 plan's disjointness proof,
and belongs to a later wave's task (`compose/**` is `W9-PROJ-125`'s, Wave 9.4).

## Decision

The two new methods are declared **optional** (`renameFilesByPrefix?(...)`,
`deleteFilesByPrefix?(...)`) on the interface. The real, database-backed implementation
(`createDatabaseResourceCatalogRepositoryProvider`) always provides both — the optionality is a
type-level accommodation for narrower test doubles, not a behavioural gap in production. Every
call site this task owns (`moveSubtree`, the `DELETE`/`PATCH` routes in
`apps/web/app/api/files/[id]/route.ts`) calls them with `?.`, and this task's own test
(`resource-catalogs.test.ts`) asserts they are present on the concrete repository with a non-null
assertion, so the optionality never hides a real omission in the code this task ships.

## Alternatives considered

- **Make the methods required and edit `resource-loader.test.ts`'s fake to add stub
  implementations.** Rejected: that file is outside this task's Owns globs and not disjoint from
  the next wave's declared ownership of `compose/**`; touching it would be an undeclared
  out-of-bounds change for a capability that test has no need of.
- **Add the methods to a second, separate interface (`ResourceCatalogSubtreeRepository`) instead
  of `ResourceCatalogRepository` itself.** Rejected as more machinery than the problem needs: the
  real repository already implements every method on one interface, and a second interface would
  need its own plumbing through `withWorkspaceObjectStore`'s `catalog` parameter for no benefit
  over an optional field on the interface that already exists.

## Consequences

A future caller that type-checks against `ResourceCatalogRepository` cannot assume these two
methods exist without a null check or a non-null assertion — the same discipline this task's own
code already follows. Should a later task widen `resource-loader.test.ts`'s fake (or replace it
with the real repository), these two methods can be made required again with no change to this
task's own call sites, since they already tolerate an optional field.
