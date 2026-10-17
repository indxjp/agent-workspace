# ADR-0041 — A later wave's level may run concurrently only when it declares no dependency change

**Status:** accepted
**Date:** 2026-09-06
**Context:** the orchestrator, dispatching sub-wave 2b-2 and Wave 3 at the same time

## Context

Sub-wave 2b-2 (`W2-CP-04` skills, `W2-CP-05` connectors) is in flight. Wave 3's research level is
already closed — research note R-02 and research note R-14
both landed on `main` — so Wave 3's first implementation level `3a-1` is unblocked *now*, and its one
task `W3-RT-01` owns only files under `packages/runtime/`, which no 2b-2 task can reach.

[ADR-0036](0036-a-landed-sub-wave-is-its-own-base-and-research-for-a-later-wave-runs-concurrently.md)
already permits a later wave's *research* to run concurrently off `main`. This record decides
whether the same is true of a later wave's *implementation*.

Disjoint `Owns` globs are not sufficient on their own. `pnpm-lock.yaml` has exactly one owner per
sub-wave ([ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md),
[ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md))
precisely because two independent regenerations of it conflict in a file nobody can hand-merge, and
the resolution rule for a generated file — re-derive rather than decide
([ADR-0037](0037-the-adr-index-is-generated-not-owned-so-a-conflict-in-it-is-resolved-by-regenerating.md))
— does not rescue it: running `pnpm install` again on a merged tree resolves the lockfile against
*both* manifests, which is only correct if both manifests were themselves correctly merged, and two
concurrent waves each holding the composition root is exactly the case where they were not.

## Decision

A level of a later wave may be dispatched concurrently with a running sub-wave when **all** of:

1. Its `Owns` globs are disjoint from every glob of every task in flight, checked against the plan
   files rather than remembered.
2. **It declares no dependency change** — no task in the level owns any `package.json`, and none may
   add one. A task that discovers it needs a dependency states it and stops, exactly as ADR-0038
   requires of a track that needs the composition root.
3. Its own wave's research level is closed, so it is not racing a fact it depends on.

`docs/adr/README.md` is exempt from (1): it is generated, and ADR-0037 already says a conflict in it
is resolved by regenerating on the merged tree.

`W3-RT-01` satisfies all three. Its plan cell independently requires that `packages/runtime` still
declare **no runtime dependencies**, so condition (2) is a criterion it must meet anyway rather than
a restriction concurrency imposes on it.

## Consequences

* Wall-clock across the remaining programme falls, without the lockfile risk that made ADR-0038
  necessary.
* The rule is checkable before dispatch and not after: (1) and (2) are read off the plan tables.
* It does **not** license running two integration levels concurrently. Two integrators both own a
  composition root and a manifest by construction, so condition (2) refuses that pairing outright.
* A concurrent level that turns out to need a dependency is not a failure of that task — it is the
  signal to serialise it behind the integrator that owns the manifest.
