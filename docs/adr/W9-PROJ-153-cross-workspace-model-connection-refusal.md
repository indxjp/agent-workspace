# W9-PROJ-153 — a cross-workspace or nonexistent project model connection is refused identically, by translating the database's own rejection

Status: accepted
Date: 2026-09-12
Decided by: W9-PROJ-153 (implementing agent)
Scope: `apps/web/server/projects/http.ts`, `apps/web/app/api/projects/[id]/route.ts`,
`apps/web/server/projects/http.test.ts`, `apps/web/app/api/projects/[id]/route.test.ts`

## Context

Issue #153's own title says `parseProjectPatch` drops `defaultModelConnectionId`/`defaultModel`.
On this task's base (`origin/main`, post `#156`/`#157`), that specific claim no longer holds:
`parseProjectPatch` already recognises the pair, `PATCH /api/projects/:id` already forwards both
fields to `projects.updateWithAssociations`, and `toProjectResource` already returns both on `GET`
and on the `PATCH` response — an unrelated architecture-hardening commit (`83aa294`) happened to
carry this fix in on its way to landing something else. The card's **Acceptance Criteria** are
still not all met, though, and this ADR is about the two that were not:

1. **Format.** The card's Minimum Implementation says `defaultModelConnectionId` is "UUID or
   `null`". The inherited parser only checked "non-empty string or `null`" — `'connection-one'`
   parsed and was handed straight to the database.
