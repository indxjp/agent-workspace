# W9-PLAN — `/api/metrics` is an operational endpoint, and the Runs product never reads it

Status: accepted
Date: 2026-09-11
Decided by: W9-PLAN-00 (the Wave 9 planner)
Scope: `apps/web/app/api/metrics/route.ts`; the scope boundary between W9-SEC-116, W9-RUNS-135 and
W9-UI-136

## Context

Issue #116 ends its Proposed Changes with an instruction the plan has to answer before three tasks can
be scoped: *"Document whether `/api/metrics` is an operational endpoint or a product Runs endpoint."*
The question is not rhetorical, because the answer decides two other issues:

- If `/api/metrics` is the product Runs endpoint, #116's second bullet applies — *"or remove this
  product-facing projection in favour of the durable workspace-scoped run listing API"* — and #135's
  `GET /api/runs` is a replacement that must land before #116 can finish.
- If it is operational, #116 is a self-contained hotfix, #135 adds a new endpoint rather than
  replacing one, and #136 must be told explicitly not to read it.

The evidence in the tree points one way. `apps/web/server/telemetry/runtime.ts` holds a bounded
process-local map, so its contents are neither complete across web instances nor durable across a
restart. Issue #135 states the same thing and issue #136 states it a third time: *"Do not consume
`/api/metrics` as a substitute."* A product history surface that silently loses rows on deploy is not a
product history surface.

Meanwhile `apps/web/app/(shell)/runs/page.tsx` currently *says* metrics load from `/api/metrics` and
performs no fetch, so nothing in the product depends on it today.

## Decision

**`/api/metrics` is an operational endpoint. It is scoped, kept, and never read by the Runs product.**

1. **W9-SEC-116 fixes it in place.** It authenticates through the same principal/RBAC path the durable
   run routes use, authorises the existing `metrics` resource through `decide()`, and filters the
   projection by `principal.workspaceId`. It does not delete the route.
2. **The route's own header and W9-SEC-116's ADR state that it is operational**, that its data is
   process-local and incomplete by construction, and that the product history API is `GET /api/runs`.
   The statement lives next to the code so a later reader cannot mistake the endpoint's purpose.
3. **W9-RUNS-135 adds `GET /api/runs` as a new endpoint**, not as a replacement, and touches no file
   under `apps/web/app/api/metrics/`.
4. **W9-UI-136 reads `GET /api/runs` only** — including on failure. A fallback to the telemetry map
   when the durable API errors is explicitly forbidden, because a fallback that shows fewer runs than
   exist while looking like a full history is the silent downgrade §9.3 gate 5 of
   the development plan makes a blocking finding.

## Consequences

- W9-SEC-116 has no dependency on #135 and lands in W9.1, which is what a confirmed P0
  tenant-isolation defect warrants. Had the answer gone the other way, the isolation fix would have
  waited five waves for its replacement.
- The repository keeps two run surfaces with different guarantees. That is a real cost, and it is paid
  down by the header comment and by W9-UI-136's prohibition rather than by deleting one of them
  mid-programme.
- `metrics` needs no change in `apps/web/server/rbac/permissions.ts`: it is already in `RESOURCES` and
  already carries a read-only grant for the roles that may read it. That is what allows W9-SEC-116 to
  share W9.1 with W9-AUTH-117, which owns `apps/web/server/rbac/**` that wave.

## Alternatives rejected

**Delete `/api/metrics` in W9-SEC-116.** The cleanest end state and the wrong sequencing. The Runs page
names it as its source; removing the route in W9.1 and adding `GET /api/runs` in W9.5 leaves four
waves in which the product references an endpoint that does not exist.

**Make `/api/metrics` durable, and skip #135.** Rewrites `recentRunTelemetry()` into a database query
under the name of a metrics endpoint, and then #136 consumes something whose name says operational and
whose behaviour says product. #135 exists because the join through session to agent, project and user
is the actual requirement, and none of that belongs behind a metrics path.

**Leave the question undocumented and let each task decide.** This is the option that produces three
tasks with three different beliefs about the same route, and #116 asked for a decision precisely to
prevent it.

## Related

- Issue #116 (W9-SEC-116), #135 (W9-RUNS-135), #136 (W9-UI-136).
- The development plan §9.3 gate 5 — a fallback must announce itself.
