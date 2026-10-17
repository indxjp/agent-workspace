# ADR-0001 — The trunk does not advance; waves stack on integration branches

Status: accepted
Date: 2026-09-03
Decided by: Owner (this session), after the orchestrator raised the objection below
Scope: whole programme

## Context

Plan §6.0 says a wave opens only when the previous wave's stack is **fully merged to `main`**,
and §8.4 caps stack depth at 5 because "depth is a review-latency multiplier". Plan §8.6 makes
merging a human act.

The Owner decided not to merge anything to `main`. The orchestrator stated the objection before
the decision was taken: with ~80 tasks across nine waves and no merges, the branch chain grows
without bound and §6.0 is violated on its face. The Owner reaffirmed the decision.

## Decision

`main` stays at the specification commit. Each wave ends by creating an **integration branch**
`aw/w<n>-integration`, which merges that wave's branches together. The next wave bases on it.

    main
     └── aw/w0-01-monorepo → aw/w0-02-ci → aw/w0-03-governance ─┐
     └── aw/research/r-01 … r-16 ───────────────────────────────┴→ aw/w0-integration
                                                                     └── aw/w1-01-… (wave 1)

Every PR still targets its immediate parent, so each review diff remains one task wide.

## Alternatives considered

- **Merge each all-green stack to `main`** (plan §8.6's "authorised batch merge"). Rejected by
  the Owner. It is what the plan assumes, and it is the only option under which §6.0 holds.
- **One branch per wave, no intra-wave stacking.** Rejected: it collapses each wave into a
  single unreviewable diff, which is the thing §2.2 exists to prevent.

## Consequences

- Base-chain depth is now **per wave (≤9)**, not per task (~80). Within a wave it stays ≤5.
  This is the mitigation that makes the decision survivable; without it the decision is not.
- Restack pressure stays low **only because merged-out waves are frozen**. The moment a landed
  wave's branch is amended, every wave above it must restack. Treat a closed wave as immutable.
- `main` never carries working code, so no reader can `git clone` and get a build. The
  integration branch tip is the de-facto trunk and must be named in the README.
- Plan §6.0 and §8.4 are formally deviated from. Recorded in every wave manifest.
- Reversing this is cheap early and expensive late: merging the chain to `main` at wave 3 is
  routine; at wave 8 it is a day of conflict resolution.
