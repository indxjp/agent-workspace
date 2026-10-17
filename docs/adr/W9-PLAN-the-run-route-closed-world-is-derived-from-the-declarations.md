# ADR-W9-PLAN — The `/api/runs` closed-world assertion is derived from the declarations, not enumerated by a literal

Status: accepted
Date: 2026-09-12
Decided by: the Wave 9 orchestrator, on W9-RUNS-135's escalation
Scope: `tests/route-inventory.test.ts` — one assertion; the ownership of that file (integration level, ADR-0019)

## Context

`W9-RUNS-135`'s whole deliverable is `GET /api/runs`, declared in
`tests/route-declarations/W9-RUNS-135.ts` with its ADR-0026 mandate. Its PR (#163) turned CI's
`build · service-backed tests` job red on exactly one test in `tests/route-inventory.test.ts`:

```
serves the three run routes of spec §34 plus the security-mandated revocation operation
  expect(servedUnderRuns).toEqual([
    'GET /api/runs/:id',
    'GET /api/runs/:id/events',
    'POST /api/runs/:id',
  ]);
```

That assertion enumerates the closed world under `/api/runs` as a literal. The sibling assertion
for `/api/agents`, a few lines above, derives its closed world from `EXPECTED_ROUTES` — the union
of `tests/route-declarations/**` — so a declared route passes and an undeclared one fails
(ADR-0025). The runs assertion never took that step, and no route under `/api/runs` had been
added since it was written, so nothing exposed it. ADR-0027's rule names the shape: *a gate whose
partition is enumerated by a literal has not been partitioned.*

The plan says "no Wave 9 task edits either gate file" (the Wave 9 plan, "Per-wave
declarations partitioned by owner"), and the implementer correctly stopped and escalated rather
than editing it. ADR-0019 puts a repository-wide gate at the integration level, which in Wave 9 is
the orchestrator (`W9-PLAN-waves-branch-from-main-not-from-each-other`, decision 5).

## Decision

The assertion becomes the same derivation the agents assertion uses: the three §34 run routes and
the revocation operation are still required by name, and everything else served under
`/api/runs` must be declared in `tests/route-declarations/**`, or the test fails naming it.

Landed as an orchestrator-level, one-file PR (`aw/w9-5-route-inventory-gate`) merged **before**
PR #163 restacks, so #163's own diff stays inside its card's Owns line.

Proven both ways before merging, in the branch's worktree:

- with a tracked, undeclared `apps/web/app/api/runs/probe/route.ts` planted, the test fails:
  `expected [ 'GET /api/runs/probe' ] to deeply equal []` (and the file's other closed-world
  assertions fail alongside it, as they did before);
- with `origin/aw/w9-runs-135-durable-run-list` merged in (no commit), the file passes.

An untracked plant does **not** fail it — the gate reads the tracked tree (ADR-0039), which is
why the probe was `git add`ed for the proof.

## Alternatives rejected

- **Widen `W9-RUNS-135`'s Owns to include the gate file.** Rejected: the plan assigns the gate
  to nobody by design, and a task editing a closed-world gate to admit its own route is the
  conflict of interest the partition exists to remove.
- **Have `W9-RUNS-135` add the literal line itself under a declared out-of-Owns touch.** Rejected
  for the same reason, and because the literal is the defect, not the missing entry.
- **Leave the literal and add `GET /api/runs` to it.** Rejected: the next route under `/api/runs`
  (a declared one from a later task) would hit the same wall.

## Consequences

- `tests/route-inventory.test.ts` now has two derived closed-world assertions and no literal
  ones under `/api/agents` or `/api/runs`; the remaining tree-wide assertion ("serves exactly the
  routes declared as landed") already worked this way.
- PR #163 must restack onto `main` after this lands for its CI to go green; the orchestrator
  does that as part of the W9.5 merge sequence.
