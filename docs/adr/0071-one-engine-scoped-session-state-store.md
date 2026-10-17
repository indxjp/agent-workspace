# ADR-0071 — One engine-scoped session-state store, reached over a private route family

Status: accepted
Date: 2026-09-28
Decided by: the implementer of ENG-06 (agent-engines programme, tracker #299, unit ENG-06, issue
#305); the public transcript read and the cutover by the Owner, on #305 after the PR #326 review
Scope: `packages/core/src/db/schema/session-state-{streams,entries,blobs}.ts`,
`packages/core/src/db/repositories/session-state.ts`, `migrations/0026_*`, `migrations/0027_*`,
`apps/web/server/sessions/state*.ts`, `apps/web/server/sessions/api.ts` (the two public reads),
`apps/web/app/api/sessions/[engineSessionId]/state-*/`,
`apps/runner/src/session-state.ts`, `packages/engine/src/session-state.ts`

## Context

The platform's durable session state is Claude-shaped in its keys, not only in its names.
`session_transcripts` and `session_messages` are keyed by
`(workspace_id, project_key, session_id, subpath)`, and `project_key` and `subpath` are two fields
of the Agent SDK's own `SessionKey`. The engines ENG-01 researched key a conversation
differently: pi by one JSONL file per session with `id`/`parentId` entries, the OpenAI Agents SDK by
a flat item list with `popItem` and `clearSession`, an ACP agent by the files in its own state
directory, which `session/load` replays. None of them has anywhere to put its key, and two of them
need operations the Claude mirror does not have.

ENG-04 declared `EngineSessionStore` on the engine port and left it unimplemented. This unit
implements it, once, for every engine.

## Decision

### The tables

Three new tables, one schema module each — `packages/core/src/db/schema/tenancy.test.ts` §27
requires one module per table, named after it:

- `session_state_streams (workspace_id, session_id, engine, stream_key)` — one stream of state, with
  a row present even when it holds no entries, because `load()` must tell an empty resumable session
  from one that was never stored;
- `session_state_entries (…, sequence, entry_key, entry)` — the entries, dense from 1 within a
  stream;
- `session_state_blobs (…, blob_key, storage_key, size_bytes, sha256)` — a snapshot's location and
  digest, with the bytes in the object store.

`stream_key` is adapter-defined and opaque. The Claude adapter renders `projectKey + '/' + subpath`
into it, which is injective because a `projectKey` matches `/^[A-Za-z0-9_-]{1,64}$/` and so cannot
contain the separator.

**`session_id` is `sessions.id`, not the engine's session id.** `session_transcripts.session_id`
holds the engine's, and its tenant-paired foreign key to `sessions (id, workspace_id)` only holds
because the platform hands the Claude Agent SDK `sessions.id` as `Options.sessionId` — so the two
are the same string for that one engine. No other engine promises that. Keying on the platform's own
id is also what lets the run token's `sessionId` claim be compared directly.

<a id="idempotency"></a>

### Idempotency, and why `entry_key` is nullable

`entry_key` is the idempotency key: Claude's entry `uuid`, pi's entry `id`. R-01 §7 records that the
Agent SDK's retries redeliver a batch, so an append must upsert on it — **in place**, because a
transcript is a chain and a redelivery must not reorder it. R-01 §7 also records that entries
_without_ a key (titles, tags, mode markers) are appended without dedup, so the column is nullable: a
`NOT NULL` column would force the store to invent a key, and an invented key is an idempotency claim
about an entry that has no identity.

The unique index over `(workspace_id, session_id, engine, stream_key, entry_key)` carries no
`WHERE entry_key IS NOT NULL`, and does not need one: PostgreSQL treats NULLs as distinct in a unique
index, so one key means one row and any number of keyless rows are admitted. A partial index would
say the same thing and would additionally be a partial index, which `Er.Core`'s `UniqueKey` models as
a shape of its own.

<a id="the-operations"></a>

### The operations

Append (idempotent by `entry_key`), list (cursored), delete-last, replace-all, delete-stream, list
streams, put blob, get blob. The first five are the set the researched engines need and no more:
delete-last is the OpenAI Agents SDK's `popItem`, and replace-all is its `clearSession` followed by a
rewrite — as **one** operation, because two would leave a window in which a resumable session has no
history at all.

<a id="the-blob-cap"></a>

### The blob cap

32 MiB (`SESSION_STATE_BLOB_MAX_BYTES`, `packages/engine/src/session-state.ts`). A refusal with
`413 session_state_too_large`, never a truncation: a snapshot cut off at the cap replays into an
agent as a state directory its own code never wrote. The route enforces it **while streaming** the
body, so nothing is stored for a refused upload; the store asserts it again and throws, because
reaching that line means a caller inside the process bypassed the route.

The bytes live in `packages/core/src/storage`'s object store under its own prefix
(`session-state/<sessionId>/<engine>/<blobKey>`) and its own root — never the files or skills store,
because a session-state blob inside `/api/files`' address space would make an engine's internal state
something a tenant can list, download and delete. The local-filesystem root is
`AW_SESSION_TRANSCRIPT_ROOT`, already part of this deployment's contract; a deployment with neither
that nor `OBJECT_STORAGE_BUCKET` keeps every _entry_ durable (they are rows) and answers the two blob
routes `503 session_state_blobs_not_configured`, reported rather than substituted (ADR-0035).

### The route family, and why it is flat

Seven private runner routes:

```text
GET|POST|PUT|DELETE /api/sessions/:id/state-entries
GET                 /api/sessions/:id/state-streams
GET|PUT             /api/sessions/:id/state-blobs
```

Issue #305 drew them as `/api/sessions/:id/state/streams/:streamKey/entries`. That shape is four
levels deep under the resource, and [ADR-0026](0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
decision 3 — enforced by `tests/route-inventory.test.ts` — stops at `/api/<resource>/:id/<sub>`:
_"a fourth level is a resource that has not been named."_ `…/subkeys` is a sibling of `…/transcript`
today for exactly this reason. So the family keeps the shape rule and the stream key travels as a
query parameter, which it can because it is one opaque string.

`:id` is a UUID, resolved as `sessions.id` first and as `sessions.engine_session_id` second;
everything after the lookup uses `row.id`. #305 scopes the family by the run token's `sessionId`
claim, which is `sessions.id`, and the second lookup only exists because a Claude session's engine id
is that same UUID. A non-UUID `engine_session_id` is refused `400 invalid_session_id` on purpose: an
engine whose own id is not a UUID addresses its state by `sessions.id`, which its adapter is handed
on the run request, and widening the segment is the decision of the unit that lands such an engine.

An archived session's state is refused `409 session_archived` on every route of the family, reads
included, as `GET …/transcript` already refuses an archived session: the read is the resume path.

<a id="concealment"></a>

### Concealment: 404, not 403

Every refusal of this family for a caller that may not reach the session is
`404 session_state_not_found` — whether the session does not exist, belongs to another workspace, or
belongs to this workspace and not to this caller. These are private routes reached with a token
scoped to one session, so a 403 would answer "that session exists and is not yours" to a credential
with no business learning either fact. The public `/api/sessions/:id/**` family keeps its 403,
because a browser user who owns no session is a different conversation.

Authorisation is decided **before** the engine check, so the engine refusal cannot be used as an
oracle for a session the caller may not see.

<a id="the-engine-check"></a>

### The engine check

A write whose declared engine disagrees with `sessions.engine` is `409 session_engine_mismatch`:
session state is engine-scoped, and one engine's state replayed into another is not a resume. A
session whose `engine` is NULL — no run has pinned it yet — **accepts** any engine, because refusing
it would refuse the first write of every new session, which is the write that makes the session
resumable.

<a id="the-migration"></a>

### The migrations need a single-revision cutover

`0026` creates the tables; `0027` copies every existing Claude transcript into them, folding the
append-only `session_messages` delivery log the way `load()` already folded it (latest delivery per
position, renumbered densely). `session_transcripts` and `session_messages` are **left in place**.

The **schema** change is additive; the **data** change is not, and this release is therefore a
single-revision cutover in the sense of
[ADR-0069](0069-the-engine-identity-migrations-require-a-single-revision-cutover.md). Two facts make
it one:

- `0027` is a **one-shot** backfill. It copies what the legacy tables hold at the moment `migrate`
  runs, and nothing copies anything after that.
- `web` runs `migrate` as it starts. Under a rolling update the new revision migrates while old
  revisions still serve, and an old-revision runner keeps appending to `session_transcripts` /
  `session_messages` through `…/transcript`. Those rows are never copied, and the new revision reads
  the engine-scoped stream, so a session resumed after the rollout silently loses the turns written
  during it — spec §14.9's release blocker. The mirror image holds for a rollback: everything the new
  release wrote to the new store is invisible to the old one.

**The step:** drain the old revision, or scale it to zero, **before** the new revision starts and
runs `migrate`; old and new revisions never serve against the same database. **Rollback** is
restoring the database backup taken before the cutover, together with the previous images — not a
redeploy of the previous images over the migrated database. Each deployment guide carries the step
beside its ADR-0069 note (`docs/deploy/azure-container-apps.md`, `docs/deploy/kubernetes.md`,
`docs/deploy/single-vm.md`, and the Cloud Run section of `docs/sdk/site/concepts/data-plane.mdx`).

A dual-write or read-both window was the alternative, and was not chosen: the Owner decided on the
ADR-0069 shape on #305, which keeps one writer of each table at every moment and makes the backfill
the whole of the data migration. Dropping the old pair is the contract half and belongs to a later
unit.

<a id="the-public-transcript-read"></a>

### The public transcript read is served from this store

`GET /api/sessions/:id/transcript` and `…/subkeys` — the SDK's `sessions.transcript.read()` and
`.subkeys()` — stay Claude-only and keep their wire shape, and are **served from this store**
(Owner decision on #305). For a `claude-agent-sdk` session the read resolves the session row and
reads the stream `streamKey = projectKey + '/' + subpath`; `…/subkeys` lists that session's Claude
streams under `projectKey + '/'`, minus the main transcript's empty suffix. When the store has **no
stream** for the key — a pre-ENG-06 session that no post-ENG-06 runner has written — the read falls
back to the legacy `session_transcripts` / `session_messages` tables, and `…/subkeys` answers the
union of both, because the read falls back per stream. `404 transcript_not_found` still means
neither holds it. #305 recommended Claude-only for this route: the engine-neutral history view is the
`agent.*` frame replay, not a second transcript API.

The session row is resolved once per request, as `sessions.id` first and
`sessions.engine_session_id` second — the order `canAccessSession` and the state routes use — and
that one row decides both the `409 session_archived` refusal and the stream. A lookup by the engine
id alone would miss a session whose `engine_session_id` is still NULL, and serve its transcript
while it is archived.

### The public transcript writes match the read

`POST` and `DELETE …/transcript` are live §20 routes, so they follow the read rather than staying on
the legacy tables (review round 2 on #326). A delete that answers `204` while the next `GET` serves
the transcript from this store would be a substituted capability, which ADR-0035 rules out.

- `POST …/transcript` appends to the session's `claude-agent-sdk` stream, keyed
  `projectKey + '/' + subpath`, with the entry's `uuid` as its `entryKey`. It never writes the legacy
  tables, so what it stores is what the next `GET` reads. A session pinned to another engine is
  `409 session_engine_mismatch`. A deployment with no session rows has no stream to write, so it
  keeps the legacy store, which is also the only one its reads consult.
- `DELETE …/transcript` removes that stream **and** the legacy rows, so the next `GET` is
  `404 transcript_not_found` for a post-ENG-06 session and a pre-ENG-06 one alike.

The public contract does not change. The T2 theorems `a_posted_transcript_is_read_back` and
`a_deleted_transcript_reads_as_not_found` state both halves over `publicTranscriptRead`.

### A Claude stream key is checked against the project key

`streamKey` is opaque, with one exception. The Claude adapter keys a stream
`projectKey + '/' + subpath`, and the public read looks under `parseProjectKey(workspaceId) + '/'`.
R-01 §7 records that the SDK silently keys under the sanitised `cwd` when it refuses
`CLAUDE_CODE_PROJECT_DIR_NAME`. Before ENG-06, `POST …/transcript` caught that as
`403 project_key_mismatch`. The writer moved to `…/state-entries`, so the guard moves with it. On
`POST`, `PUT` and `DELETE …/state-entries`, a `claude-agent-sdk` `streamKey` that does not begin with
the principal's project key and `/` is `403 project_key_mismatch`, and nothing is stored. The check
runs after the session is resolved and authorised, so it never answers for a session the caller may
not reach. Every other engine's key stays opaque.

### Retention covers both stores

`startSessionRetentionScheduler` runs one policy over both stores. `AW_SESSION_TRANSCRIPT_RETENTION_DAYS`,
the cutoff and `AW_SESSION_RETENTION_DRY_RUN` all mean what they meant. Each pass purges the legacy
tables, and then every `session_state_streams` row (with its entries) and every `session_state_blobs`
row last written before the cutoff, deleting the blobs' bytes from the object store after their rows.
The result reports `transcripts`, `stateEntries` and `stateBlobs`. Without this, every post-ENG-06
conversation would sit outside a retention pass that still reported success.

### Durability is the store's answer as much as the adapter's

`EngineSessionStore.writeFailures()` records every write the store could not complete, and
`withStoreWriteFailures` folds it into the adapter's verdict in `startEngineAgent`. Before this, the
only evidence a batch had been lost was the Agent SDK's own `system/mirror_error`, so
`sessionDurability()` could only be honest for Claude. The fold can only ever make a verdict worse.

## Consequences

- Adding an engine is still adding a package: its state has a home without a schema change, as long
  as it can name its streams.
- The runner no longer calls `…/transcript` or `…/subkeys`; its client moved to
  `apps/runner/src/session-state.ts`, and `apps/web/server/sessions/wire-contract.test.ts` moved with
  it. The two public reads serve this store with a legacy fallback (above), so
  `sessions.transcript.*` keeps answering for every session, old or new.
- Upgrading to this release is a single-revision cutover, and rolling back is a restore.
- `session_state_*` rows cascade from `sessions`, so session deletion cleans them up. Blob **bytes**
  do not cascade: the object is orphaned when its row goes through the cascade, and a sweep for
  those is out of #305's scope. It is named here so it is not mistaken for an oversight. The
  retention pass (above) does delete the bytes of the blobs it purges.
- `ENGINE_IDS` is still one value, so every `engine` CHECK is currently a one-element set. Widening
  it is a one-line `ALTER` per table, which is why `oneOf` is a CHECK and not a `pgEnum`.

## Alternatives considered

**Rename and widen the existing tables.** Rejected: `project_key` and `subpath` are two fields of one
SDK's key, and a rename would leave every other engine writing into columns named after a concept it
does not have.

**A dual-write or read-both window instead of a cutover.** Rejected by the Owner on #305: it would
keep two writers of the same conversation alive for a release, and a read that merges two stores is
a place for a divergence to hide. The fallback the public read keeps is narrower — it serves a stream
the new store has never had, and never merges two copies of one.

**A `bytea` column for blobs.** Rejected: a 32 MiB column makes every read of the blob table
expensive and every backup larger, for state the platform never interprets.

**A partial unique index on `entry_key`.** Rejected in favour of the NULLs-distinct index above: it
says the same thing, and the non-partial form is the one the ER model already describes.
