# W9-PROJ-182 — `archived_at` is the project lifecycle primitive, and `list()` defaults to active

Status: accepted
Date: 2026-09-13
Decided by: W9-PROJ-182 (implementing agent)
Scope: `projects.archived_at`; `ProjectRepository`'s `list` / `archive` / `restore` — repository
layer only, no route, authorisation, audit or UI

## Context

Issue #182 (W9-R2 child of #124) asks for "the durable, non-destructive archived state and
repository lifecycle primitives for projects, without adding routes or UI yet", constrained to
"exactly one migration with nullable `projects.archived_at`" and required to keep session and run
attribution intact across both transitions.

Two archive precedents already exist in the tree and they disagree with each other:

- **`workspaces`** — a nullable `archived_at timestamptz` with no CHECK
  (`packages/core/src/db/schema/workspaces.ts`), archived idempotently with
  `set({ archivedAt: sql`coalesce(archived_at, now())` })`, and read through a shared
  `isWorkspaceArchived` predicate that is deliberately **not** barrel-exported.
- **`sessions`** — a `status` enum, whose `SessionRepository.list(status?)` with **no argument
  returns every status**.

The issue names `archived_at` explicitly, so the column shape is not really open; what the two
precedents do force a choice about is the default meaning of an argument-less `list()`, which they
answer in opposite ways.

## Decision

**Mirror the `workspaces` timestamp precedent end to end, and make `ProjectRepository.list()`
default to `'active'` — the one place this task deliberately diverges from `SessionRepository`.**

1. **A timestamp, not a status enum or a boolean.** One nullable `archived_at timestamptz`; NULL
   means active. A timestamp records *when* alongside *whether* with no second column, and it is
   what makes idempotence structural rather than conditional (see 3).
2. **No CHECK, no partial unique index, no new index.** `workspaces.archived_at` carries none, and
   `coalesce(archived_at, now())` cannot produce a timestamp before `created_at`, so a
   `projects_archived_after_created` check would guard a state the only writer cannot reach.
   `projects_workspace_name_key` stays **unconditional** — see Consequences for what that costs.
3. **Idempotence is structural.** `archive` writes `coalesce(archived_at, now())`, so a second
   archive keeps the moment the project was first archived instead of moving it forward; `restore`
   writes an unconditional `null`. Both `.returning()` the row, so a repeated call leaves
   `archived_at` where it is and still answers with the project — no caller needs a "was it already
   archived" branch. It is not a whole-row no-op, though: `updated_at`'s `$onUpdate`
   (`packages/core/src/db/schema/columns.ts`) rewrites that timestamp on every `update().set()`
   Drizzle issues, so a repeated `archive`, and a `restore` of a project that was never archived,
   still move `updated_at` — which is part of the wire contract. `archive` and `restore` are scoped
   by the same `and(workspaceId, id)` predicate every other method on this repository uses, so a
   cross-tenant id is `null` and writes nothing.
4. **`list(filter: ProjectListFilter = 'active')`**, with `ProjectListFilter = 'active' |
   'archived' | 'all'`. The acceptance criterion is "default project listing excludes archived
   projects", and the only route that reads this list (`apps/web/app/api/projects/route.ts`) is
   outside this task's ownership — so the default has to hold at the repository contract or it does
   not hold at all. A named union rather than an `includeArchived` boolean: a bare `true` at a call
   site says nothing about what it includes, and a boolean cannot express "archived only", which is
   exactly what the issue's "history-oriented callers request archived projects explicitly" needs.
   `'all'` ships now because a later lifecycle view wants a combined list and an unused union member
   costs nothing.
5. **`get`, `moveSession` and both `*WithAssociations` methods stay unfiltered.** History-shaped
   reads go through `get` — `apps/web/server/composition/register.ts` resolves a run's project by
   `sessions.project_id -> projects.get(...)` — so filtering `get` would make an archived project's
   own run history unreadable, which is the opposite of non-destructive.
6. **`archivedAt` is not patchable.** It is deliberately kept out of `UpdateProjectPatch`, so the
   existing `PATCH /api/projects/:id` cannot set or clear it. `archive` and `restore` are the only
   writers of the column.
7. **`isProjectArchived` is exported from its module but not from the barrels**, following
   `isWorkspaceArchived` exactly: a barrel export with no consumer trips `pnpm deadcode:check`.
