# ADR-0138 — Durable run event frames carry the control-plane record time

Status: accepted
Date: 2026-10-14
Decided by: issue #1113 (found in #1021), PR #1115
Scope: `apps/web/server/runs/sse.ts`, `apps/web/server/runs/store.ts`, `apps/web/server/runs/agent-frames.ts`, `packages/core/src/db/repositories/runs.ts`, `packages/sdk/src/events/sse.ts`, `packages/sdk/src/events/run-events.ts`, `packages/aw/src/commands/runs-trace.ts`

## Context

`aw runs trace` showed what a run did but not when, so a slow run could not be broken down into
steps, tool calls and the final result. Every stored run event already has a `created_at`
(`defaultNow()`), but nothing read it and the SSE stream served only `event:`, `id:` and `data:`.

## Decision

- **The field.** Every durable frame (`run.status` and `agent.*`) is written with an `at:` SSE field
  between `id:` and `data:`, holding an ISO-8601 UTC instant with milliseconds
  (`Date.prototype.toISOString`). Control frames carry none. A stored row that fans out into several
  frames gives each the row's `at`.
- **What it means.** `at` is the **control-plane record time**: the row's `created_at` from the
  database (or the in-memory store's injected clock), not the engine's clock. It therefore includes
  the relay latency from the runtime to the control plane and the database write. An offset computed
  against `run.startedAt` assumes both came from one clock: in PostgreSQL both are the database's
  `now()`, but any source that stamps one from the application clock and the other from the
  database's can be off by the app/DB clock skew. Consumers that need exact engine timing must not
  read `at` as such.
- **Optional and backward compatible.** SSE clients ignore unknown fields, so older clients are
  unaffected. In the SDK `at` is optional (`at?: string`) on `SseFrame` and `RunEventFrame`: a
  frame from a server that predates the field has none, and consumers must handle its absence.
  `classifyRunEventFrame` validates a present value and raises `ContractViolationError` for a
  malformed one. `aw runs trace` renders unstamped input exactly as before.
- **No migration.** The column already exists; the repository now selects it and returns it from
  `append`.

## Alternatives considered

- **Engine-side timestamps in the event payload.** Closer to when the work happened, but every
  engine adapter would have to stamp it, and the payloads are engine-shaped. Left as a follow-up if
  the relay latency turns out to matter.
- **A required field.** It would break existing fixtures and consumers built against older servers
  for no gain; every production source stamps it anyway.
- **A field inside `data`.** It would change the payload contract of every event type instead of
  adding one transport-level field.

## Consequences

- `aw runs trace` prints offsets from the run start and tool call-to-result durations; `--json`
  carries `at`, `calledAt` and `answeredAt`.
- The Lean model `formal/AgentWorkspace/Events/SdkSse.lean` does not model `at` yet; its parsed
  `{event, id, data}` behaviour is unchanged because the field is optional. Modelling it is a
  follow-up.
