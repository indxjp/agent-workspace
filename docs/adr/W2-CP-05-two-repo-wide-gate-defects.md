# W2-CP-05 — Two repo-wide gates this branch cannot turn green, with counter-examples (ADR-0029)

Status: accepted
Date: 2026-09-06
Decided by: W2-CP-05 (implementer)
Scope: findings only. `tests/no-route-answers-503.test.ts` and `tests/route-inventory.test.ts` are
not in this task's `Owns:` globs and neither is edited here.

## Why this record exists

**Correction (round 2, B4):** the paragraph below originally quoted ADR-0029 with its test
inverted — *"a defect when you can build a tree the gate ought to **accept** and it **rejects**"*
— which is the wrong direction. ADR-0029's actual test, quoted correctly this time: *"A narrowing
is a defect if and only if a tree can be constructed that the gate ought to **reject** and,
because of that narrowing, **accepts**."* That is: a defect is a tree that SHOULD FAIL the gate
but the gate lets through — not the reverse.

So why did this record file two findings about gates that instead **reject a tree that ought to
pass** — the opposite shape from ADR-0029's own test? Because ADR-0029 states the minimum bar for
a *narrowing* finding: a gate that has grown too permissive (accepts a tree it should reject). It
does not say a gate that fails a *correct* tree is therefore not worth reporting — that is a
different defect (a gate too strict rather than too loose), and it is reportable on its own terms:
it blocks real, correct work with a false rejection, which is exactly as actionable as a false
acceptance, just in the other direction. (The orchestrator later named this precisely: ADR-0043 —
*"a repo-wide gate that refuses every correct implementation of a task in flight is a precondition,
not an integration item."*) Both findings below carry a counter-example that was produced and
run — `pnpm test`'s own failing output — which is the discipline ADR-0029 asks for regardless of
which direction the defect runs.

This task's own branch, green everywhere else (`pnpm build`, `pnpm typecheck`, `pnpm lint`, and
every other suite — see this task's PR report for the exact pass count `pnpm test` prints on this
round's run; ADR-0016: that number is pasted from the run, never transcribed here where it can go
stale again, which is exactly what happened to this sentence twice before), is that
counter-example for both gates below. Neither file is in this task's `Owns:` globs; both are
dispatch-shape and orchestration concerns, not implementation ones, so this task fixes neither and
instead leaves the reproducible finding where the next reader (W2-INT-02, or whoever amends the
gate) will trip over it.

**Update (round 2):** Finding 2 (`route-inventory.test.ts`) is now resolved on `main` under
ADR-0043 and is rewritten below as a record of what happened, per B6. Finding 1
(`no-route-answers-503.test.ts`) is unresolved and remains W2-INT-02's, per ADR-0038.

## Finding 1 — `no-route-answers-503.test.ts` hardcodes the ONE acceptable 503 gap as `W2-CP-06`, and cannot express "a second sub-wave shipped routes before its own integrator ran"

`GAP_OWNER = 'W2-CP-06'` (line 157) is a literal. The assertion at line ~417–426 requires the set
of routes answering 503 to equal **exactly** that one task's nine RBAC routes — correct for `main`
as W2-INT-01 left it, where sub-wave 2b-1 is fully wired and only RBAC's durable-directory gap
remains open (`docs/adr/W2-INT-01-the-rbac-routes-cannot-leave-503-without-a-durable-directory.md`).

It has no way to also say "and W2-CP-05's five connector routes, which this dispatch's own protocol
says correctly answer 503 until W2-INT-02 wires them" — the exact situation the Wave 2 plan
built an integrator-before-dispatch for, precisely because sub-wave 2b-1 shipped without one. This
task's dispatch protocol states plainly: *"Your routes will answer 503 until the integrator wires
you up, and that is the correct intermediate state."* This gate does not yet agree with that
sentence for any sub-wave after 2b-1.

**Counter-example, run and pasted (this task's own PR report has the full transcript):**

```
$ pnpm test
 FAIL  |tests| no-route-answers-503.test.ts > … > answers 503 on exactly the routes the declared gap accounts for
AssertionError: … expected […14 routes…] to deeply equal […9 routes…]
  [
    "DELETE /api/api-keys/:id (W2-CP-06)",
+   "DELETE /api/connectors/:id (W2-CP-05)",
    "DELETE /api/memberships/:id (W2-CP-06)",
    "GET /api/api-keys (W2-CP-06)",
+   "GET /api/connectors (W2-CP-05)",
+   "GET /api/connectors/:id (W2-CP-05)",
    …
+   "POST /api/connectors (W2-CP-05)",
+   "POST /api/connectors/:id/test-connection (W2-CP-05)",
    …
  ]
```

Every one of W2-CP-05's routes is correctly, honestly unwired — this is not a bug in the routes,
it is the gate not yet knowing a second sub-wave exists. This task's own `pnpm test` run (pasted in
full in this task's PR report) shows the five connectors 503s named by owner, exactly as intended.

**What the fix likely is, stated without making it here:** either `GAP_OWNER` becomes a set derived
from which owners' runtimes `apps/web/instrumentation.ts` does not yet install (read structurally,
the way this file already reads route declarations, rather than a literal), or the assertion is
scoped to "no route answers 503 for a reason nobody named" against a small per-sub-wave allowlist
W2-INT-02 supplies when it lands. Either is an ADR-0038/ADR-0040-shaped partition; this record is
the finding, not the fix, per this task's `Owns:` globs.

