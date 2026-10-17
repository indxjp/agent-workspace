# W1a-INT — A gate that asserts a closed world over files it does not own breaks on the union

Status: accepted
Date: 2026-09-03
Decided by: W1a integrator
Scope: the Wave 1a integration branch `aw/w1a-integration`; binding on how a wave integrator
handles a cross-task gate failure

## Context

Five W1a track tips merged into `aw/w1-02b-deps` with **no file claimed twice**. Every conflict was
in a generated file (`docs/adr/README.md`, five times) and was resolved by re-running
`docs/adr/regenerate-index.sh`, exactly as [ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md)
rule 3 and [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) require. `pnpm typecheck`,
`pnpm lint`, `pnpm format:check`, the licence gate and the ownership checker's self-test all pass on
the union, and 576 of 583 tests pass against a real PostgreSQL 17.11.

The seven that fail are all one defect, committed independently by three different tasks:

```
$ TEST_DATABASE_URL=… pnpm test
 Test Files  3 failed | 25 passed (28)
      Tests  7 failed | 576 passed (583)
```

| The gate | Owner (PR) | What breaks it | Owner (PR) |
| --- | --- | --- | --- |
| `apps/web/server/runs/routes.test.ts` — 3 failures | W1-CP-04 (#18) | `apps/web/app/api/agents/route.ts`, `apps/web/app/api/agents/[id]/route.ts` | W1-CP-05 (#15) |
| `tests/route-inventory.test.ts` — 2 failures | W1-CP-05 (#15) | `apps/web/app/api/runs/**`, `apps/web/app/api/agents/[id]/runs/route.ts` | W1-CP-04 (#18) |
| `tests/no-sdk-import.test.ts` — 2 failures | W1-RN-01 (#14) | `apps/web/server/runs/acceptance/{nginx.conf,run-acceptance.mjs}` (W1-CP-04, #18) and `tests/route-inventory.test.ts` (W1-CP-05, #15) | W1-CP-04, W1-CP-05 |

Every one of these gates is *correct in isolation* and every one passed CI on its own PR. Each is
also, by [ADR-0015](0015-gates-decide-on-positive-assertions.md), a **positive** assertion — which
is precisely why it fails closed here instead of quietly passing. That is the good outcome. The
defect is not that they failed; it is that their assertion is scoped to the **whole repository**
while their author's authority is scoped to one glob set.

`tests/route-inventory.test.ts` is the interesting one, because W1-CP-05 saw this coming and left
the handoff in the failure message itself:

```
AssertionError: these route handlers exist but are not declared in EXPECTED_ROUTES.
Some of them are already declared with landed: false —
  POST /api/agents/:id/runs — set landed: true (owner W1-CP-04)
  GET /api/runs/:id/events — set landed: true (owner W1-CP-04)
```

So one of the three is a two-word data edit whose author asked for it to be made. The temptation to
make it is exactly the reason this record exists.

## Decision

**The integrator reports these, names both tasks, and does not repair any of them.** The Wave 1a
integration branch is pushed red, with the failing output pasted in the manifest and the PR body.

Reasons, in order of weight:

1. **Plan §8.7 says a cross-track failure is an ownership question, not a merge question.** The
   integrator's brief is explicit: resolve conflicts only in files nobody owns, and report the rest
   naming the two tasks involved. All three files here have an owner, and each owner's PR is open
   and still being repaired.
2. **Editing another task's gate is the failure mode the whole ownership regime exists to stop.**
   The edit to `route-inventory.test.ts` is two words; the edit to `routes.test.ts` is a scope
   narrowing that changes what the gate *asserts*, and W1-CP-04 wrote that assertion deliberately
   ("creates nothing else under the agents tree, which belongs to W1-CP-05 (ADR-0013)"). An
   integrator who silently weakens a sibling's gate has removed a control nobody agreed to remove,
   and it lands in a merge commit where no reviewer of that task will ever see it.
3. **A green integration branch produced by editing three tasks' tests would be a false green.** It
   would report "the four tracks compose" on the strength of the integrator having changed the
   evidence.

## Alternatives considered

- **Flip `landed: false` → `true` in `route-inventory.test.ts` only**, on the grounds that its own
  failure message asks for it. Rejected, narrowly, and it is the closest call here: a message
  written by one task cannot grant another task write access to its file, and accepting a
  self-issued grant is the mechanism by which ownership becomes advisory. The right route is
  W1-CP-05's next round, which is one line and which its author has already scripted.
- **Add the three fixes in the integration merge commits.** Rejected outright: the change would be
  invisible on the owning PRs and would defeat the ownership gate's audit value.
- **Skip or `.skip` the seven tests on the integration branch.** Rejected: that is
  ADR-0015's failure-open shape wearing an integrator's hat. A suppressed gate reports the same
  green as a passing one.
- **Declare a wider `Owns` line covering the three test files and repair them here.** Rejected: the
  globs would intersect three open siblings' declarations, which is the one property
  [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) condition 1 makes
  non-negotiable.

## Consequences

- **The Wave 1a integration PR is red and stays red until three other PRs land a fix.** W1b builds
  on this branch, so W1b starts on a branch with seven known-failing tests. That is a real cost and
  it is why the failures are enumerated by owner in the Wave 1a manifest rather than
  summarised.
- **Three tasks now have work they did not know about.** W1-CP-05 (one data flip), W1-CP-04 (narrow
  three assertions to `apps/web/app/api/runs/**` plus its own `agents/[id]/runs`), W1-RN-01
  (classify `.conf`, and decide `createRequire` in a fixture and a non-literal `import()` in a
  sibling's test).
- **A second, separate cross-task defect was found the same way** and is reported the same way:
  `tests/route-inventory.test.ts` (W1-CP-05) and `tests/auth.test.ts` (W1-CP-06) are in one Vitest
  project and each scans the `apps/web/app/api` directory the other mutates. It is not a
  closed-world assertion — it is a filesystem race — but the reason it is reported rather than
  repaired is identical. See FINDING 5 in the Wave 1a manifest.
- **The general lesson, for every later wave.** A gate may assert a closed world only over the files
  its task owns. Over anything wider it must assert a *containment* property — "no file outside my
  globs imports the SDK", "every route I declare exists" — because the complement of a set the
  author does not control is not a set the author can enumerate. All three of these gates would have
  survived the union unchanged if they had been written that way, and all three would still have
  caught what they were written to catch.
