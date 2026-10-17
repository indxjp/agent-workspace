# W1-COMP-01 — Sign-in is a screen with a server action, not a route handler

Status: accepted
Date: 2026-09-03
Decided by: W1-COMP-01 (the composition root)
Scope: `apps/web/app/signin/**`; amends the placement half of
[W1-CP-06 — A sign-in endpoint lives outside the `/api/` prefix](W1-CP-06-sign-in-lives-outside-the-api-prefix.md),
whose CSRF obligation it discharges rather than amends

## Context

W1-CP-06 exported `signIn()` from `apps/web/server/auth/session.ts` and nothing served it. The
session used in the Wave 1a integration's end-to-end evidence was minted in-process by a scratch
launcher held outside every worktree, so no HTTP request has ever produced a session cookie in
this repository. This task's card gives the endpoint's home as `apps/web/app/api/auth/**`.

Two committed facts make that path impossible, and both were re-checked rather than assumed.

**One.** `apps/web/middleware.ts` answers 401 to every `/api/**` request without a valid session
and `paths.ts` gives no route a way to opt out — deliberately, because a gate with an exception
list is a gate somebody forgets to add to. W1-CP-06 probed `POST /api/auth/signin`,
`/api/auth/login`, `/api/login` and `/api/session` against a running server; all four were 401.
`tests/auth.test.ts` still asserts it, and this branch's own run of that suite passes.

**Two**, and this is the fact that arrived after W1-CP-06 wrote its record. W1-INT-02 landed
`tests/route-inventory.test.ts`, which enumerates **every** tracked `route.<ext>` file under
`apps/web/app` — not only under `apps/web/app/api` — derives the HTTP surface, and asserts it
*equals* the declared subset of spec §34. §34 prints no sign-in route of any kind. So a
`route.ts` at `apps/web/app/p/signin/`, which is the placement W1-CP-06's ADR names first, fails
three assertions at once: the file list is compared by name against five literal paths, the served
surface must equal the routes declared `landed`, and an entry added to `EXPECTED_ROUTES` must
appear in §34 or the gate says *"add them to the specification first"*.

## Decision

**The sign-in endpoint is `apps/web/app/signin/page.tsx` plus a `'use server'` action in
`apps/web/app/signin/actions.ts`. No route handler, no change to the gate, no change to the route
inventory, no change to the specification.**

This is the second placement W1-CP-06's own record leaves open, in its own words: *"a Next.js
server action or a form `POST` handled by a page route: the page surface is also `allow`"*.

Three things follow from it and each is a property, not a coincidence:

* `classifyPath('/signin')` returns `page`, `enforcementFor('page')` returns `allow`, and an
  unauthenticated visitor reaches the screen. Nothing about the `/api/**` rule changes.
* `tests/route-inventory.test.ts` classifies a file under `apps/web/app` as a route **only** when
  its name begins `route.`; `page.tsx` is ignored by name, and the header says so — *"Pages.
  `page.tsx` is a screen, not an API route"*. The closed world over §34 stays exactly as tight as
  W1-INT-02 left it. This branch's `pnpm test` run passes it unchanged.
* Sign-in genuinely is a screen. §34's instruction is *"expose a very small control-plane API"*,
  and a browser form submission that exchanges a password for a cookie is not part of that API.
  The placement is not a way around a gate; it is the gate being right.

**The CSRF check is written, not inherited.** W1-CP-06's record states the obligation and marks it
undone: the middleware returns early for an `allow` surface, so `checkRequestOrigin()` never runs
on this path. `signInAction` calls it first, on `POST`, against the request's own `Host` and
`X-Forwarded-Host`, and refuses with `?error=cross_origin` when the `Origin` is absent, `null` or
foreign. That is the login-CSRF defence the ADR asks for. Next.js also checks `Origin` against
`Host` for server actions on its own; this call does not depend on that, because a defence that
exists only inside a framework default leaves with the default.

## Consequences

**A `curl` can sign in, and the acceptance transcript on this task's PR does.** A server action
reached from `<form action={…}>` is submitted by the browser's own form machinery when React has
not hydrated: the rendered form carries a hidden `$ACTION_ID_<id>` field and posts to the same
URL. That is the no-JavaScript path, not a test hook, and driving it with an HTTP client exercises
exactly what a browser with scripting disabled does.

**The action id is a build artefact.** It changes when the action's module changes, so a client
that hard-codes one breaks on the next build. The transcript reads it out of the served HTML,
which is what a browser does too.

**W2-CP-06 inherits a screen rather than a blank.** `docs/adr/W1-CP-06-the-gate-covers-api-only.md`
records that pages are ungated because *"no Wave 1 task owns a sign-in page, so a redirect here
would point at a route that does not exist"*. That reason has now expired: `/signin` exists.
Turning page gating on is still one line in `enforcementFor`, and it is still not this task's
line — but the destination a redirect would need is now there.

**Sign-out has no home.** `clearedSessionCookie()` is exported and, like `signIn()` before today,
nothing serves it. Declared as a gap on this task's PR rather than added, because a sign-out
control belongs to the shell that would show it.

## Alternatives rejected

* **`apps/web/app/api/auth/signin/route.ts`, the card's own path.** 401 before the handler runs.
  Making it reachable means an exception in `paths.ts` or `middleware.ts` — the exception list
  that design exists to not have, and W1-CP-06 rejected it in writing before this task existed.
* **`apps/web/app/p/signin/route.ts`, W1-CP-06's first choice.** Correct about the middleware and
  now blocked by a gate that did not exist when it was written. Taking it would mean editing
  `tests/route-inventory.test.ts` to admit a route §34 does not print, which is the fail-open
  shape [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) and
  [W1-INT-02's record](W1-INT-02-a-repository-wide-route-rule-is-satisfied-not-narrowed.md) both
  refuse — *"an invariant that skips the two files that violate it is not an invariant"*.
* **Amend spec §34 to print a sign-in route.** The gate's failure message does say "add them to
  the specification first", and for a control-plane endpoint that would be the right move. This is
  not one, and a task that edits the product specification to place its own file has chosen the
  largest available change over the smallest correct one.
* **Leave sign-in unbuilt and declare it.** What every previous task did, correctly, because none
  of them owned a file that could serve it. This task does, and the acceptance criterion it exists
  to satisfy is a session minted over HTTP.
