# ADR-0079 — The session and audit lists are cursor-paged, with cursors bound to one list and one workspace

Status: accepted
Date: 2026-09-29
Decided by: the implementer of SDK migration unit 6's remaining acceptance criterion (issue #238,
S-5, SDK-06b)
Scope: `packages/contracts/src/{sessions,observability}.ts`;
`packages/core/src/db/repositories/{keyset,audit-events,runs}.ts`;
`apps/web/server/pagination/**`; `apps/web/server/sessions/api.ts`; `apps/web/server/audit/api.ts`;
`packages/sdk/src/pagination.ts`, `packages/sdk/src/resources/{sessions,observability}.ts`;
`packages/aw/src/commands/{sessions,observability}.ts`; `formal/AgentWorkspace/Contracts/Sessions.lean`;
spec `docs/sdk/04-api-specification.md` §4 and §8 row S-5

## Context

Before this change only `GET /api/runs` was cursor-paged. `GET /api/sessions` returned every row
the caller could see, and `GET /api/audit-events` returned the newest `limit` rows (at most 500)
with no way to reach older ones. The SDK is about to be published (#246); a list whose response
shape changes after publication is a breaking change, so both lists gain the runs loop shape —
`cursor` in, `nextCursor` out — now.

The runs cursor is base64url of `{ createdAt, id }`. It is opaque by contract but not bound to
anything: a runs cursor from workspace A, sent by a caller in workspace B, is read as a position
in B's list. That is harmless (the query is still scoped to B) but it is the wrong answer to a
client error, and the issue asks for a cursor from one workspace to be refused by another.

## Decision

### D1 — Keyset on the immutable `(created_at, id)`, newest first, for both lists

Both repositories page by `created_at DESC, id DESC` with a strictly-after predicate on the
boundary row, fetching `limit + 1` rows so a next page is known without a count. The boundary's
`created_at` is carried as the text PostgreSQL prints at microsecond precision
(`packages/core/src/db/repositories/keyset.ts`), never as a `Date`, for the reason `listRuns`
already documents: a millisecond boundary would fall between two rows it has to separate.

`created_at` never changes, so a row's position in the order is fixed: every row committed before
the walk began is seen exactly once, and the walk terminates. A row committed during the walk has
no such promise. `created_at` defaults to `now()`, which is the inserting transaction's *start*
time, so a long transaction that commits mid-walk can land behind a boundary already handed out
and be missed by that walk; it is never duplicated and never displaces another row.

The session list used to be ordered by `updated_at DESC`. That key moves on every rename and every
run, so a session touched mid-walk would be skipped or seen twice. The list is now ordered by
creation. That is a visible change for a caller that relied on "recently active first"; it is the
price of a walk that is correct under concurrent writes.

No index is added and no migration is needed: `audit_events_workspace_created_idx` already serves
the audit order, and the session list was never index-ordered.

### D2 — The visibility filter moves into the session query

The handler used to read every session row and drop the ones the caller may not see. With a page
size that would produce short or empty pages whose boundary is a row the caller cannot see. The
repository now takes a `SessionVisibility` — all (Owner, Admin), one owner principal (every other
user or API-key principal), or one engine session (a runner) — and applies it in SQL, mirroring
`canAccessSession` exactly.

### D3 — The cursor names its list and its workspace

A session or audit cursor is base64url of `{ v: 1, k: <list>, w: <workspace id>, t: <created_at>,
i: <row id> }`. The server refuses with `400 invalid_cursor`, in the standard envelope, any cursor
that is not canonical base64url, not exactly those five keys, of another version, for the other
list, for another workspace, or whose timestamp or id is not in the exact shape the store mints.
It never falls back to the first page (ADR-0015).

The cursor is not signed. It is a position, not a capability: every page is still read through the
caller's workspace scope and visibility filter, so an edited but well-formed cursor can only move a
caller within rows it may already read. A signature would add a key to rotate and would refuse
nothing that matters for isolation.

### D4 — Page sizes, and a whole-list default for sessions

`GET /api/audit-events` keeps its default of 100 and ceiling of 500. `GET /api/sessions` takes a
`limit` of 1–200 (the runs ceiling). When `limit` is omitted, it answers every remaining row in one
page with `nextCursor: null`. The control plane's own team and project screens count sessions from
the unpaged list, and changing them is outside this unit. The SDK's `listAll` and the CLI's
`--all` always page.

A deployment with no session repository lists from the transcript store, which has no stable
order. It answers `400 pagination_unavailable` to `limit` or `cursor`, and `nextCursor: null`
otherwise.

### D5 — The client

`sessions.list` and `observability.audit.list` resolve the page (`{ sessions, projectKey,
nextCursor }` and `{ events, nextCursor }`). `audit.list` used to resolve the bare array; the
change is breaking and lands before the first publication. `listAll` on both walks the pages as an
async generator and refuses, as a `ContractViolationError`, a server that hands back a cursor the
walk already sent. `aw sessions list` and `aw audit list` take `--limit`, `--cursor` and `--all`.

## Consequences

- Paging either list with `limit=1` visits every row exactly once and terminates. This is tested
  against in-memory repositories in the handler tests and against PostgreSQL in the core
  repository tests.
- A foreign, cross-list or tampered cursor is a typed `400 invalid_cursor`.
- RBAC is unchanged. The audit trail is still Owner-only (ADR-0075), and the role is decided before
  a cursor is read.
- The Lean contract model of `SessionListResponseSchema` gains the nullable `nextCursor`, and its
  vectors are regenerated. No theorem changed. `AuditEventListResponseSchema` is not modelled.
- The runs cursor keeps its unbound format. Binding it the same way is a follow-up.
- No route was added and no path or method changed, so the route catalogue is unchanged.

## Alternatives considered

- **Sign the cursor with the session secret.** Rejected (D3): it adds key management for no
  isolation gain.
- **Keep `updated_at` order for sessions and accept duplicates.** Rejected: the acceptance
  criterion is "every row exactly once".
- **Default the session list to a page of 20.** Rejected for now: it would silently truncate the
  control plane's own counts.
