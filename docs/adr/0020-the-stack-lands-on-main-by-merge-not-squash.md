# ADR-0020 — The stack lands on `main`, by real merges rather than squash

Status: accepted — reverses [ADR-0001](0001-no-merge-to-main-wave-integration-branches.md); Superseded by [ADR-0149](0149-main-requires-a-pull-request-and-the-ci-success-gate.md)
Date: 2026-09-03
Decided by: Owner (this session)
Scope: whole programme

## Context

[ADR-0001](0001-no-merge-to-main-wave-integration-branches.md) recorded the Owner's decision that
nothing merges to `main` and each wave ends in an `aw/w<n>-integration` branch. The orchestrator
objected at the time — plan §6.0 requires a wave to open only after the previous stack is merged, and
§8.4 caps stack depth at 5 — and the Owner reaffirmed. Wave 1 reached a base-chain depth of **9** with
23 open PRs, and the projection for eight more waves was 25–30.

The Owner has now reversed it: *clean up `main`*, clarified as *take the open PR count to zero by
reviewing, fixing and merging, repeatedly*.

The second question is **how**. Plan §8.6 says "squash-merge each PR". That rule was written for a
stack of four or five. Against 23, squash is actively harmful: a squash puts a **new** commit on
`main` whose content matches the branch but whose identity does not, so every branch above it stops
being a descendant of its own base and must be restacked. Landing 23 PRs by squash is 22 restacks,
each with its own conflict surface — and Wave 0 spent five rounds demonstrating what a restack
cascade costs when anything below moves.

A real merge does not have that property. After `main` merges a branch, `main` **contains that
branch's commits**, so the next PR up is already based on an ancestor of `main`: retarget, and it is
mergeable. No rebase, no conflict, no lost history.

## Decision

1. **Land the whole stack on `main`.** ADR-0001's regime ends. The open PR count goes to zero.
2. **Bottom-up, one PR at a time**, in stack order: review → fix what blocks → merge → retarget the
   next → repeat. The review is the point; a mechanical land would skip it.
3. **Real merges, not squash.** §8.6's squash rule is deviated from, deliberately and recorded here.
   Each PR keeps its own commits, and every commit already carries its task id, its co-author trailer
   and its session link, so the audit trail survives intact — arguably better than a squash would
   preserve it.
4. **`main` may not carry a red gate.** A PR whose CI is red for a reason fixed *higher in the same
   stack* (the case for #21–#25 under [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md))
   may land, because the fix arrives in the same landing sequence. A PR red for any other reason does
   not land until it is fixed.
5. **No branch is deleted without telling the peer session first** ([ADR-0014](0014-concurrent-sessions-on-one-repository.md)).
   Branch deletion is what turned a policy divergence into a structural break the first time.

## Alternatives considered

- **Fast-forward `main` to the tip in one push.** `main` *can* do this today: 111 commits, no
  conflicts, every PR head already an ancestor, and GitHub would mark all 23 merged. Rejected because
  the Owner asked for review-fix-merge and a fast-forward skips the review entirely. Kept documented
  as the lossless fallback if the sequential landing runs into real trouble.
- **Squash each PR, per §8.6 as written.** Rejected on cost: 22 restacks for no gain in history
  quality, since the commits are already clean and attributed.
- **Keep ADR-0001 and land nothing.** No longer available — the Owner reversed it. Recorded because
  ADR-0001 should be read together with this record, not replaced by it.

## Consequences

- ADR-0001's stated consequence that "`main` never carries working code" is now void. It was already
  inaccurate for two commits ([ADR-0011](0011-unauthorised-agent-merges-and-the-restack.md)); it is
  now void by decision.
- `main`'s history becomes a merge-commit chain rather than a linear sequence of squashes. `git log
  --first-parent` reads as one commit per landed PR, which is what a squash would have given, while
  the full log keeps every task's own steps.
- The peer session's standing instruction is *do not merge, keep updating the PRs one at a time*,
  which came from the same Owner. It has been notified. If the two instructions genuinely conflict,
  that belongs in front of the Owner rather than being resolved by whichever session acts first —
  the lesson ADR-0011 was written to record.
- Waves 2–8 return to the plan's intended shape: each opens on a clean `main`, and §6.0 and §8.4
  become satisfiable again. That is the real gain, and it is larger than the landing cost.
