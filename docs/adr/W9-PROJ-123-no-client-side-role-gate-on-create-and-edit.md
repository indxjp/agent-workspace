# W9-PROJ-123 — Create and edit controls are not hidden client-side for a Viewer

Status: accepted
Date: 2026-09-11
Decided by: W9-PROJ-123 (implementing agent)
Scope: `apps/web/components/projects/projects-screen.tsx`, `apps/web/components/projects/project-detail.tsx`

## Context

The task card's Verifier attack 3 reads: "Sign in as a Viewer and assert the create and edit
controls are absent, then `POST /api/projects` directly with the Viewer's cookie and assert the
server refuses — the UI gate is not the security boundary." The second half is unambiguous and is
what this task builds: every create and edit request goes through the existing, unmodified
`requireProjectAccess`/`requireResourceAccess` chain in `apps/web/server/projects/http.ts`, and a
`403` it returns is rendered verbatim by `ProjectProblem` (`../model.ts`'s `describeRequestFailure`),
never swallowed or retried.

The first half — hiding the New Project button and the settings form's fields for a Viewer — needs
a *client-side* answer to "what is my role in this workspace", and no such answer exists inside this
task's Owns globs:

- `apps/web/app/(shell)/layout.tsx` already resolves the session's role server-side
  (`roleLabel(session.role)`) and could pass it down, but the Wave 9 shared-file table
  (the Wave 9 plan §"Shared files, assigned per wave") assigns that file `—` for W9.1 —
  no task in this wave may change it.
- `GET /api/projects` and `GET /api/projects/:id` (`server/projects/http.ts`, not on this task's
  Owns line) return the project row and its associations; neither response carries the caller's own
  role or a `canEdit`-shaped flag.
- `GET /api/memberships` and `GET /api/users` list the *workspace's* members, not "which one is me",
  and are themselves access-controlled in ways this task has not verified — building a role check on
  top of a list endpoint neither of those routes was designed to answer is exactly the kind of
  incidental coupling the Simplicity Mandate rules out for a card whose Minimum implementation names
  nothing like it.

## Decision

**No client component in this task's Owns globs computes or consults the caller's role.** The New
Project button and every edit field always render for whoever can load the page; the security
boundary is, and remains, the server's `403`, rendered the same way every other server-worded
failure is.

## Alternatives considered

**Add a `/api/users/me`-shaped endpoint.** Rejected: a new server route is outside this task's Owns
globs (`apps/web/app/api/**` is not on the W9-PROJ-123 card), and inventing one crosses into the
identity/RBAC surface `W9-AUTH-117` and `W9-WS-119` own in other wave slots.

**Widen this task's Owns globs to include `apps/web/app/(shell)/layout.tsx`.** Rejected outright:
the shared-file table assigns that file to nobody in W9.1; a task widening its own declared globs to
reach a file the plan explicitly withholds is the "planning defect, not something to code around"
case the dispatch instructions name, and it would also collide with `W9-AUTH-118`'s and
`W9-TEAM-121`'s later, planned edits to the same file.

**Read `GET /api/memberships` from the client and match the caller's own user id.** Rejected: that
route's access rules were not verified as part of this task, there is no client-visible "this is
your own id" value to match against without another RBAC-owned endpoint, and a role guess built on
a list this task does not own is a more fragile, more surprising failure mode than simply not
guessing.

## Consequences

- A Viewer sees a New Project button and editable fields that a `POST`/`PATCH` will refuse. This is
  the honest state given the constraint above: the screen does not pretend to know a fact it has no
  correct way to obtain in this wave, and the actual authorisation decision — the one that matters —
  is unaffected.
- **Declared gap**, carried into the PR body: the create/edit controls are not hidden for a Viewer.
  A later task in the wave that is assigned `apps/web/app/(shell)/layout.tsx` (or a role-carrying
  endpoint) can pass a role down to `ProjectsScreen`/`ProjectDetail` as a prop; both already accept
  their data as props/fetches rather than reading a global, so wiring a role through would not
  require restructuring either screen.
- The task card's own wording — "duplicate-name, invalid-association, `403` and `409` responses are
  rendered as the server worded them" — is fully satisfied regardless: a Viewer's refused request is
  shown, not swallowed, which is the half of Verifier attack 3 that actually tests the security
  boundary.
