# ADR-0013 — Wave 1's declared ownership intersects; the API split is corrected and the wave is halved

Status: accepted
Date: 2026-09-03
Decided by: orchestrator
Scope: Wave 1 task cards

## Context

Plan §2.3 permits two tasks to run concurrently **only if their declared owned-file globs do not
intersect**, and requires the check before a wave launches. Running it against the plan's own Wave 1
task cards (§6.3) finds a real intersection:

| Task | Declared `Owns:` |
| --- | --- |
| W1-CP-04 (run API + SSE relay) | `apps/web/server/runs/**`, `apps/web/app/api/{agents,runs}/**` |
| W1-CP-05 (agent CRUD) | `apps/web/server/agents/**`, `apps/web/app/api/agents/**` |

Both claim `apps/web/app/api/agents/**`, and §6.3 places them at the same parallel level. §2.3 says
this means the plan is wrong, and to fix the plan rather than reconcile it in code.

The intersection is not accidental. Spec §34 puts run **creation** under the agent tree
(`POST /api/agents/:id/runs`) while run **reading** lives under its own
(`GET /api/runs/:id`, `GET /api/runs/:id/events`), so the two tasks genuinely share a route parent.

Separately, Wave 1 as drawn is 11 implementation tasks. With one verifier each that is 22 agents,
over both the plan's ≤15-per-workflow rule (§2.1 rule 4) and this session's configured size guideline.

## Decision

**1. Split the API ownership at file level, not directory level.**

    W1-CP-04   apps/web/server/runs/**
               apps/web/app/api/runs/**
               apps/web/app/api/agents/[id]/runs/**        ← the run-creation route only

    W1-CP-05   apps/web/server/agents/**
               apps/web/app/api/agents/route.ts            ← collection: POST, GET
               apps/web/app/api/agents/[id]/route.ts       ← item: GET, PATCH, DELETE

These are disjoint as file sets while both remaining inside the route tree spec §34 mandates. Neither
task may create any other file under `apps/web/app/api/agents/`.

**2. Split the wave into W1a and W1b** with an explicit dependency edge, per §2.1 rule 4:

    W1a  W1-DB-01, W1-CORE-01, W1-RN-01, W1-RN-02, W1-CP-04, W1-CP-05, W1-CP-06   (7 + 7 agents)
    W1b  W1-UI-01, W1-UI-02, W1-UI-03, W1-INF-01                                   (4 + 4 agents)

W1b bases on W1a's integration tip, because the UI cannot be verified against an API that does not
exist and W1-INF-01's acceptance criterion is a full browser-to-streamed-answer run.

**3. Two tracks are serial inside the parallel level**, because their dependency is real even though
their files are disjoint: `W1-RN-02` bases on `W1-RN-01` (it imports the SDK wrapper), and
`W1-UI-02` → `W1-UI-03` base on `W1-UI-01` (they render inside its shell). Disjoint files are a
licence to run concurrently, not an obligation to.

## Alternatives considered

- **Merge W1-CP-04 and W1-CP-05 into one task.** Rejected: it produces one PR spanning the whole
  control-plane API surface, which is what §2.2's stacking exists to avoid, and W1-CP-04 is `PL-1★`
  (a pattern-setter reviewed hard) while W1-CP-05 is `PL-0` transcription — different review regimes.
- **Give `apps/web/app/api/agents/**` to W1-CP-05 and have W1-CP-04 escalate for the one route.**
  Rejected: an escalation on every wave for a route that is statically known is ceremony, and §2.3
  names the "integrator owns the shared file" pattern for genuinely shared files, which this is not —
  it is two files that happen to share a parent.
- **Raise the agent cap instead of splitting the wave.** Rejected: §2.1 rule 4 says explicitly to
  split rather than raise the limit.

## Consequences

- Wave 1 lands as two stacks with two integration branches, so the base chain grows by two rather
  than one. Under [ADR-0001](0001-no-merge-to-main-wave-integration-branches.md)'s no-merge regime
  that cost is permanent for the rest of the programme.
- The development plan §6.3 is now wrong as written. It is not edited here — the plan is the
  Owner's document and §0 rule 1 makes the spec, not this ADR, authoritative. The divergence is
  recorded in the W1 manifest and this ADR is linked from it.
- The file-level split means a later task adding a route under `apps/web/app/api/agents/` has no
  owner. Wave 2's integrator (W2-CP-12) inherits that directory.
