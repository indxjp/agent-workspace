# W9-UI-184 — Archive capability is the server's decision table, and the counts are what the caller can see

Status: accepted
Date: 2026-09-14
Decided by: W9-UI-184 (implementing agent)
Scope: `apps/web/components/projects/**`; `apps/web/server/projects/archive-capability.ts`;
`apps/web/app/(shell)/projects/**`; the run-history project catalogue in
`apps/web/components/run/history*`; `tests/browser/**`

## Context

Issue #184 is the UI half of the project lifecycle #182 and #183 already landed: archive and restore
usable from the project surface, a confirmation that "accurately names affected session/run counts",
an explicit archived/history filter, archived projects gone from every new-work picker, and every
async and refusal state rendered. Two of its constraints shape everything below — *"use only the
server APIs from #183"* and *"do not duplicate authorization rules in a client-side role table"*.

Four facts about the tree constrained the answer:

- `GET /api/projects` already defaults to active projects (`server/projects/http.ts`'s
  `parseProjectListFilter`), so **no picker had to be changed**: exclusion was already true, and
  what was missing was a test that fails if someone adds `?archived=all` to one.
- `POST /api/projects/:id/archive` rewrites a refused caller's 403 into the byte-identical
  `404 project_not_found` a nonexistent id gets (`server/projects/lifecycle.ts`, ADR
  W9-PROJ-183). A UI cannot explain that answer, so it must not render a control that produces it.
- Nothing published today counts a project's sessions or runs. `GET /api/runs` answers no total and
  caps a page at 200; `GET /api/sessions` has no project filter; both narrow to the caller's own
  rows for every role below Owner/Admin.
- This repository has **no jsdom and no Testing Library**. A component test is one
  `renderToStaticMarkup` pass with no effects, so an async state is testable only as a prop.

## Decision

**1. Capability is resolved on the server by the same `decide()` the routes call, and handed down as
a prop.** `server/projects/archive-capability.ts` reads the session and the directory, then asks
`decide()` for `POST /api/projects/:id/archive` twice — once with `ownership: 'own'`, once with
`'other'` — and returns `{ canArchiveOwn, canArchiveOther, viewerUserId }`. The browser's only
remaining logic is `project.createdBy === viewerUserId ? canArchiveOwn : canArchiveOther`, which is
the same comparison `requireProjectAccess` makes (`server/projects/http.ts`): a fact about the
request, not a copy of §21. If `permissions.ts` changes, the UI follows with no edit.

Every unresolvable input — no RBAC runtime, no session, no user row, no membership in the session's
workspace, an unrecognised role — answers all-false. A control that appears because a check could
not run is the failure ADR-0015 forbids.

**2. A refused caller sees no control at all, not a disabled one.** Absence is the only honest
rendering of a refusal #183 deliberately conceals; a disabled control with a reason would have to
invent the reason the server withholds.

**3. The impact counts are "what you can see", and the sentence says so.** The confirmation reads
`GET /api/sessions` (filtered client-side on `projectId`) and `GET /api/runs?project=…&limit=200`,
and renders e.g. *"3 sessions and 12 runs that you can see become read-only"*, `200+` when the run
page carried a `nextCursor`, and an explicit *"could not be counted"* when **either** read fails —
never a zero nothing established, and a half answer is one of those zeroes
(`model.ts`'s `archiveImpactFromReads`). For an Owner these numbers are exact; for a Builder they
under-report.

**4. An archived project's settings form is read-only.** `PATCH /api/projects/:id` still succeeds on
an archived project — only new work is gated — so this is a UI decision, not a server rule, and it
is reversible in one line (`project-detail.tsx`'s `archived` flag on the `<fieldset>`).

**5. `/runs` loads its project catalogue with `?archived=all`.** This repairs a real defect #184's
acceptance criteria expose rather than adding behaviour: without the filter, archiving a project
made every historical run filed under it render its project as `deleted`
(`components/run/history.ts`'s `resolveResourceReference`), contradicting *"completed run/session
history remains navigable with project attribution"*. It is the same route with its documented
filter, narrowed by role identically, and it strictly adds rows the caller may already see.

## Alternatives rejected

- **A client role table** (`role === 'owner' || (role === 'builder' && createdBy === me)`) — #184
  forbids it by name, and it would drift from `permissions.ts` silently.
- **A server probe in the style of `classifyUserFilterProbe`** — the only probe available for these
  routes is the idempotent no-op transition (`restore` on an active project, `archive` on an
  archived one). That is a **write**, and it loses a race: if another member archives the project
  between the page load and the probe, the probe silently un-archives it. A capability check must
  not be able to change state.
- **Render the control for everyone and let the 404 explain** — violates "refused users see no
  actionable control", and #183's concealment makes the 404 unexplainable.
- **Add `canArchive` or `sessionCount`/`runCount` to the project resource** — a server API change
  #184 puts out of scope. Recorded below as what an exact count would cost.
- **Per-row archive controls on `/projects`** — multiplies capability resolution across the list and
  confirms a destructive-looking action over a row whose contents the person cannot see. The filter
  is on the list; the controls are on the project.
- **A new `/projects/:id/archive` route segment** — out of scope, and the existing surface fits.
- **`window.confirm`** (`project-form.tsx`'s `confirmDiscard`) — cannot carry an impact summary that
  is still loading, and cannot be asserted by any test this repository can run.
- **Teaching the run-history "deleted" renderer to say "archived"** — it would still be guessing:
  the catalogue genuinely does not contain the row until it is asked for.

## Consequences

- No database change, no migration, no new route, no new dependency. Rollback is reverting the PR.
- The counts are the weakest part and are declared, not hidden. Making them exact means adding
  `sessionCount`/`runCount` to `ProjectResource`, computed by the workspace-scoped repositories
  `withProjects` already provides — roughly one repository method, one contract field, one route
  change and PostgreSQL-backed tests — and relaxing #184's "use only #183's APIs".
- Two extra fetches on dialog open, never on page load. `GET /api/sessions` is unpaginated, so on a
  large workspace that is a real payload for one confirmation.
- The confirmation is the first focus-managed dialog here (`shares/share-dialog.tsx` does not trap
  focus). Its focus order, Escape and Tab cycle are held honest by `tests/browser/` alone, because a
  static-markup test cannot observe focus.
- **The refusal regression is not driven by an unauthorized UI user's own cookie, because this build
  cannot mint one.** `server/auth/session.ts` implements one credential path — the bootstrap
  administrator — and `POST /api/users` writes no credential, so a provisioned Viewer cannot sign
  in. The equivalent coverage is `app/api/projects/[id]/archive/lifecycle.test.ts` (#183), which
  drives every role × ownership pair through the real handlers against PostgreSQL, plus
  `server/projects/archive-capability.test.ts`, which asserts the UI's show/hide answer equals
  `decide()`'s for the same matrix. `tests/browser/projects-archive.spec.mjs` pins the shape of the
  concealed answer with a real session cookie.
