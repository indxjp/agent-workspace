# W1-INT-02 — The route inventory is the tracked tree, and the gate that asserts it writes nothing

Status: accepted
Date: 2026-09-03
Decided by: W1-INT-02 (Wave 1 invariants)
Scope: `tests/route-inventory.test.ts`, `tests/auth.test.ts`'s probe-set derivation; binding on any
later test that plants a file under `apps/web/app`

## Context

Two test files write real route handlers into `apps/web/app/api` while a third walks it, all in the
same Vitest project set and therefore in parallel workers.

- `tests/route-inventory.test.ts` planted `apps/web/app/api/agents/inventory-probe-…/route.jsx` with
  `mkdtempSync` for the duration of one test, to prove the gate sees a `route.jsx` Next.js would
  serve.
- `tests/auth.test.ts` writes `apps/web/app/api/w1cp06-unregistered/deep/route.ts` at collection time
  and removes it in `afterAll`, to prove a route registered nowhere is still refused, and builds its
  probe matrix by **walking** `apps/web/app/api`.
- `apps/web/server/runs/routes.test.ts` walked the same directory to assert a closed world over it.

The W1a manifest demonstrated both directions deterministically by planting each fixture by hand: the
auth suite's probe matrix grew by one path — two `it.each` cases — when it caught the inventory
gate's fixture, and the inventory gate reported `GET /api/w1cp06-unregistered/deep` as an undeclared
route when it caught the auth suite's. The second is a spurious *failure*, and it was masked only
because that gate was already red for the [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md)
reason.

The tempting repairs are both bad. Serialising the whole suite pays for one file's fixture with every
other file's parallelism. Teaching each gate the *names* of the other's fixtures is an exclusion list,
and an exclusion list is a hole the day someone adds a fixture and forgets to extend it.

## Decision

**1 — The route inventory is derived from `git ls-files -- apps/web/app`, not from a walk of the
working directory.**

The gate's claim is about the API surface this repository *ships*. A file written at run time and
never committed is not part of that surface, under any deployment, ever. So the membership rule is a
positive one — *the inventory is the committed route surface* — and it holds for every future test
fixture without this file learning a single fixture's name. It is the rule
[W0-INF-02](W0-INF-02-probe-set-derived-from-the-tracked-tree.md) already established and that
`tests/no-sdk-import.test.ts` already uses over the whole tree.

It fails closed in the two ways that matter: `git ls-files` returning nothing throws rather than
reporting an application with no routes, and a file that git tracks but the worktree lacks throws
rather than being skipped.

**2 — `tests/route-inventory.test.ts` writes nothing into the repository tree, and asserts that it
does not.**

The `route.jsx` probe is now a synthetic entry handed to the same two functions the live gate uses —
`filterRouteFiles` and `routeSurface` — so it proves exactly what it proved before about the code
that actually decides the inventory, with no file on disk. One test in the file greps the file's own
source for `writeFileSync`, `mkdtempSync`, `mkdirSync`, `rmSync`, `cpSync` and `renameSync` and fails
if any appears. That is what keeps this structural rather than a promise in a comment.

**3 — `tests/auth.test.ts` counts a discovered handler only if git tracks it or this test wrote it.**

Its walk stays a walk — it must find its own fixture on disk, and the assertion that it does is the
proof its acceptance criterion rests on. What changed is the membership rule, stated positively and
with the second half a list of exactly two files this test writes, which is a list a test can hold
about *itself*. A sibling's scratch file is neither tracked nor ours, so the probe matrix no longer
moves when anything else is running.

**4 — Both directions are closed on both sides, on purpose.** Either change alone would close only
one direction, which is what the W1a manifest said and why it routed the repair to two owners. Doing
both means neither file depends on the other's continued good behaviour.

## Alternatives considered

- **`fileParallelism: false`, or a Vitest project boundary between the two files.** Rejected: it
  makes every test in the repository pay, it does not survive `apps/web/server/runs/routes.test.ts`
  being in a different project from both of them, and it leaves the two files still coupled — the
  next fixture reopens it.
- **`mkdtemp` outside the walked root for the inventory probe** (the manifest's suggestion).
  Rejected as insufficient rather than wrong: it closes the direction where the inventory gate
  perturbs the auth suite and leaves untouched the direction where the auth suite's fixture is
  reported as an undeclared route.
- **Have each gate ignore paths matching the other's fixture pattern.** Rejected: an exclusion by
  name, which is the shape [ADR-0015](0015-gates-decide-on-positive-assertions.md) exists to stop.
- **Keep the working-directory walk and drop untracked files.** This is very nearly Decision 1, and
  it is what Decision 1 does — the difference is that asking git for the list, rather than walking and
  then filtering, means there is no code path in which an untracked file is ever considered.

## Consequences

- **A route file that exists but is not committed is invisible to this gate.** That is the point, and
  it is worth stating plainly: someone who writes `apps/web/app/api/thing/route.ts` and does not
  `git add` it gets a green gate locally. They also get an application that does not have that route
  anywhere but on their disk, and CI checks out a clean tree, so the file is not merely undeclared —
  it does not exist. The gate is asserting about the repository, and it now says so.
- **The `route.jsx` proof is one step further from the filesystem.** It exercises the filter and the
  surface derivation, not `git ls-files`. The live listing is covered instead by a positive
  assertion naming the five tracked route files, which fails if the listing shrinks for any reason.
- **`tests/auth.test.ts` now runs `git ls-files` once per call of its walker.** Three runs of that
  file on each side of the change are pasted on W1-INT-02's PR; the added cost is not distinguishable
  from run-to-run variance, because a `next dev` start-up dominates the file.
- **Any later test that plants a file under `apps/web/app` must add it to the walker's own-files
  list to be seen by that walker, and will never be seen by the inventory gate.** Both are the
  intended behaviour, and ADR-0019 §4 is the rule they follow.
