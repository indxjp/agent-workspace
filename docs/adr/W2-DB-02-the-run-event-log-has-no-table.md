# W2-DB-02 — Run records are persisted and run events are not, because spec §27 defines no table for them

Status: superseded by [RF-001-durable-run-events-are-the-production-authority](RF-001-durable-run-events-are-the-production-authority.md)
Date: 2026-09-04
Decided by: W2-DB-02 (Persistence)
Scope: `apps/web/server/runs/store.ts`, `packages/core/src/db/repositories/runs.ts`

Superseded on 2026-09-16 by
[RF-001-durable-run-events-are-the-production-authority](RF-001-durable-run-events-are-the-production-authority.md): migration `0004_overconfident_lake.sql`,
`packages/core/src/db/schema/run-events.ts`, and
`createDatabaseRunEventRepositoryProvider` now persist and replay Run events. The historical Wave 2
constraint below remains useful context but no longer describes the current adapter.

## Context

This task converts runs onto the repository layer. A run is two things behind one port: a **record**
(`runs`, spec §27) and an **event log**. The record has a table. The event log does not.

Spec §27's table list, quoted from `docs/spec.md`, contains no `run_events`:

```text
workspaces / users / memberships / agents / model_connections / runtime_profiles /
skills / mcp_servers / files / agent_skills / agent_mcp_servers / agent_files /
projects / project_files / project_mcp_servers / sessions / runs /
shares / share_views / api_keys / secrets / audit_events
```

`docs/adr/W1-CP-04-run-events-are-in-process-in-wave-1.md` already recorded the same gap for Wave 1
and named the table a PostgreSQL adapter would need.

Adding that table means editing `packages/core/src/db/schema/**` and `migrations/**`, which
the Wave 2 plan assigns to **W2-DB-01**, not to this task.

## Decision

**Persist the record. Keep the event log in process. Say so where an operator will read it.**

1. `packages/core/src/db/repositories/runs.ts` persists the `runs` row and nothing else.
2. `apps/web/server/runs/repository-store.ts` composes the two halves. The event half — ids, retention, reset
   notices, the wake-up protocol — was **extracted** from `InMemoryRunStore` into one `RunEventLog`
   used by both stores, rather than reimplemented for the database one. Two implementations of the
   event log could disagree in ways the conformance suite could not catch, because the suite would
   be asserting the same behaviour on both sides.
3. `apps/web/instrumentation.ts` prints, at start-up, one line naming exactly what a restart keeps
   and what it loses, with the lost half in capitals.
4. The conformance suite asserts the pair of answers this produces, rather than describing them: a
   run record read after a restart, and `openStream` answering 404 for a run this process never
   created.

## Alternatives considered

* **Add a `run_events` table here.** Rejected on ownership: `migrations/**` and the schema glob are
  W2-DB-01's, that task has already landed, and a second task writing migrations into it is the
  collision the Wave 2 plan exists to prevent. It is also a schema decision — retention,
  partitioning, the id type — that belongs with the schema, not with an adapter.
* **Leave run records in memory too, so the two halves match.** Rejected. It would mean converting
  nothing about runs, and ADR-0024 §2 converts runs precisely because they already have callers and
  tests. Half of a run surviving is strictly more than none of it, provided the half that does not
  is named.
* **Serialise the event log into a `jsonb` column on `runs`.** Rejected: it is a `run_events` table
  wearing a disguise, it makes every append a whole-row rewrite, and it would have to be undone by
  whoever adds the real table.

## Consequences

* A restart keeps every run's id, session, status, timestamps and error, and loses every run's
  events. `GET /api/runs/:id` answers about a run from before the restart; `GET
  /api/runs/:id/events` answers 404 for it.
* Spec §14.9's resume criterion (W2-CP-07) is **not** closed by this task and was never in its
  scope.
* Whoever adds `run_events` replaces `RunEventLog` with a PostgreSQL implementation and must handle
  the subscribe/read race that single-threaded JavaScript gives this one for free — the requirement
  is stated in `RunEventLog`'s own doc comment and in
  `docs/adr/W1-CP-04-run-events-are-in-process-in-wave-1.md`.
