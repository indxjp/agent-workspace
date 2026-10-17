# ADR-W9-AUTH-118 — Three pre-session routes need edits outside this task's declared Owns globs

Status: accepted
Date: 2026-09-11
Decided by: W9-AUTH-118 implementing agent
Scope: `apps/web/proxy.ts`, `tests/route-inventory.test.ts`, `tests/auth.test.ts`, `tests/no-route-answers-503.test.ts` — none of which is on this task's `Owns globs:` line

## Context

The Wave 9 plan's W9-AUTH-118 card says to move OIDC login/callback into
`apps/web/app/api/auth/{login,callback}` and to ship `POST /api/auth/workspace`. All three must be
reachable with **no** tenant session — that is the entire reason they exist. Four repository-wide
gates enforce "every `/api/**` route requires a session" or otherwise assume a closed world over
routes, and none of them is on this task's `Owns globs:` line:

- `apps/web/proxy.ts` gates every `/api/**` request behind a valid session cookie, with a narrow,
  named exemption list — currently exactly `/api/setup` and `/api/setup/runtime-detect` — added by
  a prior task (W7-UI-04) in the same position this task is now in.
- `tests/route-inventory.test.ts`'s `routeShape` requires a dynamic `:id` immediately after the
  resource segment for any second path component; `/api/auth/login`, `/api/auth/callback` and
  `/api/auth/workspace` are literal second segments with no id, exactly the shape `/api/setup/*`
  already carries a named exception for.
- `tests/auth.test.ts` (ADR-0019: a repository-wide invariant) drives every declared route with no
  session and expects 401 for every one of them except a hand-maintained exemption list, currently
  `/api/setup` and `/api/setup/runtime-detect`.
- `apps/web/server/rbac/authorisation-matrix.test.ts`'s `PUBLIC_ROUTES` set names the routes that
  never enter the `decide()`/`Principal` classification at all — currently only
  `GET /api/setup/runtime-detect`. (This file **is** inside this task's `apps/web/server/rbac/**`
  Owns glob, unlike the three above; it is named here only because the design decision is the same
  one and belongs beside its reasoning.)
- `tests/no-route-answers-503.test.ts` spawns a real server with every optional subsystem's env
  vars set so no declared route legitimately answers 503, and equally asserts no route answers any
  *other* 5xx — a crash detector.

The plan's §2.3 mechanism for this ("prefer a design that stays inside your globs") does not apply:
there is no way to serve an unauthenticated pre-session route without touching the file that
enforces "every route requires a session," and W7-UI-04 already established that a narrow, named
exception in each of these files is how this repository extends its own pre-session surface. This
is that pattern applied a second time, not a new one invented.

## Decision

1. **`apps/web/proxy.ts`**: add `GET /api/auth/login`, `POST /api/auth/callback`,
   `GET /api/auth/workspace` and `POST /api/auth/workspace` to the existing exemption block, right
   beside the `/api/setup` one, with a comment naming why (each route does its own origin check
   where the method is unsafe, because exemption from this gate is exemption from its
   `checkRequestOrigin` call too).
2. **`tests/route-inventory.test.ts`**: add a second named, narrow exception in `routeShape` for
   exactly these three paths (`/api/auth/login`, `/api/auth/callback`, `/api/auth/workspace`),
   explicitly not generalising the shape rule.
3. **`tests/auth.test.ts`**: extend the GET/POST exemption sets the same way `/api/setup*` already
   is exempted, and add one assertion proving each of the four method/path pairs answers something
   other than 401 with no session.
4. **`apps/web/server/rbac/authorisation-matrix.test.ts`**: add the same four pairs to
   `PUBLIC_ROUTES`, on the grounds that `decide()` takes a `Role`, which only a `Principal` carries,
   and no code path in production ever constructs a `Principal` for one of these routes — there is
   no `identify()` call that could reach them, unlike `POST /api/setup`, which stays classified
   (`deny` for every role) because nothing about it is structurally unreachable through RBAC the
   way an identity-less caller is.
