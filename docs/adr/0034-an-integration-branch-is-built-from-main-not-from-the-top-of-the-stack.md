# ADR-0034 — An integration branch is built from `main` and merges every branch; branching it from the top of the stack makes most of its files unattributable

Status: accepted
Date: 2026-09-05
Decided by: orchestrator, after the ownership gate ran on an integration branch for the first time
Scope: how a wave integration branch is constructed; the wave plans' stack diagrams

## Context

Sub-wave 2a's integration branch was created by branching from `aw/w2-03-inventory` — the top of the
stack — and merging in the three branches that were not already below it. That is the obvious
construction, it produced a genuinely green union (925 tests passed, one union failure found and
fixed), and it cannot pass the ownership gate.

`--integration` mode attributes each changed file to the **merge parent that introduced it**. A
branch reached along the *first-parent* path is not a merge parent, so everything `aw/w2-00-plan`,
`aw/w2-01-schema`, `aw/w2-02-repositories` and `aw/w2-03-inventory` contributed arrives with no
parent to attribute it to:

```
FAIL: 57 file(s) this merge cannot account for:
  migrations/0001_w2_resources.sql — no merged parent introduced it and it is
    outside the integrator's own Owns globs
  docs/adr/W2-INT-00-…md — no merged parent introduced it and it is outside …
```

The gate is right and the branch shape is wrong. The only ways to make that shape pass are to
declare fifty-seven files the integrator did not write — a false declaration — or to turn the gate
off for integration branches, which is the hole `--integration` exists to close.

Two further facts made this expensive to find, and both are worth recording:

* **The gate had never run on an integration branch.** CI hardcoded `--pr`
  ([ADR-0033](0033-the-ownership-gate-mode-is-selected-by-the-pr-body-not-by-the-commit-shape.md)),
  and before that the job aborted at `Test`, so the step never executed. Wave 1a's integration branch
  landed without this check ever running.
* **A restacked branch appears as a merge parent at several commits**, and a declared ref resolves
  only to its current tip, so the older tips must be declared by SHA. That is a real wrinkle, not a
  mistake, and it is recorded as a gap below.

## Decision

1. **An integration branch is created from `main` and merges every branch of the wave as a second
   parent** — including the ones that sit on the first-parent path of the stack. Then every file has
   a parent to be attributed to, and the integrator declares only what it wrote itself.
2. **The wave plan's stack diagram says so.** The Wave 2 plan shows the integration branch
   hanging off the top of the stack, which is what was built. It is amended.
3. **The integrator's own globs cover only integration-level work** — the union fix, its ADR, and the
   generated index. If an integration-level fix must change a file a merged branch owns, that file is
   declared by the integrator with the reason, and the ownership passes to the integration level for
   that change ([ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md)).
4. **The union evidence already gathered stands.** The green union was measured on a real tree with
   the same content; rebuilding changes the branch's shape, not its result. It is re-run rather than
   assumed, but it is not re-derived from scratch.

## Alternatives considered

* **Declare the 57 files in the integrator's `Owns` line.** Rejected: the integrator did not write
  them, the declaration would be false, and it would make the integration branch a place where any
  file can be changed without attribution — precisely the hole this mode closes.
* **Skip the integration branch and land the stack bottom-up.** Tempting, and it is how Wave 1
  landed. Rejected because `W2-INT-02`'s §42 fix is only *correct* in the presence of both
  `aw/w2-04-sdk-probe-set` and `aw/w2-r-06-mcp`: on either branch alone its classified-package set
  equality has nothing to match. The union is where that change belongs, so the union must exist.
* **Exempt integration branches from the gate.** Rejected for the reason the mode was written.

## Consequences

* Rebuilding costs one cycle. The alternative was a false declaration, which costs a gate.
* The rebuilt branch has seven merge parents rather than three, so its PR body carries seven `Merged`
  lines. That is longer and it is also a more honest description of what the branch is.
* **Declared gap:** a branch restacked more than once appears as a merge parent at several SHAs, and
  the gate resolves a declared ref to its current tip only, so historic tips must be declared by SHA
  with a note. Building from `main` reduces but does not eliminate this, because the stack's own
  base-into-branch merges remain in the range. Worth fixing in the script — match a declared ref to
  any commit reachable from it — when a task next owns that file.
