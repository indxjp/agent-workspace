# W0-INT-01 — An integration PR declares the union of the branches it merges

Status: accepted
Date: 2026-09-03
Decided by: W0-INT-01 (Wave 0 integrator)
Scope: every `aw/w<n>-integration` PR, for as long as [ADR-0001](0001-no-merge-to-main-wave-integration-branches.md) stands

## Context

[ADR-0001](0001-no-merge-to-main-wave-integration-branches.md) ends each wave with an integration
branch. Plan §2.3, enforced by `scripts/check-file-ownership.mjs --pr`, requires that a PR's diff be
a subset of the `Owns globs:` line in its body. The two collide by construction: an integration PR's
whole purpose is to carry files that other tasks wrote and that its own task card does not own.

Concretely, this PR's task card owns `docs/adr/**`, and `git diff aw/w0-03-governance...HEAD` lists
five files under `docs/research/` that came in from the four research branches. The checker has no
notion of a merge commit — it diffs base to head and compares paths — so it fails this PR unless the
declaration accounts for them. Neither the plan nor the spec says what an integration PR declares.

## Decision

**An integration PR declares the union of its own task's globs and the globs of every branch it
merges, and its `## Declared gaps` section names which globs are merged-in rather than authored
here.** No change is made to the checker.

For this PR the union is `docs/adr/**` (authored here) plus `docs/research/**` (merged verbatim from
`aw/research/r-01`, `r-13`, `r-15`, `r-16`, each already reviewed on its own PR).

## Alternatives considered

- **Exempt integration PRs in the checker** — skip `--pr` when the head commit has two or more
  parents. Rejected: it turns "is this a merge?" into the gate's off switch, and a merge commit is
  trivially manufactured. It also removes the gate from precisely the PR that carries the most files.
- **Diff against the merge base of every parent instead of the base branch.** Rejected as the right
  answer implemented at the wrong time: it is a real change to the checker's semantics, `.github/**`
  and `scripts/**` are outside this task's ownership, and an integrator editing the gate it is being
  judged by is the conflict of interest §2.3 exists to prevent.
- **Declare `docs/**` and be done.** Rejected: it is wider than what actually changed, so it would
  also pass a stray edit to `docs/spec.md` — which is exactly the accident an integration PR is most
  likely to make.

## Consequences

- The gate degrades on integration PRs from "this task stayed in its lane" to "these merges stayed in
  their lanes, combined". A file that a research branch wrote *outside* its own declared globs is
  invisible here; it is caught on that branch's own PR or not at all. Integration is therefore not a
  second line of defence, and should not be described as one.
- The declaration is assembled by hand, so it can be assembled wrongly. Mitigation is weak but real:
  the gate fails closed, so a union that is too *narrow* is caught by CI. A union that is too *wide*
  is caught only by a human reading the Ownership line against the merge list in "What changed".
- Every future wave integrator repeats this, and the union grows with the wave. By Wave 5 the
  Ownership line is long enough that nobody reads it, at which point the merge-base alternative above
  should be implemented properly by whoever owns `scripts/check-file-ownership.mjs`.
- If ADR-0001 is reversed and waves merge to `main`, integration PRs disappear and this record goes
  with them.
