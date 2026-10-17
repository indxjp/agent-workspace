# W9-TEAM-185 — Membership capability is the server's decision table, and two refusals are declared gaps

Status: accepted
Date: 2026-09-14
Decided by: W9-TEAM-185 (implementing agent)
Scope: `apps/web/contracts/team.ts`; `apps/web/server/team/**`; `apps/web/components/team/**`;
`apps/web/components/agents/model.ts`; `apps/web/components/resources/resource-screens.tsx`;
`apps/web/app/(shell)/admin/users/page.tsx`; `tests/browser/team-members.spec.mjs`;
`apps/web/server/rbac/http.ts`; `apps/web/server/rbac/routes.test.ts` (decision 7);
`apps/web/app/api/auth/workspace/route.ts` and its `workspace.test.ts` (decision 8)

## Context

Issue #185 replaces the minimal Users screen with an active-member management surface: list members,
change the roles the server permits, remove members safely, and word every refusal so a person can
act on it. Two of its constraints shape everything below — *"gate controls from server-provided
capability data; do not introduce a client-side role policy table"* and *"no API contract change"*.

Five facts about the tree constrained the answer:

- `GET /api/memberships` already carries every field the Scope asks for — `id`, `userId`, `email`,
  the joined `users.name` (#181), `role` and `createdAt` (`server/rbac/directory.ts`). `/api/users`
  was not needed at all.
- §21 gives `memberships` to Owner and Admin only (`server/rbac/permissions.ts`); Builder and Viewer
  have no entry and fall to the `NOTHING` fallback, so the list route answers them `403`.
- §21 is **not** a privilege ladder. `conferral.ts` computes conferral by grant domination, and its
  own header names the consequence: an Admin may confer Admin and Viewer, and neither Owner nor
  Builder, because §21's Admin clause omits `skills` and `files` while its Builder clause names both.
- The membership routes answer `{ error: { code, detail } }` (`server/rbac/http.ts`), while the rest
  of the application answers `{ error: { code, message } }` (`server/http/error-response.ts`). The
  one shared client reader required `message`, so every membership refusal — including the
  carefully worded `409 last_owner` — reached a screen as *"the server answered 409 without the
  usual error envelope"*.
- This repository has **no jsdom and no Testing Library**. A component test is one
  `renderToStaticMarkup` pass with no effects, so an async state is testable only as a prop.

## Decision

**1. Capability is resolved on the server by the same `decide()` and `conferRole` the routes call,
and handed down as a prop.** `server/team/membership-capability.ts` reads the session and the
directory, then asks `decide()` for `GET /api/memberships` (`ownership: 'not-applicable'`) and for
`PATCH`/`DELETE /api/memberships/:id` (`ownership: 'unknown'`) — the exact values those route files
pass — and asks `conferRole` which roles this caller may hand out. The browser is left with two
comparisons and neither names a role's powers: `userId === viewerUserId`, and "is this the only row
whose role is `owner`". If `permissions.ts` or `conferral.ts` changes, the screen follows with no
edit, and `membership-capability.test.ts` fails if the resolver ever stops asking them.

Every unresolvable input — no RBAC runtime, no session, no user row, no membership in the session's
workspace, a role §21 does not name — answers `NO_MEMBERSHIP_CAPABILITY`, all denying. A control
that appears because a check could not run is the failure ADR-0015 forbids.

**2. A refused caller sees a refusal, not an empty table.** Unlike #184's concealed 404, this
refusal is explainable: the route answers a plain `403` and §21 is public. The screen says managing
members is not part of this caller's role and names who to ask. An empty members table would be a
claim ("this workspace has nobody in it") the response never made.

**3. The last Owner's controls are withheld on the row, with the reason on the row.** The count is
the client's — one pass over the list the server just returned — and the *rule* stays the server's:
`409 last_owner` still refuses a direct `PATCH` or `DELETE`, and `tests/browser/team-members.spec.mjs`
drives that with the same cookie the UI scenarios use.

**4. Removal impact is counted from landed list endpoints, and a missing count is said out loud.**
The confirmation reads `GET /api/sessions` and `GET /api/projects?archived=all`, counts the rows
naming the member, and renders e.g. *"2 sessions and 1 project stay in this workspace and keep
naming this member"*. Unlike #184's counts these need no "…that you can see" hedge: only Owner and
Admin reach this screen, and both list routes show them every workspace row. Two things still route
to an explicit `impact-unavailable`: either read failing, and a **session row with no `userId` at
all** — `server/sessions/api.ts`'s store fallback answers that shape in a deployment with no
sessions repository, and counting it would print a confident `0` for a member who owns many.

**5. The shared error reader accepts both envelope spellings.** `isApiErrorEnvelope` now requires a
`code` plus **either** `message` or `detail`, and `describeRequestFailure` reads whichever is
present. Strictly additive, covered by the existing `message` cases, and it is what makes decisions
2–4's wording possible: every typed refusal now reaches the screen in the server's own sentence.

**6. The Add-user form is deleted with `UsersScreen`.** `POST /api/users` keeps its route and its
tests; what it loses is its only browser control. #122 calls that form misleading — it implies
immediate access is a safe invitation flow when it is not — and the invitation UI is the next step
of this wave. Between the two, a member can be added only through the API.

**7. `toResponse` gets the empty arm every 204 needs — a repair outside this issue's stated
boundary, taken under ADR-0018.** `deleteMembership` has answered `{ status: 204, body: null }`
since W2-CP-06, and `server/rbac/http.ts`'s `toResponse` serialised every result the same way:
`new Response(JSON.stringify(result.body), …)`. `JSON.stringify(null)` is the string `"null"`, and
the `Response` constructor rejects any body on a 204 — so `DELETE /api/memberships/:id` threw
`TypeError: Response constructor: Invalid response status code 204` and answered `500`. It now
returns `new Response(null, { status, headers: { 'cache-control': 'no-store' } })` for the empty
arm, which is the decision `apiResultResponse` (`server/http/json-transport.ts`) and
`server/agents/http.ts`'s own `toResponse` already made.

This is a server file #185 puts out of scope, and the reason it is here anyway is the one ADR-0018
recognises: the task could not complete without it. The defect is **compiler-independent** — every
type checks, `{ status: number; body: unknown }` says nothing about which statuses may carry a body
— so nothing but an executed request could have found it, and it was **found by this task's own
required test**: the browser job's *"removes a member by keyboard"* and *"keeps the members screen
accessible"* scenarios fail on it in all four project × case combinations, because the removal
dialog waits for a response the route never gives. An acceptance criterion that names a keyboard
removal cannot be met while removal 500s. It is declared here and on the PR's `Owns globs:` line,
which is what ADR-0018 makes the control rather than the silence.

The regression is in `server/rbac/routes.test.ts` rather than beside `http.ts`: what broke was the
route's answer, not a helper's return value, so the test drives the real `DELETE` handler through
the harness and asserts 204, an empty body, and no `content-type` describing a body that is not
there. Reverting the fix reproduces the exact `TypeError` CI logged.

Nothing else changes shape. `deleteMembership` is the only handler reaching this `toResponse` with
an empty arm; every other result still serialises with the same `content-type` and the same
`cache-control`.

**8. `/api/auth/workspace` answers a relative `Location` — the second repair outside this issue's
stated boundary, taken under ADR-0018 for the same reason as decision 7.** `redirectTo` built an
absolute URL with `new URL(path, request.url)`. `request.url`'s origin is the address this server is
*bound* to, not the address the client used, and the two differ behind a reverse proxy, a container
port map, or a plain host alias. Under Playwright the alias is the whole defect: the server binds
`localhost:3000`, `baseURL` is `127.0.0.1:3000`, so a successful switch answered
`303 Location: http://localhost:3000/`, the browser followed it to a **different origin**, the
session cookie just minted for `127.0.0.1` was not sent, and `/` bounced to `/signin`. Every
redirect this route issues now carries the path alone —
`new NextResponse(null, { status: 303, headers: { location: … } })` — which is valid per RFC 9110
§10.2.2 and resolves against whatever origin the request was actually made on. The cookies still
ride on that same response; only the header changed.

The `Host` and `X-Forwarded-Host` headers would name the caller's origin, and both are
caller-supplied — building a redirect target from them trades this defect for an open redirect. A
relative reference needs no origin at all, which is why it is the answer rather than a mitigation.

The regression is in the route's own `workspace.test.ts`, asserting the `Location` as a **whole
string** at every redirect the route has (`/`, `/signin?error=session_expired`,
`/api/auth/workspace?error=workspace_not_available`) rather than through `new URL(...).pathname` —
parsing is precisely what hid this, since `new URL('https://elsewhere.test/').pathname` is also
`/`. Restoring the absolute build fails six of the eight cases.

**Where else the root cause reaches, enumerated from the code (ADR-0048), and not repaired here.**
`grep` for a `Location` built from `request.url` finds three more sites, all outside the globs this
PR declares and none of them on the failing scenario's path:
`apps/web/app/api/auth/callback/route.ts` lines 167, 184 and 192, and `apps/web/proxy.ts` line 105.
`apps/web/app/api/auth/login/route.ts` line 41 is *not* a site — it redirects to the identity
provider, where an absolute URL is the only correct answer. **The class is open**, and saying so is
the point: ADR-0048's own warning is that a partial repair plus a total claim retires the question.
Closing it needs the callback route and the proxy on an `Owns globs:` line, which is a separate
change.

**9. The members table scrolls horizontally inside its card, because on a phone it does not fit.**
Four columns — one of them an address — measure 519px at the Pixel 7 viewport, inside a 346px card,
and the actions column is last. With no scroll container the table overflowed the card *and* the
layout viewport, leaving the Remove button at x 459–536 with nothing able to bring it back:
Chromium's mobile emulation scaled the layout viewport out to 552px instead of giving the document
a horizontal scroll, and Playwright's click retried 56 times against a hit test that resolved to
whatever happened to be under the unscrolled coordinates — the `<td>`, the `<select>`, the `<h1>`.
That is a control an Owner cannot reach on a phone, so it is an accessibility defect of the screen,
not a flake of the spec, and the spec is left exactly as it was. A `<div className="overflow-x-auto">`
immediately around the table — the wrapper `components/agents/agents-list.tsx`,
`components/run/history-screen.tsx` and `components/resources/resource-screens.tsx` already put
around their own wide tables — makes the overflow the card's to scroll. Inside the card rather than
on it, so the card's border and radius stay where they are. Desktop is unchanged: at 1280px the
table is 914px in a 914px wrapper and the container never scrolls.

The measurement above is this task's, taken by rendering the real component with the production CSS
at both Playwright projects' viewports; it is recorded here rather than in the code, per ADR-0016.
The regression test is the browser spec's own mobile-chromium run. `members-table.test.tsx` adds
only the static half — that the wrapper exists and sits between the card and the table — because a
`renderToStaticMarkup` pass cannot measure a layout, and that limit is the one this ADR's context
already names.

## Alternatives rejected

- **A client role or conferral table** — #185 forbids it by name, and it would drift from
  `permissions.ts` and `conferral.ts` silently.
- **A capability probe** — the only no-op `PATCH` available is "set the role this member already
  has", which is a real write through `changeMembershipRole` and a real audit event. #184 rejected a
  probe for archive because it loses a race; here it is worse.
- **A privilege ordering for the role `<select>`** (`owner > admin > builder > viewer`) — the
  ordering §21 does not have. It would offer an Admin the option to confer Builder, which the route
  answers `403` to.
- **Adding `capability` or impact counts to the membership API** — a server API change #185 puts out
  of scope, and #184 established that a client-side count is acceptable here.
- **A team-local copy of the error-envelope reader** — `jscpd` would flag it, and widening the one
  shared reader is the smaller, reviewable change.
- **Rendering the mockup's static "What each role can do" matrix (`ui/users.html`)** — a role policy
  table in the client by another name.
- **Patching the changed row locally after a `PATCH`** — the last-Owner count the controls are gated
  on is a property of the whole list, so each mutation re-reads it.
- **Making `deleteMembership` answer `200 {}` instead, to keep `toResponse` untouched** (decision 7)
  — it changes the wire contract #185 forbids changing, and it leaves the same trap set for the next
  handler that writes an honest 204. The defect is in the transport, so the repair is too.
- **Treating the 500 as an environment problem and only retrying the browser job** — the route is
  broken on `main` for every caller, not only under Playwright; the four failing cases are the first
  thing in the repository to have executed a successful removal.
- **Changing the Playwright `baseURL` to `localhost`, so it matches the server's bind address**
  (decision 8) — it makes the symptom go away and leaves every deployment behind a reverse proxy
  redirecting to the wrong origin. The test was right about what it saw.
- **Building the redirect from `Host` or `X-Forwarded-Host`** (decision 8) — both are
  caller-supplied, and the result is an open redirect on an unauthenticated endpoint.
- **A sticky or fixed actions column on the members table** (decision 9) — it is the shape the
  Playwright log's "a `<td>` intercepts pointer events" suggests, and it would have *created* the
  overlap it looks like. The table had no scroll container at all; the repair is to give it one.
- **`whitespace-nowrap` off, or a narrower address column, to make the table fit 390px** — it makes
  the fit a property of the data. One long address and the actions column is off-screen again.

## Consequences

- No database change, no migration, no new route, no API contract change, no new dependency.
  Rollback is reverting the PR; it restores the previous `UsersScreen` — and, note, restores the
  `500` decision 7 repairs.
- Decision 7 changes what `DELETE /api/memberships/:id` puts on the wire for a successful removal,
  from a `500` to the `204` its declaration always said. Every other route sharing this
  `toResponse` is unaffected: `body === null` and `status === 204` occur together in exactly one
  handler.
- Decision 8 changes what every caller of `/api/auth/workspace` receives as a `Location`, from an
  absolute URL on the server's bind address to the path alone. A deployment whose clients reach it
  on the same origin the server binds sees no difference; one behind a proxy, a port map or a host
  alias stops being redirected off its own origin. Nothing else reads this header.
- Decision 9 changes the members table on narrow viewports only. Where the table already fits — any
  desktop width — the container never scrolls and nothing moves.
- Two extra fetches on confirmation open, never on page load. `GET /api/sessions` is unpaginated, so
  on a large workspace that is a real payload for one confirmation.
- Widening `isApiErrorEnvelope` touches a reader shared by the agents, projects, runs and shares
  screens. It is additive — a body that was an envelope before still is — and it is the one change
  here with blast radius beyond this screen.
- **Declared gap 1: Builder and Viewer scenarios cannot be driven through a browser.**
  `server/auth/session.ts` implements one credential path (the bootstrap administrator, an Owner)
  and neither `POST /api/users` nor invitation acceptance writes a password, so an unauthorized
  *session* cannot exist here — `tests/browser/projects-archive.spec.mjs` declares the same gap.
  The equivalent coverage is `server/team/membership-capability.test.ts` (the UI's answer equals
  `decide()`'s and `conferRole`'s for the whole matrix), `server/rbac/authorisation-matrix.test.ts`
  and `server/rbac/routes.test.ts`. The refusal that **is** reachable with a real cookie — the
  last-Owner `409` — is asserted in the browser spec. ADR-0035 is the rule this follows: an
  acceptance criterion needing a resource this deployment lacks is a declared gap, not a claim.
- **Declared gap 2: removing a member who still owns a session is refused by the database, not by a
  typed error.** `sessions_member_workspace_fk` (`packages/core/src/db/schema/sessions.ts`) rejects
  the delete, `packages/core/src/db/repositories/directory.ts` has no branch for a foreign-key
  violation, and the membership routes are not inside `server/http/route-error-boundaries.ts` — so
  the refusal arrives as a `500` with no envelope. This screen words it from the count it just made
  and says so honestly; it cannot name it as the server. The clean fix is a typed `409` (for example
  `member_owns_sessions`) from `DELETE /api/memberships/:id`, owned by that repository and
  `server/rbac/handlers.ts`, which #185's Out-of-scope section puts outside this PR. Until it lands,
  *"remove eligible members"* means members with no sessions. The AC it does satisfy by
  construction is the opposite one: history cannot be erased by a removal, because the database
  refuses to let it be.
