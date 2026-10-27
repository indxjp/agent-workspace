# ADR-0157 — An approval continuation acts for the paused run's subject

Status: accepted
Date: 2026-10-19
Decided by: issue #1303 slice 2 (part of #1273); the plan on that issue
Scope: `packages/core/src/db/schema/runs.ts`, `packages/core/src/db/repositories/runs.ts`, `packages/core/src/db/repositories/runs/**`, `migrations/0067_*.sql`, `formal/AgentWorkspace/Er/Core.lean`, `apps/web/server/runs/**`
Related: ADR-0142 D2 (the subject a run asserts; amended here with a third source); ADR-0145 D2 (the approval decision; amended here so the continuation inherits `subject`, like `fileScope`); ADR-0147 (a continuation may not see more files than the paused run); ADR-0156 (a trigger's stored subject, the precedent for storing one)

## Context

A run that reaches a connector which opted into caller identity (ADR-0142) must assert who it is
for. `subject` lived only in the launch context: it was signed into the run's caller and never
stored. When a person approved a paused write, the continuation started without it, so
`assertCallerForIdentity` refused the approved call (`caller unknown`) for every identity-scoped
connector. An approval could not complete the write it approved.

## Decision

- **The run stores its `subject`.** A nullable `subject text` column on `runs`, written once by
  `startRunOnSession` when the run is created and never updated. A run that asserted none stores
  NULL. Additive, so deployments that migrate at container start keep working and the old code
  ignores it.
- **The continuation inherits it.** `POST /api/runs/:id/approval` starts the continuation with the
  paused run's stored `subject`, next to `outputSchema` and `fileScope`. The continuation therefore
  acts for the same person as the run the approver decided on. ADR-0142 D2 gains a third source of
  a subject: the stored subject of the run being continued. ADR-0145 D2 gains the rule that the
  continuation inherits `subject` as it inherits `fileScope`.
- **The approver cannot change it.** The approval body stays `{ decision, comment? }` and
  `RunApprovalRequestSchema` stays strict, so a `subject` in it is `400 invalid_body`. The only
  source is the stored row. The approver only decides; the run keeps its caller.
- **`principalKind` stays `api-key`.** `runCallerOf` already signs `{ sub, principalKind: 'api-key' }`
  for any present subject, whichever principal started the run (ADR-0156), so it does not change.
- **No contract change.** `RunResource` does not show the subject, as it does not for a trigger run.

## Alternatives rejected

- **A `subject` on the approval body.** The approver could assert anyone.
- **Re-deriving it from the session.** A session carries no subject, and one session can hold runs
  for different subjects (a trigger's and a backend's).
- **Storing the resolved caller (`sub` and `principalKind`).** Wider than needed and it changes
  `runCallerOf`. See the member-started-run limit below.

## Consequences

- **Member-started runs.** A run a signed-in member starts has no subject; its caller is that
  member. If a different member approves it, the continuation's caller becomes the approver. This
  decision stores only `subject`, so it does not pin a member caller. Every gallery backend starts
  runs with an API key and a subject, where the limit does not arise. Pinning the member would need
  the resolved caller stored, a later decision.
- **The 24 hour expiry.** An approval request expires 24 hours after the pause (ADR-0145 D2.4) and an
  expired request ends the run. A decision that waits for a design review or a legal meeting can
  outlive it, and the work is then started again. This ADR does not change the expiry.
- **Privacy.** A person identifier is now stored on `runs`: the same string a trigger stores. It is
  not rendered on `RunResource`, and it goes with its run, so deleting the run deletes it.
- **Authorisation.** The continuation asserts the subject without checking it again, as every
  stored subject is. It was authorised when the run was started (an API key, ADR-0142 D2), and
  nothing after the start can change it.
