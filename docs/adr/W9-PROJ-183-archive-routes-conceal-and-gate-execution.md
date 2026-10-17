# W9-PROJ-183 — Archive/restore conceal their refusal, audit the transition, and gate execution in one module

Status: accepted
Date: 2026-09-13
Decided by: W9-PROJ-183 (implementing agent)
Scope: `POST /api/projects/:id/archive` and `/restore`; the archived-project execution gate at every
server-side session/run creation seam; the project contract's `archivedAt`; the two new audit
actions and their migration

## Context

Issue #183 (W9-R3 child of #124, depending on #182) asks for the HTTP half of the project
lifecycle #182 landed in `packages/core`: two routes, authorised for the workspace Owner or an
eligible creator, **concealed like a nonexistent id** for everyone else, audited on each real
transition, and backed by a refusal of every new session and run for an archived project — while
work that predates the archive may finish and history keeps resolving its project.

Four things about the tree shaped the decisions below:

- `ProjectRepository.archive`/`restore` are already idempotent and already workspace-scoped, so a
  foreign id and a nonexistent id are the same `null` before any policy runs
  (`packages/core/src/db/repositories/projects.ts`).
- `GET`/`PATCH /api/projects/:id` answer **403** for a refused caller
  (`apps/web/app/api/projects/[id]/route.ts`), which is not what #183 requires of these two routes.
- `apps/web/server/rbac/permissions.ts` already encodes exactly #183's policy — Builder
  `projects: OWN_ONLY`, Owner `EVERYTHING`, Admin and Viewer no project clause — so no grant
  changes here, as
  [W9-PLAN-project-lifecycle-follows-the-existing-project-grants](W9-PLAN-project-lifecycle-follows-the-existing-project-grants.md)
  decided.
- The archived-**workspace** boundary is the same problem one level up, and
  [W9-WS-119-run-gate-module-and-project-sessions](W9-WS-119-run-gate-module-and-project-sessions.md)
  finding 2 already records the way it goes wrong: a unit test of the predicate proves nothing
  about the call sites, because deleting them leaves it green.

## Decision

**1. Concealment is a mapping of the refusal, not a second policy.** The shared handler
(`apps/web/server/projects/lifecycle.ts`) fetches the project, answers `404 project_not_found`
when it is `null`, calls the same `requireProjectAccess` every other project route calls, and
rewrites **only a 403** into the byte-identical 404. A 401 stays a 401, a 503 stays a 503, and a
500 stays a 500. There is one authorisation decision in this codebase, and this route does not add
a second one — it changes what a refusal is allowed to say.

This is a deliberate divergence from `GET`/`PATCH /api/projects/:id`. #183 requires a non-creator
Admin or Builder to be indistinguishable from a caller naming an id that does not exist; the
sibling routes were not written to that requirement and are not this task's to change.

**2. Audit the transition, not the request.** `archive` is idempotent by construction, so the
handler compares the pre-image's `archivedAt` with the post-image's and writes `project-archived` /
`project-restored` only when the state actually changed. Archiving twice is `200` with the same
timestamp and **one** audit row, which is what makes "each successful transition produces an audit
event" checkable by counting rather than by reading the code. The write is best-effort, following
`POST /api/projects`: the transition has already committed, so a failed audit write is logged as an
`InfrastructureError` rather than turned into a 5xx that would invite a retry of a write that
already happened.

**3. The execution gate is one module, composed at every seam.**
`apps/web/server/projects/archive-gate.ts` exposes `isProjectUsableForNewWork`, a `ProjectRunGate`
closed over the scoped `ProjectRepository`, and `guardProjectSessionCreation`. A repository-wide
search for session and run creation finds exactly four server-side seams plus one downstream, and
each is one line delegating here:

| Seam | Refusal |
| --- | --- |
| `POST /api/projects/:id/sessions` (start **and** move) | `409 project_archived`, after the access check |
| `configureProjectsRuntime`'s session provider | `ensure → { kind: 'not-a-member' }` |
| `openSession`'s resume branch (`register.ts`) | `null`, which `startRun` turns into `409 session_not_usable` |
| `runPublic` (`register.ts`), the public run path | throws before `ensure`/`store.create` |
| `startRun` (`runs/api.ts`) | always downstream of `openSession`; covered by that seam |

