# W3-CP-06 — This task's routes join the ADR-0038 declared gap: 503 until the integrator wires them

Status: accepted
Date: 2026-09-06
Decided by: W3-CP-06 (runtime profiles CRUD and network-policy data)
Scope: `apps/web/server/runtimes/runtime.ts`; `tests/no-route-answers-503.test.ts` (outside this
task's `Owns` cell, declared on its PR), `apps/web/server/rbac/permissions.ts` (same)

## Context

[ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
and
[W2-INT-01-the-rbac-routes-cannot-leave-503-without-a-durable-directory.md](W2-INT-01-the-rbac-routes-cannot-leave-503-without-a-durable-directory.md)
record the same shape for four Wave 2 tracks: each ships a `configure<X>Runtime` seam and a `503`
that fires until something calls it, and `apps/web/instrumentation.ts` — the one file that could
call it — belongs to the integration level, not to any resource task. `tests/no-route-answers-503.test.ts`
makes that measurable: it drives every declared route against a real, running server and asserts
the set answering `503` equals **exactly** the declared gap, named by owner.

This task ships `apps/web/server/runtimes/runtime.ts`'s `configureRuntimesRuntime` seam, following
the identical shape. Until `apps/web/instrumentation.ts` calls it — the exact call is named in
`docs/adr/W3-CP-06-agents-runtime-profile-id-and-the-integrator-call.md` — every
`/api/runtime-profiles/**` and `/api/runtime-connections/**` route answers `503
runtimes_runtime_not_configured` in a real deployment, which is the correct, honest statement about
a capability that exists in code and is not yet installed (ADR-0015: this is not a claim that the
capability works).

`tests/no-route-answers-503.test.ts` is not in this task's `Owns` cell. Its equality assertion
previously named exactly `W2-CP-06`'s nine routes as the whole declared gap; this task's seven new
routes would otherwise fail it as *undeclared* 503s — indistinguishable, from that gate's point of
view, from the actual defect ADR-0038 exists to catch (a subsystem silently uninstalled). Declaring
the gap here, rather than leaving the assertion to fail, is what keeps the gate meaningful: a
future task's routes answering 503 for a *third*, unrecorded reason still fails it, which is the
property the assertion exists to have.

`apps/web/server/rbac/permissions.ts` — also outside this task's `Owns` cell — is the second file
this task's routes made a hard requirement of, for an unrelated reason: `authorisation-matrix.test.ts`
derives its resource set from the union of every task's route declarations and refuses an
unclassified one (ADR-0015). `runtime-profiles` was already classified there (Admin: manage,
matching §21's "runtimes" clause); `runtime-connections` was not, and this task added it with the
same grant, by the same least-privilege reasoning §21 gives runtime-profiles: a connection is
credential-bearing configuration, the same shape as a secret or an API key, both Admin-managed and
nothing wider.

## Decision

1. `tests/no-route-answers-503.test.ts`'s single `GAP_OWNER` string becomes `GAP_OWNERS`, a list,
   with a parallel `GAP_RECORDS` map from owner to the ADR that accounts for that owner's gap. The
   equality assertion and its failure message are updated to read from the list rather than one
   name. This is purely additive to the assertion's *shape*; its property — the 503 set must equal
   exactly the named, recorded gaps, no more and no less — is unchanged.
2. `apps/web/server/rbac/permissions.ts` gains `runtime-connections` as a fifteenth `Resource`,
   classified `MANAGE` for Admin and denied by fallback for every other role, matching
   `runtime-profiles`'s existing treatment. No other resource's grants change.

## Consequences

* When the integrator's call lands, `runtimes_runtime_not_configured` stops firing for these seven
  routes, and this ADR's premise — that they are still gap routes — becomes false. The next task to
  touch `tests/no-route-answers-503.test.ts` removes `W3-CP-06` from `GAP_OWNERS` (mirroring how
  `W2-CP-06`'s entry is expected to be removed once RBAC gets a durable directory), which is a
  change the equality assertion itself will demand the moment routes stop answering 503 in the
  probe.
* A resource task after this one that needs a fifteenth-plus RBAC resource classified follows the
  same declared-outside-Owns pattern this record and
  `docs/adr/W3-CP-06-agents-runtime-profile-id-and-the-integrator-call.md` establish, rather than
  treating `permissions.ts` as untouchable.
