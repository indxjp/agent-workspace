# ADR-W9-WS-119 — `workspaces` is member-scoped, not workspace-scoped, and archive is a PATCH field

Status: accepted
Date: 2026-09-12
Decided by: W9-WS-119
Scope: `packages/core/src/db/repositories/workspaces.ts`, `packages/core/src/db/repositories/root.ts`,
`apps/web/server/rbac/{resources,permissions}.ts`, `apps/web/server/workspaces/**`,
`apps/web/app/api/workspaces/**`

## Context

Issue #119 asks for `/api/workspaces` CRUD/listing with these acceptance criteria: a user lists
exactly the workspaces they currently belong to; creation atomically creates an Owner membership;
an Owner can rename/update/archive and unauthorized users cannot; failed creation leaves no orphan;
archive is non-destructive and blocks new execution; no API can remove/demote the last Owner;
cross-workspace enumeration is prevented.

Every other resource this repository's RBAC layer (`apps/web/server/rbac/decide.ts`) authorises is
naturally scoped to the caller's own *session* workspace: `principal.workspaceId` names the tenant,
every store the composition root hands a route is opened `.forWorkspace(principal.workspaceId)`,
and `decide()`'s `any` grant width means "every row of the resource in *that* workspace" — safe,
because there is only ever one workspace a request could mean.

