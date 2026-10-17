# ADR-SDK-03-RUN-235 — An interrupt is a control-plane transition; the runtime signal is best effort

Status: accepted
Date: 2026-09-22
Decided by: SDK-03-RUN-CONTROL-235 implementing agent
Scope: `apps/web/server/runs/{interrupt,launcher,relay,api,environment,store}.ts`,
`apps/web/app/api/runs/[id]/{interrupt,revoke-tokens}/route.ts`,
`apps/web/server/composition/register.ts`, `apps/web/server/rbac/{permissions,decide}.ts`,
`apps/web/server/sessions/api.ts`, `packages/contracts/src/{runs,sessions}.ts`,
`packages/sdk/src/resources/{runs,sessions}.ts`, `packages/aw/src/commands/{runs,sessions}.ts`

## Context

Issue #235 (S-14, S-15, S-21) closes three roadmap gaps together because all three land in the
same files: a consumer can stop a run it started, the token-revocation route says what it does in
its path, and a transcript read needs only the run id.

Before this unit, no route interrupted a run. The runner has supported `POST /interrupt` privately
since W1-RN-02 (`apps/runner/src/server.ts`): `202 { interrupted, runId }`, `409 no_run_in_flight`,
`409 run_mismatch`. The only caller was the credential-lifetime timer inside the launch closure
(`apps/web/server/runs/launcher.ts`), which already states the security rule this unit reuses: the
abort is the security boundary — it makes the control-plane run terminal and atomically revokes its
registered token even if the interrupt request cannot reach the runtime.

The runtime base URL is resolved **inside** the launch closure and was never persisted anywhere.
`RuntimeDriverTarget.allocate` is session-affine, so re-resolving a runtime at interrupt time would
create or claim a runtime rather than find the one already running the target. There is therefore
no durable way, in general, for an arbitrary replica to address the runtime executing a given run.

`cancelled` already existed in the `RunStatus` enum and was never written: the relay mapped the
runner's `run-interrupted` terminal frame to `{ kind: 'failed' }`, and the launcher concluded
`'failed'` for it — contradicting `packages/core/src/db/schema/runs.ts`'s own comment that
`cancelled` is distinct from `failed` because a user or the platform stopping a run on purpose is
not an error.

## Decision

**The interrupt is a control-plane transition; the runtime signal is best effort.**
`interruptRun` writes the terminal `cancelled` status (the platform `run.status` event first, then
`store.finish`), revokes the run's gateway tokens through the existing `revokeRunTokens` adapter,
and *then* raises the private `POST {base}/interrupt` on the runtime through an in-process registry
of live runs that the launcher populates once it resolves `base` from a launch context, and clears
in its own finalisation path. The ordering is deliberate and mirrors the credential-lifetime
timer's own comment: the credential, not the child process, is the security boundary. It also
removes a race — signalling first would let the relay conclude `failed` before `cancelled` was
written, and `RunStore.finish` is first-call-wins.

**The invariant that ordering buys — *a caller never sees success for a run whose credential is
still live* — holds on a single replica for every window, including the `queued` one.** A run is
`queued` from `startRun`'s `202` until the launch closure marks it `running`, and its gateway token
does not exist for most of that window: `buildRunRequest` is where `gateway.issue` registers the
`run_tokens` row. An interrupt landing there therefore revokes nothing, because there is nothing
yet to revoke. The launcher closes that window itself rather than making the interrupt wait for a
token: `RunStore.markRunning` reports whether *this* call performed the `queued → running`
transition, and a launch that did not perform it knows the run went terminal underneath it. It then
sends nothing to the runtime, revokes the token it has just minted, and finalises the run through
its ordinary `conclude` path. The alternative — a second `store.get` after the token exists — was
rejected because the transition already knows the answer and a separate read races with it.

In the same change the relay/launcher mapping is corrected: a runner-reported `run-interrupted`
frame is now a `{ kind: 'cancelled' }` `RelayOutcome`, and the launcher concludes `'cancelled'` for
it, matching the schema comment.

**The live-run registry (`apps/web/server/runs/interrupt.ts`) is anchored on `globalThis`**, for
the exact reason `environment.ts`'s own run-API registry already gives: Next.js compiles
`instrumentation.ts` (where the launcher runs) and the route handlers (where an interrupt request
lands) into separate module graphs, and only a `globalThis` property is shared by every bundle in
one Node process. The registry's scope is deliberately exactly one process: two replicas have two
registries, which is correct, because what is being registered is per-process wiring, not a fact
about the run.