`apps/web/server/projects/archive-gate-integration.test.ts` drives the closures `register()`
actually installs, against a real database, so each of those lines is load-bearing rather than
merely present — the repair W9-WS-119 had to make after the fact.

**4. The predicate lives once, in `packages/core`.** `isProjectArchived` was written by #182 but
not re-exported from `@agent-workspace/core/db`. Two additive export lines make it reachable
instead of a second `archivedAt !== null` being written in `apps/web`.

**5. The archived state is published.** `ProjectResourceSchema` gains
`archivedAt: z.iso.datetime().nullable()`. Without it these routes answer with a body identical to
an active project's, and the lifecycle state would be write-only over HTTP.

**6. `GET /api/projects` gains `?archived=active|archived|all`, defaulting to `active`.**
[W9-PROJ-182](W9-PROJ-182-archived-at-is-the-project-lifecycle-primitive.md)'s consequences record
an obligation on this task — *"The follow-up must not land the route without a filter control"* —
because the repository already hides archived projects from the default listing. The default
response is unchanged for every existing caller; an unrecognised value is a typed `400`, never
silently the default. Issue #183 puts project **UI** out of scope, and this is server-side only.

## Alternatives rejected

**Return 403 like the sibling project routes.** Rejected: the issue requires concealment by name.
The inconsistency it creates is real and is declared here rather than hidden.

**Conceal a 401 too.** Rejected: it would make a missing credential indistinguishable from a wrong
one, and it answers a question the caller never got far enough to ask. Asserted by a named test.

**Put the archived check inside `ProjectRepository`/`SessionRepository`.** Rejected: the refusal is
a server-boundary policy with an HTTP shape, and #182's contract deliberately keeps `get`/`list`
readable for archived projects so history resolves.

**Inline `project.archivedAt !== null` at each of the four seams.** Rejected by W9-WS-119
decision 1 — the identical mistake was made and repaired one wave ago for workspaces.

**A `PATCH /api/projects/:id { archived: true }` field.** Rejected: the issue names two routes,
`UpdateProjectPatch` deliberately omits the column, and a transition that must be audited is not a
field edit.

**Reuse `project-deleted` for the archive audit action.** Rejected: nothing is deleted, and there
is no existing value that could carry a restore at all.

**Refuse moving a session *out* of an archived project.** Rejected: the gate reads the
**destination**, so live work can leave a retired project instead of being stranded in it. Moving
*into* one is refused, because it attaches live work to an archived project — #183's scope says
"every new session and run", and a move is neither, so this is a decision rather than a reading.

## Consequences

- **Archive and restore answer 404 where their sibling routes answer 403.** Intentional, required,
  and the one place in the project API where the two disagree.
- **Four files outside the issue's stated ownership are edited**, each forced by the change and
  declared on the PR's `Owns globs:` line per
  [0018-the-declared-owns-line-is-the-ownership-boundary](0018-the-declared-owns-line-is-the-ownership-boundary.md):
  `packages/core/src/db/schema/audit-events.ts` and `migrations/**` (the action list carries a
  database `CHECK`, so a generated migration is unavoidable — the `migrations/0016_next_satana.sql`
  precedent), `packages/core/src/db/{index,repositories/index}.ts` (two export lines for
  `isProjectArchived`), and four `ProjectResource` fixture literals under `apps/web/components/**`
  that the now-required `archivedAt` field makes a compile failure.
- **The migration only widens a `CHECK`.** No backfill, no rewrite; rollback is the inverse `CHECK`
  plus reverting the route files. `archived_at` itself is #182's and stays.
- **Active work is untouched.** Only creation paths are gated, so a run in flight when its project
  is archived finishes normally, and `GET /api/projects/:id` plus the run list's project filter
  still resolve an archived project's history. Both are asserted, not assumed.
- **A failed audit write does not fail the request.** The transition has committed by then; the
  gap is that a lifecycle change can, in principle, go unrecorded. It is logged, and it stays a gap
  until auditing can participate in the repository transaction.
- **No project UI.** An archived project is now reachable only through `?archived=`, which is the
  API surface a later UI child of #124 will use.
