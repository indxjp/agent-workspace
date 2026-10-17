# W2-DB-02 — A deployment with no reachable database installs nothing; it does not quietly run on memory

Status: accepted
Date: 2026-09-04
Decided by: W2-DB-02 (Persistence)
Scope: `apps/web/instrumentation.ts`; corrects ADR-0024 §3 on one point of fact

## Context

This task's brief says the choice must be visible:

> Decide honestly what happens when `DATABASE_URL` is absent or the database is unreachable, and
> make the choice VISIBLE: if the deployment silently falls back to memory, an operator who
> restarts and loses their agents was never told.

[ADR-0024](0024-wave-2-needs-a-persistence-foundation-the-plan-does-not-name.md) §3 describes the
in-memory implementations as *"what `docker compose up -d` falls back to when no database is
reachable"*.

**That sentence is false about this codebase, and it cannot be made true by this task.** Every
request is authorised by reading three tables. `DatabaseRoot.resolveMembership`, in
`packages/core/src/db/repositories/root.ts`, looks up `workspaces` by slug, `users` by email and
`memberships` by the pair, and returns `null` unless all three agree — deliberately, so that
deleting a membership revokes access immediately rather than when a twelve-hour token expires.
`apps/web/instrumentation.ts` calls it. The query lived in that file, under the name
`resolveIdentity`, when this ADR was first written; verification round 1 of W2-DB-02 moved it into
the layer, and round 2 gave it `packages/core/src/db/repositories/root.test.ts`, which exercises it
against a real PostgreSQL — including the case where the workspace row and the user row both exist
and the membership does not. A process with no database therefore authorises
nobody, and an in-memory agent store behind it would never be reached by any request. Giving
identity a memory implementation means owning users and memberships, which is **W2-CP-06**'s task.

There is a second, quieter version of the same problem, and it was already in the code:
`createPool` opens no connection. A `DATABASE_URL` that merely *parses* — a host that is not there,
a database never created, credentials since rotated — installed both seams and printed
`[compose] agent API installed`, and the first request then failed with a 500 raised inside a route
handler. A start-up log claiming success for a database nobody had spoken to is
[ADR-0015](0015-gates-decide-on-positive-assertions.md)'s shape exactly: a fallback that cannot be
distinguished from success.

## Decision

1. **No fallback to memory, at all, ever, in any deployment mode.** A database that cannot be
   reached leaves both seams uninstalled and every `/api/**` route answering the 503 it already
   knows how to answer, naming the missing piece. The in-memory implementations are kept for what
   ADR-0024 §3's *other* half says they are for — the implementation the contract suite holds
   PostgreSQL to, and the store every unit test in `apps/web` uses — and `instrumentation.ts` never
   constructs one.
2. **The seam is installed because a query succeeded.** After the pool is created,
   `await pool.query('select 1')` runs, and a failure takes the same path as an unparseable
   `DATABASE_URL`: log the reason, install nothing, return.
3. **The inventory is printed, not inferred.** Alongside `[compose] agent API installed`, start-up
   now prints one `[compose] persistence:` line naming what a restart keeps and what it loses, with
   the part that is lost in capitals. `instrumentation.ts`'s header carries the same table.

No `AW_PERSISTENCE` switch is introduced. A "memory mode" that cannot authenticate anybody is not a
mode; it is a broken configuration with a friendly name.

## Alternatives considered

* **Fall back to memory as ADR-0024 §3 describes.** Rejected because it does not work, not because
  it is risky: see Context. Recorded here rather than silently not done, because ADR-0024 is the
  brief this task was given and a reader comparing the two deserves the reason.
* **Add `AW_PERSISTENCE=memory` as an explicit opt-in.** Rejected: it would install stores that no
  authorised request can reach, so the flag would advertise a capability that does not exist.
* **Probe the database lazily, on the first request.** Rejected: the operator reading
  `docker compose logs web` is the person who can fix it, and they read the log at start-up.

## Consequences

* An unreachable database is now a 503 with a reason at start-up instead of a 500 per request. One
  extra round trip is paid once per process.
* ADR-0024 §3's sentence about `docker compose up -d` is superseded on that one point. Its other
  three points — keep the in-memory implementations, run one suite against both, and let that suite
  be the gate — are implemented as written.
* When W2-CP-06 gives identity a non-database source, a memory deployment mode becomes
  implementable. This decision does not stand in its way; it records that the mode did not exist
  when it was claimed.