**Authorisation.** Interrupting a run is spec §21's **`run`** verb, not a write: the same verb
`parseOperation` already gives `POST /api/agents/:id/runs`. Builder's clause is "Create/edit/**run**
agents" and Viewer's is "**Run** permitted agents" — stopping an execution you started is part of
running it. `decide.ts` gains one arm (`POST` + sub `interrupt` → `run`), and `permissions.ts`'s
`runs` row gains `run: 'any'` for Admin (which already reads every run in the workspace, issue
#165, and already revokes any run's tokens) and `run: 'own'` for Builder and Viewer. Classifying it
as a `write` was rejected: under the existing table that would make interrupt Owner-only, which
would make "a consumer can stop a run it started" false for exactly the roles that start runs.

**The rename is add-then-keep**, never a flag day: a new
`apps/web/app/api/runs/[id]/revoke-tokens/route.ts` adapter over the **same** `revokeRunTokens`
handler; the old `POST /api/runs/[id]` is untouched in behaviour and its route declaration records
the deprecation in prose (`tests/route-declarations/W1-CP-04.ts`'s `mandate.because`), because a
machine-readable `deprecated` flag would mean editing `tests/route-inventory.test.ts`'s
`ROUTE_FIELDS` and `tests/inventory-support.ts` — a shared gate outside this unit's declared globs.
No second copy of the handler exists.

**The transcript default is one change in `keyFor`** (`apps/web/server/sessions/api.ts`): an
absent `projectKey` becomes the principal's own key, parsed the same way a declared one is; a
*declared* key is still parsed and still compared, so the disagreement the field exists to expose
is preserved for the runner, which always declares it. The default applies uniformly to all four
transcript routes (read, append, delete, subkeys) because `keyFor` is the one place all of them
build their key — a rule that lived in two places (one for read-like routes, one for
write-like routes) would be two rules.

## Alternatives considered

- **Signal the runtime first and let the relay write the status.** Rejected: fails on every
  deployment where the interrupt request lands on a replica that is not the one holding the run's
  stream, and fails open in the wrong direction — the caller would see success for a run still
  burning budget. It also cannot answer "interrupting a running run reaches a terminal status
  deterministically" (the issue's own acceptance criterion).
- **Re-resolve the runtime target from the run record at interrupt time**, instead of a live-run
  registry populated by the launcher. Rejected: `RuntimeDriverTarget.allocate` is session-affine, so
  re-resolving creates or claims a runtime rather than finding the one already running — it would
  interrupt the wrong container, or launch a new one.
- **A durable cross-replica cancellation request** (a `cancel_requested` column or run leases,
  polled by every launcher). The honest answer for a multi-replica deployment where the interrupt
  lands on a different replica than the one holding the stream, and a materially bigger change — a
  migration, a poll loop, and RF-301's run leases sitting immediately next to it. Left as a named
  gap rather than folded into this unit (see Consequences); a durable fix is proposed as a
  follow-up issue in the tracker (#232) rather than absorbed here, per the migration playbook's
  rule that a discovered prerequisite becomes an issue, not a detour.
- **Classify `interrupt` as the `write` verb.** Rejected: §21's write grant on `runs` is Owner-only
  in the published table, which would make every non-Owner unable to stop a run it started — the
  opposite of the issue's outcome.
- **A machine-readable `deprecated` flag on a route declaration.** Rejected for this unit: it would
  require widening this unit's globs to include the route-inventory gate's own support files
  (`tests/inventory-support.ts`, `tests/route-inventory.test.ts`), which are shared infrastructure
  outside `Owns`. Prose in the existing declaration's `mandate.because` records the same fact
  without touching a gate two other units also depend on.

## Consequences

- **The cross-replica gap is real and is named here, not papered over.** On a multi-replica
  deployment, an interrupt handled by a replica that does not hold the run's stream makes the run
  terminal and revokes its tokens (the security boundary holds), but the runtime child keeps
  running until its own credential-bounded lifetime expires
  (`apps/web/server/runs/launcher.ts`'s `maxRunDurationMs`). Compute is spent; nothing insecure
  happens. The durable fix (a poll-based cancellation request or RF-301's run leases) is a
  follow-up issue in tracker #232, inserted after this unit.
- **`RunStore.markRunning` returns `boolean` instead of `void`.** A port change, and the reason it
  is worth one: the launcher's decision to start a runtime now rests on a positive assertion that
  *it* moved the run out of `queued`, rather than on the absence of a signal. Both adapters already
  had the fact — the repository's `markRunning` returns a `RunTransitionOutcome`, and the in-memory
  store branches on `status !== 'queued'` — so neither gains a query; only the port stopped
  discarding it.
- **`permissions.ts` is `runs`' published role table**, and the site
  (`docs/sdk/04-api-specification.md` §3.3, `docs/sdk/site/concepts/workspaces-and-principals.mdx`
  and `docs/sdk/site/concepts/ownership-and-sharing.mdx`) reproduces it verbatim; all three move in
  this change. It is a widening — Admin gains `run: 'any'`, Builder and Viewer gain `run: 'own'`
  — so no caller loses access.
- **Changing `run-interrupted` from `failed` to `cancelled`** alters the terminal status a run
  reaches on a path that already existed (the runner interrupting itself, or a foreign interrupt
  reaching it). The credential-lifetime timer's own interrupt still concludes `failed` — a timeout
  is a failure, not a request — and is unaffected. `isTerminalRunStatus` covers both, and the SDK's
  `waitForOutcome` and CLI's exit-code mapping are unaffected by which terminal status a run
  reaches.
- **No migration.** `cancelled` was already in the `run_status` enum; no column is added.
- **Compatibility.** Both revocation paths answer identically for one release; `projectKey` is
  still accepted and still checked where a caller sends it; the SDK's `TranscriptAddress` becomes
  optional, which is source-compatible with every existing caller.
- **Rollback** is the revert of one PR: no data is written in a new shape, and no path is removed.