`workspaces` breaks that assumption by design: `#119`'s whole point is that a signed-in user can
see and act on OTHER workspaces they belong to, not only the one their current session names. A
`GET`/`PATCH /api/workspaces/:id` can legitimately name a workspace that is not
`principal.workspaceId` at all — that is the "member of two, switching" case `GET
/api/auth/workspace` (issue #118) already serves pre-session.

## Decision

### 1. `workspaces`'s grant is `own`/`own`/`none` for every one of §21's four roles, including Owner

`WORKSPACE_MEMBER_SCOPED` in `permissions.ts` is `{ read: 'own', write: 'own', run: 'none' }`,
declared as an explicit `byResource.workspaces` entry for `owner`, `admin`, `builder` and `viewer`
alike — deliberately overriding Owner's usual `EVERYTHING` fallback. `decide()`'s `applyGrant`
skips the ownership check entirely for an `any` grant: `any` means "authorised regardless of whose
row this is". If Owner's grant over `workspaces` were `any` (its default fallback), a caller whose
*session* role happens to be Owner in workspace A could `PATCH /api/workspaces/<C>` for a workspace
C they are not a member of at all, purely because `principal.role` (read for workspace A) says
"owner" — `decide()` would never consult the target workspace's own membership. `own` forces every
`:id` request through an `OwnershipResolver` that compares the caller's *real* membership of the
*target* workspace (never `principal.role`), which is the only way to ask the question `#119`
actually asks: not "is this session privileged" but "is this caller Owner of *this* workspace".

`permissions.test.ts`'s "gives Owner every operation on every resource" test is amended with one
named exception, quoting this file's own reasoning, rather than made to pass by weakening the
grant back to `any`.

### 2. Two `OwnershipResolver`s, not one, and their `own` means two different things

`apps/web/server/workspaces/access.ts`:

- `memberOwnershipResolver` — `'own'` for **any** current membership of the path's workspace id;
  concealment 404 otherwise. Used by `GET /api/workspaces/:id`: `#119`'s "Archived workspaces
  remain readable" and no clause restricts *reading* to Owner, so any member reads.
- `ownerOwnershipResolver` — `'own'` only when that membership's role is `owner`; a real member
  with a lesser role gets `'other'`, a genuine `403` (not concealed — that caller already knows the
  workspace exists, since it is in their own `GET /api/workspaces` list, so a measured `403` is not
  an existence oracle the way it would be for a non-member). Used by `PATCH`.

Both fold "workspace does not exist" and "caller is not a member of it" into the identical 404
(`workspaceNotFound()`), which is issue #117's concealment rule applied to the tenant row itself:
`getForMember(id, userId)` in the repository is one query that answers both questions at once, so
there is no window where one branch could look different from the other by accident.

### 3. Archive/restore are a `PATCH` body field, not new routes

`{ "archived": true | false }` on the same `PATCH /api/workspaces/:id` that renames, rather than a
`POST /api/workspaces/:id/archive` sub-resource. Reasons: the card's "Deliberately not built"
already rules out any lifecycle route beyond rename; a sub-resource would need its own
`SUB_RESOURCES` classification in `permissions.ts` for no behavioural benefit (the grant is
identical to rename's — Owner only); and one endpoint keeps "rename and archive in the same call"
representable, which a real caller (an admin UI closing out a workspace while relabeling it) can
plausibly want in one round trip.

### 4. Slug is caller-supplied on create, normalised inside the repository

`#119`'s amendment note says slug normalisation (trim, lower-case) happens in the repository before
`workspaces_slug_key`/`workspaces_slug_format` decide, and a normalised duplicate is the same
`conflict` outcome as an exact one. `WorkspaceRepository.create` does exactly that:
`slug.trim().toLowerCase()` before the insert, so `"Acme"` and `"acme"` collide as one `conflict`
rather than landing two rows that differ only by case. The slug is not derived from the name
server-side — the caller states it explicitly, the same shape `#119`'s verifier attack ("two
concurrent creates with the same slug") assumes, and the same shape every other natural-key
resource in this schema uses (nothing in this codebase auto-slugifies a display name).

### 5. `WorkspaceRepository`'s types stay out of `packages/core/src/db/index.ts`

That file is not in this task's `Owns` (only `schema/**`, `repositories/workspaces*.ts`,
`repositories/root*.ts`, `repositories/index.ts`), and its own header states its shape is
mechanically checked (`database-reachability.test.ts`, `scope-forgery.test.ts`) — adding a
re-export line to it would be an edit outside this task's globs. `apps/web/server/workspaces/**`
therefore reaches the repository's shape structurally, via `DatabaseRoot['workspaces']`
(`apps/web/server/workspaces/runtime.ts`), rather than importing named types
(`WorkspaceMembershipView`, `CreateWorkspaceOutcome`, …) that no path from `apps/web` could resolve
without that edit. Those types stay declared but **unexported** inside
`packages/core/src/db/repositories/workspaces.ts` for the same reason: `knip`'s deadcode gate
reports an exported symbol nothing imports by name as dead, and nothing outside that one file
imports these four by name — they still shape `WorkspaceRepository`'s public method signatures,
which TypeScript is free to reference structurally without the referenced interface needing its own
`export`.

### 6. The composition-root predicate is exported so it has a direct unit test

`register.ts`'s `Owns` cell is the exact filename with no test wildcard
(`docs/adr/W9-PLAN-the-composition-root-moved-after-the-plan-was-written.md`), so a
`register.test.ts` is a file this task cannot create. `isWorkspaceUsableForRuns` is exported as a
pure predicate and unit-tested from `apps/web/server/workspaces/register-archived-guard.test.ts` —
a file this task's wildcard `apps/web/server/workspaces/**` cell does own — rather than left as
unexported inline logic with no test at all.

## Alternatives considered

- **Scope `/api/workspaces` requests by `principal.workspaceId` like every other resource**,
  restricting `:id` to the caller's current session workspace. Rejected: it would make `GET
  /api/workspaces/:id` unable to answer for any workspace but the one the caller is already
  sessioned into, which defeats `#119`'s own listing criterion — a list of memberships nothing else
  on the list can be opened is not a workspace directory.
- **A `permitted`-shaped grant, reusing issue #117's mechanism.** Rejected: `permitted` names a
  specific mechanism (`agent_grants`) for a specific §21 sentence ("Run permitted agents"); reusing
  its name for an unrelated membership-role comparison would overload one `Grant` value with two
  unrelated meanings, which is exactly the kind of drift `decide.ts`'s header warns against.
- **A `DELETE /api/workspaces/:id/archive`-shaped route, or a dedicated `/archive` sub-resource.**
  Rejected in favour of a `PATCH` body field — see decision 3.
- **Re-export the repository's types from `packages/core/src/db/index.ts` anyway**, treating the
  one-line addition as trivial enough to not really be "a file outside Owns". Rejected: the file's
  own header states the shape is enforced by name-matching tests, and "trivial" is not a carve-out
  this plan's ownership gate recognises — a one-line diff to a file this task does not own is still
  a diff to a file this task does not own.

## Consequences

- A future task that adds a fifth role, or changes what "Owner of a workspace" means, edits exactly
  one constant (`WORKSPACE_MEMBER_SCOPED`) and two resolvers, not the whole `decide()` engine.
- `apps/web/server/workspaces/**` derives its repository record shapes via `Awaited<ReturnType<...>>`
  off `DatabaseRoot['workspaces']` rather than importing named types. A future maintainer wiring a
  new consumer of the workspace repository from `apps/web` should follow the same pattern until a
  task that owns `packages/core/src/db/index.ts` decides to widen the public barrel.
- `isWorkspaceUsableForRuns` is public API of `register.ts` now, callable (and its predicate proven)
  from outside the file — a deliberate, narrow surface increase to make the check testable at all.
