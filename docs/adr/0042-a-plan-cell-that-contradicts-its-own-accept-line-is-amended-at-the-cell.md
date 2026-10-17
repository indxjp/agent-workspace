# ADR-0042 — A plan cell that contradicts its own Accept line is amended at the cell, not reconciled by the task

**Status:** accepted
**Date:** 2026-09-06
**Scope:** programme
**Context:** W3-RT-01 stated a dependency it was forbidden to add, and was right to

## Context

Wave 3's `3a-1` cell asked W3-RT-01 to add `types.ts` *"carrying `RuntimeProfile` (§15.1) **with its
Zod schema**"*. The same cell's Accept line requires `pnpm typecheck` and `pnpm lint` to pass *"with
`packages/runtime` still declaring **no runtime dependencies**"*. `zod` is a runtime dependency, so
the cell asked for two things that cannot both be true.

W3-RT-01 shipped the interface, stated the dependency it would have needed, and did not add it. Its
verifier reproduced the contradiction rather than accepting the claim, and confirmed the three facts
that decide it:

* `docs/spec.md` §15.1 prints a plain `interface RuntimeProfile`. The section's only mention of Zod
  is a comment on the escape-hatch field — *"Validated per driver with Zod"* — which locates the
  validation **per driver**, and `packages/runtime` is the package that deliberately knows about no
  driver.
* Wave 3's own `3a-2` row for **W3-CP-06** already carries *"the §15.1 schema validated with Zod"*,
  in `apps/web` and `packages/core`.
* `packages/core/package.json` pins `zod` at `4.5.4` and is the only declaration of it in the
  workspace, so W3-CP-06 already has what it needs.

So the schema clause was in the wrong cell. Not ambiguous — duplicated, and duplicated into the one
package whose defining property is that it depends on nothing.

## Decision

**A task that finds its cell contradicting its own Accept line states the contradiction and stops.
The orchestrator amends the cell. The task does not reconcile it in code.**

The amendment here removes the schema clause from `3a-1` and says so in the cell, leaving the Zod
schema with W3-CP-06 where the plan had already put it. The Wave 3 plan's `3a-1` cell now
reads *"as a plain TypeScript interface — **not** a Zod schema"*, naming this record.

The general rule this instance settles: **when a cell's prose and its Accept line disagree, the
Accept line is the criterion and the prose is the defect**, because the Accept line is the thing a
command evaluates. Amend one of them at the plan and never both, and never let the task choose.

## Why not let the task decide

Both reconciliations available to W3-RT-01 were defensible and both were wrong:

* Add `zod` — satisfies the prose, silently reverses a decision recorded in `driver.ts`'s own header
  and in `docs/adr/W1-RN-02-runtime-driver-is-generic.md`, and breaks the condition
  [ADR-0041](0041-a-later-wave-level-that-declares-no-dependency-change-may-run-concurrently.md)
  runs this task under.
* Hand-roll a validator with no dependency — satisfies both lines textually while shipping a second
  schema language into a package that the spec never asked to validate anything, which W3-CP-06 would
  then have to either use or contradict.

This is the shape [ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
recorded one level up: all four of sub-wave 2b-1's tracks hit the same underspecified rule and two
resolved it in opposite directions, both defensibly. A rule that two careful readers resolve in
opposite directions is not a rule, and the fix is upstream of the readers.

## Consequences

* `packages/runtime` keeps its no-dependency property, which is both W3-RT-01's acceptance criterion
  and ADR-0041's concurrency condition, rather than losing it to a clause in a sibling sentence.
* W3-CP-06 owns the Zod schema unambiguously, in a package where `zod` already resolves.
* "I need something my Accept line forbids" becomes a **reportable state with a defined resolution**
  rather than a judgement call. A task in that state is not blocked and not failing: it ships what it
  can, declares the rest, and the plan moves.
* The cost is a round trip through the orchestrator. That is the point — the alternative is two tasks
  discovering the same contradiction and resolving it differently, which is more expensive and is
  only found at integration.
