# ADR-0033 — CI selects the ownership gate's mode from the PR body's own declaration, never from the commit shape

Status: accepted
Date: 2026-09-05
Decided by: orchestrator, after W2-INT-02 escalated rather than editing `.github/**`
Scope: `.github/workflows/ci.yml`, the File-ownership gate step

## Context

`scripts/check-file-ownership.mjs` has two modes. `--pr` compares one diff against one declaration.
`--integration` exists because, in the script's own words, *"a wave integration branch cannot pass
`--pr`: its diff carries every file every merged branch touched"*. Integration mode attributes each
changed file to the merge parent that introduced it, and requires the PR body to carry one
`Merged <ref>: <globs>` line per merged branch, repeating the globs that branch declared on its own
PR. That is what makes it a check rather than an exemption — a file no parent introduced and the
integrator did not declare still fails, and the script's self-test asserts exactly that.

`.github/workflows/ci.yml` hardcodes `--pr`. So the mode built for integration branches has never
run in CI, and PR #42 — the 2a integration branch — cannot go green no matter what it declares.

Two details make this worth a record rather than a one-line edit:

* **It was masked.** On every earlier run of that branch the ownership step never executed, because
  the job aborts at `Test` and `Test` was red on the §42 union failure. Fixing that failure is what
  revealed this one. A gate that never ran told nobody it never ran.
* **W2-INT-02 escalated instead of editing `ci.yml`.** That file is outside its globs, and the fix
  is a decision rather than a mechanical change. It also declined to widen its own `Owns` line to
  swallow the merged files, on the grounds that the declaration would be false. Both were right.

`W0-INT-01` had already rejected the obvious selector, and its reasoning still holds: deciding mode
by asking *"does this commit have two parents?"* makes the gate's own off switch a property any
author can produce with a merge commit.

## Decision

1. **CI selects the mode from the PR body: a body carrying at least one `Merged <ref>:` line runs
   `--integration`; every other body runs `--pr`.** The declaration lives in the same section as the
   `Owns globs:` line, written by the same author, and read from the same place the gate already
   reads.
2. **This is not the rejected selector, and the difference is the direction of trust.** The commit
   shape is a *fact about history* that an author can produce incidentally; the `Merged` lines are a
   *claim about ownership* the author must state and which the gate then checks against the real
   merge parents. Selecting `--integration` therefore cannot weaken anything: every file must still
   be attributed to a ref that genuinely introduced it, and a fabricated `Merged` line for a ref that
   introduced nothing buys nothing.
3. **A body CI cannot read is a hard failure, not a fallback to either mode.** Absence of a body is
   not absence of risk ([ADR-0015](0015-gates-decide-on-positive-assertions.md)), and this gate has
   already shipped that exact bug once — a missing PR body skipped the ownership check and exited
   zero.
4. **The step says which mode it chose, in its output**, so a reader of a green run can see which
   check ran. A gate that silently picks between two strictnesses is one nobody can audit.

## Alternatives considered

* **A branch-name pattern (`aw/*-integration`).** Workable, and rejected as the weaker of two
  declarations: a branch name is not part of the review surface, and it drifts from the body that
  states what was merged. The `Merged` lines have to be correct anyway for the gate to pass.
* **A GitHub label.** Same objection, plus it lives outside the repository, so the history of a
  landed PR does not record which check ran.
* **Auto-detect two parents.** Rejected by W0-INT-01 and still rejected, for its reason.
* **Leave `ci.yml` alone and let integration PRs land red.** Rejected: a red gate on the branch that
  merges every other branch is the one place ownership most needs checking, and a habitually red
  check is one nobody reads.

## Consequences

* Two of the workflow's steps now read the PR body; both must handle its absence by failing.
* An integration PR that forgets its `Merged` lines gets `--pr` and fails loudly with a diff it
  cannot possibly declare. That is the right failure — noisy and unambiguous — but the message will
  point at the globs rather than at the missing declaration, which is worth improving when someone
  next owns that script.
* Wave 1a's integration branch landed without this ever running. Nothing is known to be wrong with it;
  what is now known is that it was not checked. Recorded rather than assumed away.