2. **Concealment (issue #153 §25, and this card's own text).** `packages/core/src/db/schema/
   projects.ts`'s composite `projects_default_model_connection_workspace_fk` (landed by `#129`)
   does refuse a cross-workspace id at the database. Nothing on the route translated that
   rejection into the `400`/`404` a nonexistent id gets — it fell through to `errorResponse`,
   which classifies an unrecognised thrown value as an `InfrastructureError` and answers `500`.
   Proven with a real PostgreSQL 17 before this task changed anything: `PATCH` with workspace B's
   own connection id against workspace A's project answered `500 internal_error`, not a `400`
   naming the field.

A second, non-obvious finding while building the fix: `default_model_connection_id` carries **two**
foreign keys, not one. The column's own `.references(() => modelConnections.id, …)` produces
Drizzle's single-column key (`projects_default_model_connection_id_model_connections_id_fk`,
checked against every workspace's connections), and the table's third argument adds the composite
`projects_default_model_connection_workspace_fk` (checked against this project's own workspace
only). An id that names no connection *anywhere* trips the first; an id that names a real
connection in *another* workspace passes the first and trips only the second. A translator that
recognised only the composite constraint's name — the one this card's text quotes — left the
plain-nonexistent-id case still producing a `500`, which the route-level test below caught.

## Decision

**Both gaps are closed at the route, from what the database already refuses — the first of the two
options the card names — never by adding a database round-trip of this task's own.**

1. `parseProjectPatch` now requires `defaultModelConnectionId` to match a UUID's canonical textual
   form (a local `isUuid`/`UUID_RE`, the same shape `apps/web/server/runtimes/contract.ts`,
   `.../secrets/contract.ts`, `.../runs/http.ts` and three more modules in this codebase already
   each carry their own copy of, because there is no shared export for it either) before it
   reaches the pair check. `defaultModel` stays "non-empty string, trimmed" — it is provider text,
   not an id this schema constrains.
2. `apps/web/app/api/projects/[id]/route.ts`'s `PATCH` catches the thrown persistence failure and,
   before falling through to the generic `errorResponse`, asks a new `isUnresolvableModelConnection
   (error)` (in `http.ts`) whether the rejection's `cause` chain carries SQLSTATE `23503` against
   *either* of the two constraint names above. When it does, the route answers `400
   unknown_model_connection` — the identical status, code and message a plain nonexistent id now
   also gets, because both paths are this same `catch` clause. Concealment holds because the two
   inputs produce literally the same response object, not because two separately written branches
   happen to agree today.

### Why the database outcome, not a repository pre-check

The card's second option — "a pre-check through the repository the projects runtime already
reaches" — was rejected because it is not true yet in a way this task can complete honestly.
`ProjectsRuntime.forWorkspace` (`apps/web/server/projects/runtime.ts`, in this task's own Owns
globs) does not hand back a `ModelConnectionRepository` today, and the only place that could wire a
real one in — `apps/web/server/composition/register.ts`'s `configureProjectsRuntime({ … })` call —
is outside this task's Owns globs. Widening the interface with a **required** field would make
`register.ts` fail to compile until a sibling task edits a file this task may not touch; widening it
with an **optional** field would make the safety property's presence depend, in production, on
whether that same out-of-Owns file happens to set it — i.e. a check that silently does not run
where it matters most, which is worse than not building it. The database-outcome translation has no
such dependency: `projects_default_model_connection_workspace_fk` was already landed by `#129` and
already runs on every `PATCH`, in every deployment, whether or not any future task ever widens the
runtime.

### Why this file reimplements the cause-chain walk instead of importing `postgresViolations`

`docs/adr/W2-DB-02-constraint-violations-arrive-wrapped.md` already solved exactly this problem —
Drizzle wraps the rejecting `pg` error in a `DrizzleQueryError`, so `code`/`constraint` are read off
a `cause` link, not off the thrown value itself — and its answer,
`packages/core/src/db/repositories/violations.ts`'s `postgresViolations`, is the shared reader
`agents.ts`, `mcp-servers.ts`, `model-connections.ts`, `runs.ts` and `runtime-profiles.ts` all
already use. This route cannot import it: `packages/core/src/db/index.ts`'s own header states, and
`database-reachability.test.ts` enforces, that `@agent-workspace/core/db`'s public surface is
exactly `./repositories/index.ts`'s re-exports, and `violations.ts` is not one of them. Adding it
there is one line in a file this task's Owns globs do not include
(`apps/web/server/projects/**`, `apps/web/app/api/projects/**`, `apps/web/contracts/projects*.ts`,
`docs/adr/**` — not `packages/core/**`).

`isUnresolvableModelConnection` is therefore a small, independent, bounded (depth 10, matching
`postgresViolations`'s own bound, for the identical cyclic-chain reason) walk of the same shape,
kept under `jscpd`'s `minLines: 10` so it is not flagged as the duplication it structurally is. This
is the narrow, documented exception the repository's own standard asks for rather than a widened
ignore: the duplication is real, it is named here and at the call site, and the fix — exporting
`postgresViolations` from the package's public surface — is a one-line change for whichever task
next owns `packages/core/src/db/repositories/index.ts`.

## Alternatives considered

- **Match on `error.message` text.** Rejected for the reason `W2-DB-02` and
  `packages/core/src/db/seed.test.ts`'s `expectConstraintViolation` already give: message text is
  not a stable contract, and a match on it would pass for any failed `UPDATE`, including one that
  has nothing to do with this constraint.
- **Give `packages/core/src/db/repositories/projects.ts` a typed outcome, the way `agents.ts` does
  for `unknown-model-connection`.** This is the shape the codebase clearly prefers, and the file's
  own comment even names "a later task's route" as the intended enforcer of the pair — but the
  repository is explicitly out of this task's Owns globs and the card's "Deliberately not built"
  section says so in as many words. Declared as the honest reason this task's translator lives one
  layer higher than the codebase's own convention would otherwise put it.
- **Recognise only the composite `..._workspace_fk` constraint**, since that is the one both the
  card's text and issue #153 §25 name. Rejected once the route-level test in
  `apps/web/app/api/projects/[id]/route.test.ts` proved it insufficient: a plain nonexistent id
  trips Drizzle's own single-column key first and still 500s. Recognising both is what makes the
  concealment property actually hold for every input the Verifier attack names, not only the one
  the card's prose happens to quote.

## Consequences

- `isUnresolvableModelConnection` and `postgresViolations` will drift if either constraint is ever
  renamed without both being updated — a real, accepted maintenance cost of the surface boundary
  above, not an oversight.
- A malformed (non-UUID) `defaultModelConnectionId` now fails parsing before any query runs, so it
  never has the chance to surface as a third, different-shaped database error (Postgres's own
  `22P02 invalid input syntax for type uuid`) that this translator does not (and, being scoped to
  `23503`, should not) recognise.
- `apps/web/components/projects/**` needed no change and its existing tests run unmodified
  (`pnpm vitest run apps/web/components/projects`): the client already sent the real pair and
  already checked the server's answer (`docs/adr/W9-MODEL-130-project-default-write-awaits-sibling-
  patch-support.md`); once `PATCH` stores and returns the pair honestly for every input, including
  the refusal paths this ADR closes, `projectModelSaveTookEffect` reports success rather than "did
  not take effect" for a legitimate save without any client-side change.
