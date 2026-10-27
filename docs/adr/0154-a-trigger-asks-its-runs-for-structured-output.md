# ADR-0154 — A trigger asks its runs for structured output

Status: accepted
Date: 2026-10-18
Decided by: issue #1296 (P4-5 of #1273), slice 2; the owner's design note on that issue
Scope: `packages/contracts/src/triggers.ts`, `packages/core/src/db/schema/triggers.ts`, `packages/core/src/db/repositories/triggers.ts`, `migrations/0062_*.sql`, `apps/web/server/triggers/**`, `packages/sdk/src/resources/triggers.ts`, `packages/aw/src/commands/triggers.ts`, `tests/gallery/harness/scripted-workspace.ts`, `tests/gallery/*/benchmark.ts`
Related: ADR-0143 (a run can be asked for structured output: dialect, depth, size and `$ref` rules reused unchanged); ADR-0144 (D1 is amended here, nothing else in it changes); ADR-0065 D3 (a requirement an engine cannot honour is refused, never ignored)

## Context

ADR-0144 D1 makes the prompt template the only per-firing input of a trigger. A run a trigger
starts therefore carries no `outputSchema`, and the platform stores `structured: null` for it
(ADR-0143). The four gallery use cases that start from a trigger (ringi-review, excel-consolidation,
meeting-minutes, customer-inquiry) all read a typed answer from that first run. Without a schema on
the trigger they would have to parse free text again, which undoes the structured-output work
(`struct` cells), or start a second typed run per event, which bills twice and needs a dedupe store
of its own.

## Decision

- **A trigger may carry `outputSchema`.** It is optional on create and nullable on the resource. It
  is the same JSON Schema object `StartRunRequest.outputSchema` takes, checked by the same function
  (`outputSchemaViolation`): root type `object`, draft 2020-12, local `#/$defs/<name>` references
  only, at most 16 levels, at most 32 KiB. A schema outside those limits is `400 invalid_field` at
  create and patch, with the limit name (`root_type`, `size`, `dialect`, `ref`, `depth`) in the
  message, as `runs.start` reports it.
- **Patch semantics.** `PATCH /api/triggers/:id` accepts `outputSchema`; an object replaces it, `null`
  clears it, and leaving it out keeps it.
- **Every run the trigger starts uses it.** A webhook firing and a schedule pass share one starter
  (`deliver()` in `apps/web/server/triggers/fire.ts`), and it hands the stored schema to the run
  starter that `runs.start` also uses. That starter already refuses an engine without
  `structuredOutput` with `422 engine_capability_unsupported` (ADR-0065 D3), persists the schema, and
  stores `structured`. A trigger with no schema starts untyped runs exactly as before.
- **Storage.** A nullable `output_schema jsonb` column on `triggers`. It is additive; running
  deployments that migrate at container start keep working, and the old code ignores the column.
- **SDK and CLI.** `aw.triggers.create` and `update` take the schema as a Zod type or a JSON Schema
  object, as `runs.start` does, and convert with the same function. `aw triggers create --file` goes
  through the contract and needs no new parsing.

## Alternatives rejected

- **A schema on the agent.** It would change every interactive run of that agent, which is broader
  than the decision.
- **A second typed run after the trigger run.** One extra billed run per event, and its dedupe brings
  back the store the trigger replaced.
- **Checking the engine capability at create time.** The agent's engine can change after the trigger
  exists. The firing already refuses with the same code through the shared starter, so the check is
  made where it matters.

## Consequences

- `TriggerResource` gains a required `outputSchema: object | null`. The contracts and the SDK are
  released in lock-step (pre-1.0), so an older SDK would refuse the unknown key of a newer server.
- A trigger that opted into a schema and sits on an engine without `structuredOutput` starts nothing
  and the delivery is released, so the same `Idempotency-Key` can be retried once the engine is fixed.
  No existing trigger changes, because none carries a schema.