5. **`tests/no-route-answers-503.test.ts`**: add `OIDC_ISSUER_URL`/`OIDC_CLIENT_ID`/
   `OIDC_CLIENT_SECRET`/`OIDC_REDIRECT_URI` to the spawned server's environment (an unreachable
   `127.0.0.1:9`, the same "refuses instantly" address the file's own `RUNNER_URL` fixture already
   uses), so the OIDC subsystem is genuinely installed rather than 503-refused, and add one narrow,
   named exception for `GET /api/auth/login → 502` — the one legitimate non-503, non-2xx/3xx/4xx
   answer in the whole probe, because that route's only external dependency (the identity provider)
   is unreachable by construction in this fixed environment. The exception is proved rather than
   merely tolerated: `apps/web/app/api/auth/login/login.test.ts`'s "answers 502, not a crash" case
   fails if the `try`/`catch` around `beginOidcLogin` is removed.
6. **`GET /api/auth/workspace` is a `route.ts` that returns HTML, not a `page.tsx`.** The minimal
   selection step the card calls for therefore never enters `tests/screen-inventory.test.ts`'s
   world at all (that gate reads `page.*` files exclusively) and needs no `ui/*.html` mockup and no
   `tests/screen-declarations/**` entry — both of which are also outside this task's Owns globs, and
   for which no workspace-directory-or-switcher mockup exists yet (`#120`, W9-UI-120, owns
   `ui/workspaces.html`, in a later wave). This is a design choice recorded here rather than a
   second declared-gap workaround: the route genuinely is not a screen in the sense either gate
   cares about, the same way `apps/web/app/api/agents/route.ts` is not.

Every file in points 1, 2, 3 and 5 is declared on this task's PR body under
`Files touched outside Owns` with this ADR cited as the reason. None intersects a sibling task's
globs: `W9-PROV-126` and `W9-FILES-131` (this wave's only other tasks) own
`apps/web/server/models/**`, `apps/web/app/api/model-connections/**`,
`packages/core/src/storage/**` and `apps/web/app/api/files/**` — none of the five files above.

## Alternatives considered

- **Serve the callback and workspace-selection exchange under `/p/**` instead**, since that surface
  is already "never authenticated" by construction (§34) and needs none of the five edits above.
  Rejected: the card's Minimum implementation names the exact paths
  (`apps/web/app/api/auth/{login,callback}`, `POST /api/auth/workspace`), and `/p/**` is reserved by
  spec §34 for the public *share* surface, not for control-plane identity exchange — moving it there
  would be the same category error the issue's "Move OIDC login/callback to explicit auth routes
  instead of multiplexing public-share messages" line is written to close.
- **Convert `GAP_OWNERS` (in `no-route-answers-503.test.ts`) to per-owner, and add `W9-AUTH-118`
  to it.** Rejected: that set groups by task, and three of this task's four routes answer real,
  non-503, non-5xx statuses in the probe — only `GET /api/auth/login`'s live discovery call cannot.
  Adding the whole owner would misreport three working routes as an unwired composition-root gap,
  which is a different and false claim from the one this ADR actually needs to make.
- **Make `GET /api/auth/workspace` a real `page.tsx` with a `ui/*.html` mockup drawn for this
  task.** Rejected by the card's own words ("Deliberately not built: No workspace list screen and
  no switcher UI... a minimal selection step"): drawing a mockup is exactly the elaboration the card
  tells this task not to build, and `#120` is the task the plan already assigns the real screen and
  its mockup to.

## Consequences

- A reviewer diffing this PR against its declared `Owns globs:` line will see five files outside
  it; this ADR is the reason, and the PR body's `Ownership` section names all five with a pointer
  here.
- If `#120` (W9-UI-120) later ships a real workspace-directory screen, the `GET /api/auth/workspace`
  HTML page becomes redundant with it and should be deleted in favour of linking straight to the
  real switcher; this ADR is the record of why it existed only until then.
- The `no-route-answers-503.test.ts` exception is pinned to the single string
  `'GET /api/auth/login → 502'`; a status code change on that route without updating this exception
  is a hard failure by design; loosening it to a range would defeat the crash-detector property the
  rest of that file has.
