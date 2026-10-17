# ADR-W9-AUTH-117-connectors-have-no-caller-identity — `created_by` for a resource whose routes never call `decide()`

Status: accepted
Date: 2026-09-11
Decided by: W9-AUTH-117
Scope: `apps/web/server/connectors/{runtime,http,handlers,store,memory-store}.ts`, `apps/web/app/api/connectors/route.ts`, `packages/core/src/db/schema/mcp-servers.ts`

## Context

Agents, files and skills all authorise through `apps/web/server/rbac/http.ts`'s `authorise()`,
which identifies the caller as an RBAC `Principal` (email or API-key label) before deciding
anything. Connectors do not: `docs/adr/W2-CP-05-connectors-and-test-connection.md`'s design routes
every connector request through `ConnectorsRuntime.resolveWorkspace(request)`, which answers only
"which workspace" — it was never given, and this task's globs do not include the file that would
let it be given, a way to answer "which member." `mcp_servers.created_by` is still `NOT NULL` and
tenant-paired to `memberships` (the same shape every other resource gets — the issue's own
"Relevant Code" names `mcp-servers.ts` alongside the other three tables), so `POST /api/connectors`
must produce a real value for it regardless.

## Decision

`ConnectorsRuntime` gains `identifyActor(request): Promise<{ userId: string } | null>` —
deliberately named and shaped after the identity `recordAudit`'s existing implementation already
resolves for its own audit-log actor (`identifyAuditActor` in `apps/web/instrumentation-node.ts`,
which `installConnectorsApi` already receives as a parameter). `POST /api/connectors` calls it
before creating a (non-dry-run) connector; a `null` answer refuses with `401 unauthenticated`
**before** the row is written, in place of the `500` `recordAudit` would already throw *after*
writing it if given no actor (`'connector mutation completed without an audit actor'` — read
directly out of the pre-existing `recordAudit` implementation this task did not need to change).
This is a strictly earlier, more honest failure than the one connectors already had, not a new
restriction connectors did not already impose on themselves for the same identity.

Connectors' `GET`/`DELETE`/test-connection routes are **not** given the own/other ownership check
agents/files/skills get. Building one would mean adding a first RBAC `decide()` call to a resource
that has never had one — a materially larger change than "replace `unknown` with a real value,"
and the card's own comparison list (*"Examples include `apps/web/app/api/agents/[id]/route.ts`,
`apps/web/app/api/files/[id]/route.ts`, skill item routes, and agent resource routes"*) does not
name connectors.

## Alternatives considered

- **Reach into the RBAC runtime's `WorkspaceDirectory` from the connectors route**, the same
  mechanism `apps/web/server/rbac/ownership.ts` gives agents/files/skills. Tried first, and
  reverted: `apps/web/server/connectors/routes.test.ts` — the test this task must not need
  unrelated fixtures to keep green — configures only `ConnectorsRuntime`, never
  `configureRbacRuntime`, so every create in that suite resolved to "no membership found" and
  answered `500`. Reaching for a system the resource's own architecture never wired is a coupling
  a reviewer would rightly flag; `identifyActor` needs nothing beyond what `ConnectorsRuntime`
  already assembles for `recordAudit`.
- **Fall back to the workspace's oldest Owner when no actor can be identified**, mirroring the
  `agents`/`files`/`skills` API-key fallback in `apps/web/server/rbac/ownership.ts`. Rejected for
  connectors specifically: doing so would require the same reach into an unrelated runtime the
  point above declines, for a resource whose own `recordAudit` already treats "no actor" as fatal.
  A `401` before the row exists is simpler than a fallback query, and is a strict improvement over
  the throw-after-write connectors already had.
- **Add full RBAC gating to connectors as part of this task**, closing the architectural gap
  outright. Declined by the Simplicity Mandate: it is materially more than "replace `unknown`,"
  the card's own examples do not name connectors, and it would touch `permissions.ts`'s width
  decisions this task's card explicitly rules out changing ("No change to the four roles, their
  names, or the widths `permissions.ts` defines").

## Consequences

- **Declared gap**: connector rows are attributed to the session member who created them, but
  connector item routes still perform no per-row own/other authorisation — any role currently
  granted access to the resource at all can read, rotate or delete any connector in the workspace,
  exactly as before this task. Closing that is future work, not this task's.
- An API-key-authenticated `POST /api/connectors` now answers `401` rather than creating the row
  and failing later at the audit step. This is observably different from today's production
  behaviour, and is recorded as a fix rather than a regression: the prior behaviour left a
  created-but-unaudited row behind a `500`.
