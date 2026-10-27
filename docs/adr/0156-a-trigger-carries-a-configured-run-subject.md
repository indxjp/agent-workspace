# ADR-0156 — A trigger carries a configured run subject

Status: accepted
Date: 2026-10-19
Decided by: issue #1473 (part of #1273); the plan on that issue
Scope: `packages/contracts/src/triggers.ts`, `packages/core/src/db/schema/triggers.ts`, `packages/core/src/db/repositories/triggers.ts`, `migrations/0064_*.sql`, `formal/AgentWorkspace/Er/Core.lean`, `apps/web/server/triggers/**`, `apps/web/server/runs/caller.ts`, `packages/sdk/src/resources/triggers.ts`, `packages/aw/src/commands/triggers.ts`, `tests/gallery/harness/scripted-workspace.ts`, `tests/gallery/*/benchmark.ts`
Related: ADR-0142 D2 (the subject a run asserts; amended here so a trigger can configure it); ADR-0144 (D1 is amended: the prompt is still the only per-firing input, and the subject is configuration, not input); ADR-0151 (run-start `Idempotency-Key`, which the ringi backend uses); ADR-0154 (a trigger's `outputSchema`, the pattern this follows)

## Context

A connector that opts into caller identity (ADR-0142) only answers a run that asserts who it is for.
A run a trigger starts asserted nobody: `runCallerOf` signed a caller only for a run started with an
API key and a `subject`, and the trigger starter passed none. Three gallery use cases that start from
a trigger (excel-consolidation, meeting-minutes, ringi-review) read a subject-scoped connector, so
the scheduled or notified run was refused (`caller unknown`) and the backend had to start the run
itself, which defeats the trigger.

## Decision

- **A trigger may carry `subject`.** One string, 1 to 256 characters (`IDENTITY_SUBJECT_MAX_LENGTH`),
  optional on create, nullable on the resource. `PATCH /api/triggers/:id` replaces it with a string,
  clears it with `null` and keeps it when left out. A trigger with no subject behaves as before.
- **Every run the trigger starts uses it.** `deliver()` in `apps/web/server/triggers/fire.ts` serves a
  webhook firing and a schedule pass and hands the stored subject to the run starter `runs.start`
  also uses. The firing body can never set or override it: the body is only substituted into the
  prompt (ADR-0144 D1).
- **The caller is signed whenever a subject is present.** `runCallerOf` returns
  `{ sub, principalKind: 'api-key' }` for a present subject whatever principal started the run. The
  HTTP route `POST /api/agents/:id/runs` still refuses a `subject` from anything but an API key
  (`run_subject_forbidden`), so a browser session cannot assert one; only the trigger starter, which
  reads the subject a key-minting member configured, reaches the new branch. `principalKind` stays
  `api-key` because connectors already distinguish callers by it.
- **Who may configure it.** Setting or changing a non-null `subject`, and any other change to a
  trigger that has one (prompt, name, enabled, `outputSchema`, Zoom token), takes the decision that
  minting an API key takes: `decide()` on `POST /api/api-keys` (Owner and Admin, `'api-keys': MANAGE`).
  Under ADR-0142 only an API key asserts a subject, and only those roles mint one, so a trigger
  subject reaches no further. Otherwise the route answers `403 trigger_subject_not_allowed`.
  Without this, a Builder (`triggers: OWN_WRITES`) could make runs assert an Admin or a colleague,
  or rewrite the prompt of a trigger an Admin gave a subject and run it as that subject. Clearing
  the subject with `null` stays open to anyone who may edit the trigger, since it only drops an
  assertion. A trigger with no subject is governed by the trigger grants alone, as before.
- **Storage.** A nullable `subject text` column on `triggers`, additive, so deployments that migrate
  at container start keep working and the old code ignores it.
- **SDK and CLI.** `triggers.create` and `update` carry `subject` through the contract.
  `aw triggers create|update` take `--subject`; clearing goes through `--file` with
  `{"subject": null}`, as for `outputSchema`.

## Alternatives rejected

- **A `subject` field in the webhook body.** Anyone holding the fire URL could assert any caller.
- **Starting the run from the backend instead.** It works but drops the platform's schedule, dedupe
  and delivery handling, which are the reason to use a trigger.
- **A new `principalKind` for triggers.** Connectors that scope by caller would need a new rule for
  it, for no gain: the subject is what they read.
- **A `subject` per firing.** The ringi use case needs the filer per event, but a per-firing subject
  is the body-override problem above. Its backend starts the run itself, with `Idempotency-Key`
  `ringiId@revision`, and keeps the trigger for fixed-caller runs.

## Consequences

- `TriggerResource` gains a required `subject: string | null`; contracts and SDK are released in
  lock-step (pre-1.0).
- A trigger's runs act as one fixed caller, which only a member who may mint API keys sets or keeps.
  A Builder who owns such a trigger can still fire it, rotate its secret, delete it or clear its subject, but
  cannot change what runs as that caller without first clearing the subject.
- `RunResource` does not show the subject; the trigger resource does.