## Finding 2 — `route-inventory.test.ts`'s `routes.size >= EXPECTED_ROUTES.length` compared a fixed count against a growing one — RESOLVED on `main` under ADR-0043 (round 2 update)

**This finding is closed.** It is kept here, corrected, as the record of what happened — round 1's
own arithmetic for the bound was wrong (B6), and the record below states the corrected derivation
before describing the resolution, per ADR-0016 (a measured number is generated or absent, never
transcribed).

### The bound and why ADR-0026 made it false

`EXPECTED_ROUTES` (`tests/route-inventory.test.ts`, pre-ADR-0043) was
`unionRoutes(readDeclarationFiles(ROUTE_DECLARATIONS, 'routes'))` — every route **every task** has
declared, `mandate`-carrying ones included, and it grows every time a task ships a route spec §34
does not itself print (which ADR-0026 explicitly permits and expects, provided the route carries a
checkable `mandate`). `routes` (`specRoutes()`) parses `docs/spec.md` §34's own printed `Examples:`
code fence — a **fixed** count that does not grow as tasks add mandate-carrying routes, because
spec.md's own text is not amended by a Wave 2 resource task's PR. The assertion
`routes.size >= EXPECTED_ROUTES.length` therefore compared a number that only grows against one
that never does, and was certain to fail once enough mandate-carrying routes existed — regardless
of whether every one of them was correctly shaped and cited.

### The corrected derivation (measured, not transcribed)

Round 1's record said 35 was reached by "this task's five mandate-carrying routes … and the two
already-existing `api-keys`/`memberships` W2-CP-06 routes plus W2-CP-03's three `files` ones …
join the ones already declared." That is wrong on two counts: only three of this task's five
routes carry a `mandate` (`GET`/`POST /api/connectors` are printed by §34 and carry none), and the
api-keys/memberships/files routes it named were already inside the pre-existing 30 — they never
"joined" anything. The actual arithmetic, derived by command against this task's own tree:

```
$ for f in tests/route-declarations/*.ts; do echo "$f: $(grep -c 'method:' "$f")"; done
tests/route-declarations/W1-CP-04.ts: 3
tests/route-declarations/W1-CP-05.ts: 5
tests/route-declarations/W2-CP-02.ts: 3
tests/route-declarations/W2-CP-03.ts: 5
tests/route-declarations/W2-CP-05.ts: 5
tests/route-declarations/W2-CP-06.ts: 9
tests/route-declarations/W2-CP-07.ts: 5

$ grep -h -c 'method:' tests/route-declarations/*.ts | awk '{s+=$1} END {print s}'
35
```

35 = 30 (every other task's declared routes, unchanged by this PR) + this task's own 5 — not "the
30 already declared plus five mandate-carrying routes joining from elsewhere." 31 is
`docs/spec.md` §34's own, unchanging, printed count. Every other assertion in
`route-inventory.test.ts` — that every declared route is correctly shaped (ADR-0026 decision 3),
correctly mandated where §34 is silent, and correctly landed — passed on this branch throughout,
which is what made the size-comparison failure a defect in the gate's own invariant rather than in
what this task declared.

### Resolution

The orchestrator resolved this under
[ADR-0043](0043-a-repo-wide-gate-that-refuses-every-correct-implementation-is-a-precondition-not-an-integration-item.md):
the fixed-vs-growing bound is deleted and replaced by an assertion about the parser, under a
second and looser reading of §34's fences. A repo-wide gate that refuses every correct
implementation of a task in flight is a precondition, not an integration item, and the
orchestrator — not this task, whose `Owns:` globs never included `tests/route-inventory.test.ts`
— owns it. Round 2 of this task merged `origin/main` (which carries ADR-0043) and re-ran
`pnpm test`: `route-inventory.test.ts` passes in full (see this task's PR report for the pasted
run). No further action is needed here, and this task must not edit
`tests/route-inventory.test.ts` itself (it is not in this task's `Owns:` globs, and the file is
listed as off-limits in this round's dispatch).
