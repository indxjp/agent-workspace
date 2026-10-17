# RF-001 — Durable `run_events` are the production authority for replayable Run events

Status: accepted
Date: 2026-09-16
Decided by: RF-001 (architecture baseline)
Scope: `migrations/0004_overconfident_lake.sql`, `packages/core/src/db/schema/run-events.ts`, `packages/core/src/db/repositories/runs.ts`, `apps/web/server/runs/store.ts`
Supersedes: [W1-CP-04-run-events-are-in-process-in-wave-1](W1-CP-04-run-events-are-in-process-in-wave-1.md) and [W2-DB-02-the-run-event-log-has-no-table](W2-DB-02-the-run-event-log-has-no-table.md)

## Context

The Wave 1 and Wave 2 decisions kept Run events in process because their task boundaries could not
add a table or PostgreSQL adapter. They deliberately described that limitation as temporary and
named durable, cursor-addressable replay as the required production shape.

The installed architecture now has that shape. Migration `0004_overconfident_lake.sql` creates
`run_events`; the schema gives each row a workspace, Run, sequence, type, payload, and creation
time; and the repository-backed `RunStore` is wired to the scoped Run-event repository in the
production composition root. The in-memory log remains useful for tests, but it no longer
describes the production authority.

The approximate table inventory in `docs/spec.md` section 27 predates this implementation. Its
omission of `run_events` is not a requirement to discard the durable log.

## Decision

1. **PostgreSQL `run_events` is the production source of truth for replayable Run events.** The
   repository-backed store appends to and replays from the table. Production composition does not
   silently fall back to the in-memory adapter.
2. **Ordering is per Run.** The primary key is `(run_id, sequence)`. Append takes a transaction-level
   advisory lock derived from the Run id, verifies that the scoped Run exists and is nonterminal,
   and assigns the next sequence in the same transaction. Terminal transition takes the same lock,
   so an admitted append cannot be overtaken by completion and no append is admitted afterward.
3. **Replay is durable even though wake-ups are process-local.** A stream reads committed rows after
   its cursor in sequence order. Local waiters reduce latency, while bounded polling observes events
   written by another process or before a restart.
4. **Replay retention remains bounded per Run.** Append removes rows older than the configured
   event limit. `bounds` lets the HTTP stream return an explicit reset when a cursor predates the
   retained window; the server never pretends that truncated replay is contiguous.
5. **`InMemoryRunStore` is a test adapter, not a deployment mode.** It preserves the same public
   replay/follow contract for deterministic tests, but its process lifetime is not a production
   durability promise.

## Alternatives considered

- **Continue treating events as process memory.** Rejected because restart and replica changes
  would make an existing Run unreplayable even though its record survived.
- **Store the entire log in one `runs` JSONB field.** Rejected because every append would rewrite
  the aggregate and concurrent ordering would be harder to enforce.
- **Add Redis or a generic event broker.** Rejected because PostgreSQL already owns the durable Run
  aggregate and satisfies ordered replay without another production authority.

## Consequences

- The two earlier in-process ADRs remain as historical records but are superseded by this decision.
- A restart or another web replica can replay retained committed events for an existing Run.
- A database outage fails the production store; it does not authorize a volatile fallback.
- Durable Run-event replay does not by itself complete the separate Session list/archive/resume
  product journey.
- The event-retention window is distinct from the RF-001 safe default that retains Run records,
  transcripts, and audit history indefinitely pending a ratified retention/legal-hold policy.

