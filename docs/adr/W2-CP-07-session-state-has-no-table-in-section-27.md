# W2-CP-07 — Session state has no table in spec §27, so the store is a port with a filesystem backend

Status: accepted
Date: 2026-09-05
Task: W2-CP-07 (sub-wave 2b-1)
Scope: `apps/web/server/sessions/**`

## Context

Spec §20 requires a durable `SessionStore` and says *"Prefer using PostgreSQL because PostgreSQL is
already required for control-plane metadata."* Spec §14.9 makes it a release blocker: *"the durable
`SessionStore` (section 20) must persist the Agent SDK session state, not only the session id."*
R-01 §7 says what "state" is: a list of `SessionStoreEntry` records per `SessionKey`, appended in
batches, upserted on `entry.uuid`, and read back deep-equal.

That list has nowhere to go.

* Spec §27's table list contains `sessions` and no table of transcript entries. Sub-wave 2a hit the
  identical wall for the run event log and recorded it —
  [`W2-DB-02-the-run-event-log-has-no-table.md`](W2-DB-02-the-run-event-log-has-no-table.md).
* `packages/core/src/db/schema/**` and `migrations/**` belong to W2-DB-01, and
  `packages/core/src/db/repositories/**` to W2-DB-02.
* `packages/core/src/db/index.ts` is the narrow barrel sub-wave 2a produced after two live
  tenant-isolation bypasses. This task's brief names it: *"Do not widen it; it is not yours."*
* `apps/web` has no other route to PostgreSQL, and that is deliberate. `openDatabaseRoot()` returns
  scope-bound repository providers and **no queryable handle**; `@agent-workspace/core/db/unscoped`
  throws when loaded outside a test runner.

So a PostgreSQL adapter for this store cannot be written inside this task's ownership. It needs a
schema file, a migration, a repository, and three lines on files owned by three other tasks.

§27 is not a closed list — it says *"The main tables should **roughly** be"* and *"Use JSONB where
it meaningfully reduces code"* — so the table is legal. It is not, today, this task's to add.

## Decision

1. **The store is a port**, `TranscriptStore` in `apps/web/server/sessions/transcript.ts`: four of
   the SDK's six `SessionStore` members, in platform-owned types, with the rules R-01 §7 reports —
   upsert on `uuid`, `null` ≠ `[]`, `delete` cascades to subkeys — stated once and shared by every
   backend through `mergeTranscriptEntries` and `KeyedSerialiser`.

2. **Two backends ship, both held to one contract suite** (`store.test.ts`, run against each in
   turn, the shape `apps/web/server/agents/store.test.ts` established):
   * `InMemoryTranscriptStore` — for tests. Never installed by a deployment.
   * `FileTranscriptStore` — JSON Lines, one file per key, replaced by `writeFile` + `rename`, under
     a root the composition root chooses. **It is durable**: a process killed with `SIGKILL` loses
     nothing, which is what the acceptance run demonstrates.

3. **The PostgreSQL adapter is a declared gap with its shape written out**, below, so that closing
   it is mechanical rather than a redesign. Swapping it in is one line in a composition root,
   because that is what the port buys.

## What a PostgreSQL backend needs, exactly

```sql
-- Neither of these files exists; this is the shape, not a pointer to one. It goes in a new
-- session-entries schema module under packages/core/src/db/schema/, with a matching
-- migration under migrations/, both owned by W2-DB-01.
create table session_entries (
  id            bigserial primary key,          -- R-01 §7: the vendor adapter orders by BIGSERIAL
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  session_id    uuid not null,
  subpath       text,                           -- NULL = the main transcript; '' is INVALID
  entry_uuid    text,                           -- NULL for titles, tags, mode markers
  entry         jsonb not null,
  created_at    timestamptz not null default now(),
  constraint session_entries_session_workspace_fk
    foreign key (session_id, workspace_id) references sessions (id, workspace_id) on delete cascade,
  constraint session_entries_uuid_key unique (workspace_id, session_id, subpath, entry_uuid)
);
create index session_entries_transcript_idx on session_entries (workspace_id, session_id, subpath, id);
```

The unique constraint is the upsert key: `insert … on conflict (workspace_id, session_id, subpath,
entry_uuid) do update set entry = excluded.entry` implements R-01 §7's redelivery rule in one
statement, and PostgreSQL's NULL-distinct behaviour gives uuid-less entries the append-without-dedup
half for free. The composite foreign key is Wave 1's tenancy rule, and `tenancy.test.ts` derives its
inventory from the schema directory, so the table is covered the moment it is exported.

The repository is `SessionEntryRepositoryProvider` with `forScope(scope)` — the shape
`packages/core/src/db/repositories/index.ts` already prescribes — plus one line on `DatabaseRoot`
and one on each of the two barrels.

## Consequences

* **What §14.9 asks for is closed**: session state no longer lives inside the sandbox. It lives in
  the control plane, on storage the control plane owns, reachable only through an authenticated,
  tenant-scoped HTTP surface.
* **What §20 asks for is closed except for the word "PostgreSQL".** The gap is one adapter and is
  declared on this task's PR.
* **`FileTranscriptStore` is single-node.** Two control-plane replicas sharing one directory are
  ordered by the filesystem and the per-key serialiser does not span processes. That is the same
  bound the migration-in-the-entrypoint already carries, it is stated in the file's header, and it is
  the second reason a cluster wants the PostgreSQL adapter.
* A reviewer who wants the table added by this task should read the ownership section above first:
  four sibling tasks in one sub-wave editing three shared files is the union failure of
  [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) in a different costume.

## Alternatives considered

* **Add the table and widen the barrel.** Rejected: the brief forbids it by name, and the
  disjointness condition of [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) is
  what makes four parallel tasks safe at all.
* **Keep state in memory and declare the blocker open.** Rejected: it is the release blocker, and a
  store that a restart empties fails the acceptance criterion by construction.
* **Store the transcript as a JSONB column on `sessions`.** Rejected for the same ownership reason,
  and it is the wrong shape anyway — R-01 §7's upsert-on-`uuid` and the SDK's redelivery behaviour
  want a row per entry, which is what the vendor's own reference adapter does.
* **Put the transcript in the `ObjectStore` (§16).** Rejected: `ObjectStore` is W2-CP-03's, a
  parallel sibling, so it does not exist on this branch — and a transcript that is appended to on
  every batch is a poor fit for object storage.