8. **`sessions.project_id` and its foreign key are untouched.** Attribution survives by
   construction, not by a guard — and the suite asserts it positively rather than claiming it.

**The deliberate inconsistency, stated plainly:** `SessionRepository.list()` with no argument
returns everything; `ProjectRepository.list()` with no argument returns active projects only. A
reader moving between the two files will not be able to infer one from the other. The mitigation is
the named `ProjectListFilter` type, a doc comment on `list` that states the default *and* names the
divergence, and a load-bearing test
(`'list() excludes an archived project (load-bearing: deleting the active filter fails here)'`)
that fails by name if the filter is ever dropped.

## Alternatives considered

**Reuse the `sessions` `status` enum shape.** Rejected: the issue names `archived_at`, a timestamp
keeps *when*, and `coalesce` gives idempotence with no outcome branch. An enum would have needed
either a second column for the timestamp or the loss of it.

**`list(includeArchived?: boolean)`.** Rejected: unreadable at the call site, and structurally
unable to express "archived only".

**A separate `listArchived()`.** Rejected: two list methods drift, and the ordering and tenant
predicate would be written twice.

**Default `list()` to `'all'` and filter in the route.** Rejected: the route is outside this task's
ownership, and the acceptance criterion would then not hold at the only layer this task ships.

**Make `archive`/`restore` optional interface members** to avoid the one fixture repair outside
`packages/core/src/db/**`. Rejected: an optional member weakens the contract permanently to avoid
two of the thirteen compiler-forced lines; the other eleven (`archivedAt: null` on each
`ProjectRecord` literal) are forced by the new column, not by the interface, and would remain.

**A partial `projects_workspace_name_key WHERE archived_at IS NULL`** (the pattern
`invitations_workspace_email_pending_key` uses). Rejected here: it exceeds "exactly one migration
with nullable `projects.archived_at`", and it would let `restore` fail on a name collision with a
project created after the archive — a new failure mode on an operation that currently cannot fail.

## Consequences

- **`GET /api/projects` now returns active projects only**, with no edit to that route. It is a
  no-op in practice today: nothing can write `archived_at` yet, because this task ships no route.
- **An archived project still occupies its name.** A workspace cannot create a new project reusing
  an archived one's name until someone decides the partial-index question above. That decision
  belongs to the task that ships the archive route, together with what `restore` should do when the
  name has been taken in the meantime.
- **There is no archived view in the UI.** Once a later task under #124 adds the archive route, an
  archived project vanishes from `apps/web/components/projects/projects-screen.tsx` with no way
  back through the interface. The follow-up must not land the route without a filter control.
- **Rollback is `ALTER TABLE projects DROP COLUMN archived_at;`** — but only before any row carries
  a non-null value, since the column is the only place the archived state lives. The migration is
  additive and nullable, so it needs no backfill.
- **One file outside the issue's stated ownership** (`migrations/**`, `packages/core/src/db/**`) is
  edited: `apps/web/app/api/projects/[id]/sessions/sessions.test.ts` builds a `ProjectRepository`
  object literal and eleven `ProjectRecord` literals, so adding two required interface members and
  one required record column makes it a repo-wide compile failure that cannot be avoided from
  inside `packages/core`. The repair is thirteen mechanical lines: two interface members following
  the literal's own `unused` convention — which the `SessionRepository` literal directly below it
  already carries for these same two names — plus `archivedAt: null` on each of the eleven record
  literals, forced by the new column rather than by the interface. Declared on the PR's
  `Owns globs:` line per
  [0018-the-declared-owns-line-is-the-ownership-boundary](0018-the-declared-owns-line-is-the-ownership-boundary.md),
  following the `W9-MODEL-129` precedent.

## Related

- [W9-PROJ-125-project-resources-narrow-never-widen](W9-PROJ-125-project-resources-narrow-never-widen.md)
  — `moveSession`'s refusal, the other half of keeping a run's project attribution historical.
- [W9-WS-119-workspace-resource-authorisation-and-lifecycle](W9-WS-119-workspace-resource-authorisation-and-lifecycle.md)
  — the `workspaces.archived_at` lifecycle this one mirrors.
- [0015-gates-decide-on-positive-assertions](0015-gates-decide-on-positive-assertions.md) — why the
  "no hard delete" case asserts the row is present rather than asserting nothing objected.
- Issue #124 — the parent card that owns the routes, authorisation, audit and UI this task omits.
