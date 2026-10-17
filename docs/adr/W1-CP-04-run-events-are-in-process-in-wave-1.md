# W1-CP-04 — Run events are a port with an in-process adapter in Wave 1, and the durability gap is declared rather than papered over

Status: superseded by [RF-001-durable-run-events-are-the-production-authority](RF-001-durable-run-events-are-the-production-authority.md)
Date: 2026-09-03
Decided by: W1-CP-04 (Control Plane)
Scope: `apps/web/server/runs/store.ts`; binding on W1-DB-01 / W2 schema (the `run_events` table)
and on whoever writes the PostgreSQL adapter

Superseded on 2026-09-16 by
[RF-001-durable-run-events-are-the-production-authority](RF-001-durable-run-events-are-the-production-authority.md): migration `0004_overconfident_lake.sql`,
`packages/core/src/db/schema/run-events.ts`, and the repository-backed `RunStore` now provide the
durable ordered event log this ADR identified as missing. The historical Wave 1 decision below is
retained as context; its in-process limitation is not the current production architecture.

## Context

R-13 finding 8 is not an optimisation note. Google Cloud Run caps a request at "less than 60
minutes" and the cap is hard, so **a long agent run is necessarily several SSE connections**;
spec §14.6 already says session durability lives in PostgreSQL and object storage, never in the
ephemeral thing. R-13 extends that one hop: not in the HTTP connection either. The consequence is
a design constraint, quoted from R-13's contract summary:

> the run event log must be durable and seekable by event id. Resume-on-reconnect is a requirement
> of the design, not a fallback.

This task cannot write that durable log. `packages/core/src/db/**` and `migrations/**` belong to
W1-DB-01, whose §27 subset ships `runs` but no `run_events`; and `apps/web` cannot import
`@agent-workspace/core` without editing `apps/web/package.json`, which is also not this task's file
(see `W1-CP-04-run-api-is-installed-not-imported.md`).

## Decision

**1. `RunStore` is defined as "replay from an event id, then follow", never as "stream a run".**
Every adapter must be able to answer "what came after id N". `openStream(runId, after)` is the only
way to read events, and `after === null` — a first connection — is a named case rather than a
default.

**2. The only adapter in this wave is `InMemoryRunStore`, and nothing installs it implicitly.** It
is installed on purpose by whoever composes the application; an unconfigured server refuses to
serve rather than falling back to it.

**3. The gap is declared as a capability that is NOT supported**, in the module comment, in the PR's
Declared gaps, and here: run events do not survive a process restart and are not shared between
replicas. Spec §12 and §41 make "declare the limit" the required behaviour, and plan §9.3 gate 1
makes "supported because a scenario passed" the only way to claim the opposite.

**4. The one thing the in-process adapter gets for free, a PostgreSQL adapter must implement:
the subscribe/read race.** Here, `openStream` registers its listener and reads the backlog in one
synchronous tick, so no event can be appended between the two. A PostgreSQL adapter (LISTEN/NOTIFY,
or polling) has no such guarantee and **must** subscribe first, buffer, then read the backlog, then
drop buffered events whose id it already replayed. This is written down because it is invisible
until it drops an event under load.

**5. Retention is bounded per run, and exhausting it is announced, not hidden.** A cursor pointing
into evicted events produces a `stream-reset` control frame — see
`W1-CP-04-resume-cursor-failures.md`.

**6. A lost-wakeup bug in the follow path was found and fixed while writing this, and the fix is
part of the contract.** While the generator is suspended at a `yield`, no waiter is armed, so an
`append` in that window has nothing to notify and its signal is dropped. A naive `await` after
draining the backlog therefore sleeps through events that already exist. `openStream` arms the
waiter **before** re-testing the condition, and any adapter that reimplements the follow loop has to
do the same. The symptom is nasty precisely because it is intermittent: the stranded event is
delivered as soon as any later event arrives, and a run whose last event is its own completion
status never gets one — so the client hangs waiting for a `done` that was already written.

## Alternatives considered

* **Create `run_events` in `packages/core/src/db/schema/`.** Rejected: not this task's files. CI
  enforces ownership from the PR body, and a second author's schema file is how two tasks' waves
  collide (ADR-0014).
* **Add `@agent-workspace/core` to `apps/web/package.json` and use the existing Drizzle client.**
  Rejected for the same reason — the package manifest is not in the `Owns` globs.
* **Skip the store entirely and pipe the runtime's SSE straight through to the browser.** Rejected,
  and it is the tempting one, because it makes the ten-minute acceptance trivially easy. It also
  makes reconnection impossible, which is the *other* half of the acceptance criterion and the half
  R-13 says is mandatory rather than optional.
* **Persist to a file on disk.** Rejected: it looks durable, and on Cloud Run, ECS or Kubernetes it
  is exactly as ephemeral as memory while being harder to notice. A gap that looks closed is worse
  than one that is declared.

## Consequences

* Reconnect-and-replay is **verified within one server process** — that is what the acceptance run
  demonstrates through nginx — and is **unverified across a restart or across replicas**, because
  no adapter that could survive either exists yet. Both halves of that sentence are in the PR.
* The `run_events` table is now a blocking dependency for anything that claims durable run history.
  Its minimum shape follows from this port: `run_id`, a per-run monotonic `bigint` id, `type`,
  `data`, `created_at`, and retention at least as long as a run can last plus the client's maximum
  backoff (R-13).
* The `InMemoryRunStore` remains useful after the PostgreSQL adapter lands: it is what makes the
  route handlers testable without a database, and much of this task's suite runs against it.
* **It grows without bound, and this is a second, separate reason not to run it in production.**
  Retention is per run — `maxEventsPerRun` caps one run's event array and evicts from the front —
  but *run records are never evicted*. `create` adds a `RunState` to the map and nothing removes
  one, so a process retains every run it has ever served, terminal or not, along with that run's
  retained events, until the process exits. The durability gap ("in-process only") and this one are
  often assumed to be the same sentence and they are not: durability is about what survives a
  restart, this is about what a server that never restarts does to its own heap. The acceptance
  probe and a test file both live for seconds, which is the only reason it is survivable here.
  Eviction of terminal runs is a retention policy, and a retention policy belongs with the store
  that has one — the PostgreSQL adapter, alongside the `run_events` retention above. It is
  deliberately not bolted onto this adapter, because a half-policy here would make the in-memory
  and PostgreSQL stores disagree about how long a finished run is readable.
