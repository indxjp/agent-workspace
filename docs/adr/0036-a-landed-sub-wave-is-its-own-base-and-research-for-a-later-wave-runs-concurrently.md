# ADR-0036 — A landed sub-wave is its own base, and research for a later wave runs concurrently with the current one

Status: accepted
Date: 2026-09-05
Decided by: orchestrator, on restarting the programme after sub-wave 2a landed
Scope: the Wave 2 plan's sub-wave table; the scheduling of the development plan §5.2 research

## Context

Two scheduling questions came up together on restarting, and both have the same shape: the plan's
text describes a situation that no longer holds.

**First.** `W2-plan.md`'s sub-wave table gives 2b-1 the base `2a tip`, and the stack diagram draws it
under `aw/w2-03-inventory`. That was correct while 2a was in flight. 2a has since landed:
`git merge-base --is-ancestor origin/aw/w2-03-inventory main` succeeds, so every commit the diagram
puts above 2b-1 is now reachable from `main`. Branching 2b-1 from `aw/w2-03-inventory` would build a
stack whose entire lower half is already merged — which is exactly the shape
[ADR-0020](0020-the-stack-lands-on-main-by-merge-not-squash.md) had to clean up at the end of 2a by
retargeting five PRs and closing them unmerged.

**Second.** §5.3 schedules research ahead of the wave it blocks, and §5.1 rule 1 lands each note "at
the bottom of the stack that depends on it". Waves 3 and 4 are blocked on four notes that do not
exist: R-02, R-14, R-04 and R-05. Read as a sequence, that means Wave 3 cannot begin until Wave 2
closes, and its research cannot begin until then either — two serial waits for work that touches no
file any other task touches.

The research notes and their fixtures are disjoint from every product glob in
Wave 2 by construction, and 2a already demonstrated the point: 2-R ran R-06 and R-12 concurrently
with 2a's foundation tasks, on branches sitting directly on `main`, and produced no interaction at
all.

## Decision

**A sub-wave that has landed on `main` is represented by `main`.** 2b-1's three tracks branch from
`origin/main`, not from `aw/w2-03-inventory`. The stack diagram in `W2-plan.md` describes the shape
at dispatch time and is not re-read afterwards as an instruction.

**Research for a later wave runs concurrently with the current wave, on branches based on `main`.**
R-02, R-14, R-04 and R-05 are dispatched alongside sub-wave 2b-1. §5.1 rule 1's "bottom of the stack"
is satisfied by landing on `main` before the consuming wave opens, which is what "bottom" means once
the intervening waves have merged.

**A track already in flight is not restarted to fit a workflow boundary.** W2-CP-02 (secrets) was
dispatched as a standalone agent before this session moved to the `Workflow` form, so it stays where
it is and the 2b-1 workflow covers the other three tracks. Its `Owns` globs —
`packages/core/src/secrets/**`, `apps/web/server/secrets/**`, `apps/web/app/api/secrets/**` — are
disjoint from all three, which is the only property that decides whether two tasks may run at once
(plan §2.3). The dispatch mechanism is not that property. Its verifier joins the same repair round as
the other three.

## Consequences

- 2b-1's four PRs each target `main` directly, so there is no stack to restack and landing is four
  independent merges rather than a cascade.
- The four research notes land on `main` during Wave 2, so Waves 3 and 4 open with their PL-2
  dependencies already satisfied instead of paying a serial research wait each.
- The `Owns`-disjointness check remains the single gate on concurrency. It is run mechanically —
  `node scripts/check-wave-ownership.mjs <Wave 2 plan>` — and is a CI gate, so "these tracks
  are disjoint" is never an assertion in prose.
- The sub-wave table in `W2-plan.md` now disagrees with what was executed. Per plan §2.1 the record
  of what actually ran is authoritative; this ADR is that record, and the manifest will repeat it.

## Alternatives rejected

**Branch 2b-1 from `aw/w2-03-inventory` as the diagram draws it.** Produces a stack whose lower half
is already in `main`, which cost 2a a retarget-and-close pass over five PRs.

**Hold the research until Wave 3 opens.** Serialises two things that share no file. §5.3's own
reasoning for scheduling research early is that a wrong assumption is cheapest to fix before the code
that consumes it exists — which argues for earlier, not later.

**Cancel W2-CP-02 and re-dispatch it inside the workflow for uniformity.** Discards live work to make
a diagram tidy. Uniformity of dispatch mechanism is not one of this programme's invariants;
disjointness of ownership is.

## Related

- [ADR-0023](0023-wave-2-owns-globs-are-derived-and-the-wave-is-split.md) — why Wave 2 is split into
  sub-waves at all.
- [ADR-0034](0034-an-integration-branch-is-built-from-main-not-from-the-top-of-the-stack.md) — the
  matching rule for the integration branch: built from `main`, merging every branch.
- [ADR-0020](0020-the-stack-lands-on-main-by-merge-not-squash.md) — why a branch already an ancestor
  of `main` is closed rather than merged again.
