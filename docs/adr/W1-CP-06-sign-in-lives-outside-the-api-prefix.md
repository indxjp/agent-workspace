# W1-CP-06 — A sign-in endpoint lives outside the `/api/` prefix

Status: accepted
Date: 2026-09-03
Task: W1-CP-06 · Bootstrap administrator auth, the `/api/**` gate and workspace scoping
Supersedes: nothing. Amends nothing. Recorded in verification round 1.

## Context

`apps/web/middleware.ts` denies every `/api/**` request that carries no valid session, and
`apps/web/server/auth/paths.ts` gives no route a way to opt out — deliberately, because a gate with
an exception list is a gate somebody forgets to add to, and the cost of forgetting is an open
endpoint (ADR-0015).

Verification of this PR pointed out the consequence, which the PR had not written down: the
endpoint that *mints* a session cannot be reached through that gate. `POST /api/auth/signin` — where
§34's own naming conventions would put it — answers 401 before any handler runs, and so do
`/api/auth/login`, `/api/login` and `/api/session`. All four were probed against a running server;
all four are 401.

That is the gate working. It is also a fact the next task needs, because the obvious reaction to
discovering it is to edit `middleware.ts` and add an exception, and `middleware.ts` is this task's
owned file. Left undeclared, this is the cross-task coordination cost the PR's declared gap 3
documents honestly for the environment variables and did not document here.

## Decision

**The sign-in endpoint goes under `/p/`, not under `/api/`. No change to the gate.**

`/p/` is §34's unauthenticated surface — the prefix chosen so that "is this request
authenticated?" is answerable from the path alone. An endpoint whose entire purpose is to be
reachable without a session is, by that definition, a public endpoint, and `classifyPath('/p/…')`
already returns `public` and `enforcementFor('public')` already returns `allow`. Nothing has to be
built, and nothing has to be excepted.

`tests/auth.test.ts` proves it rather than asserting it. The live-server block writes a handler at
`apps/web/app/p/w1cp06-unauthenticated/route.ts` that imports nothing from `@/server/auth`, and
asserts an unauthenticated `GET` and `POST` both reach it and return its marker — in the same run
that asserts the four `/api/` sign-in paths are 401. Both fixtures are removed afterwards.

The second option, equally open and requiring no change here, is a Next.js server action or a form
`POST` handled by a page route: the page surface is also `allow`.

## Consequences

**W2-CP-06 does not need to edit `middleware.ts`.** It adds `apps/web/app/p/signin/route.ts` (or a
server action), calls the already-exported `signIn()` and sets the cookie `signIn()` returns. The
gate is untouched, and the file this task owns stays owned.

**A sign-in handler under `/p/` gets no CSRF protection from the middleware, and must do its own.**
The middleware returns early for an `allow` surface, so `checkRequestOrigin()` never runs on `/p/`.
Login CSRF — an attacker submitting *their* credentials to log a victim into the attacker's account
— is the real risk, and it is not hypothetical for a share surface a victim may already be on.
`checkRequestOrigin` is exported from `@/server/auth` for exactly this: the sign-in handler calls it
and refuses a request whose `Origin` is absent or foreign, the same way the middleware does for
`/api/`. **This is a requirement on W2-CP-06, not a thing already done.** Nothing in this branch
enforces it, because nothing in this branch has a sign-in handler to enforce it on.

**`/p/` now carries two unrelated things**: §20.6's share surface and, later, sign-in. They share a
prefix because they share a property — no session required — and not because they are related. If
that becomes confusing, the fix is a fourth surface in `paths.ts` with its own `Enforcement`, which
`enforcementFor`'s exhaustive `switch` and its throwing `default` already make a compile error to
add carelessly.

## Alternatives rejected

- **Except `/api/auth/**` in the middleware.** The exception list this design exists to not have.
  Its first entry is defensible and its fourth is how an endpoint gets left open; and the matcher
  and the classifier would then disagree about what `/api/` means.
- **A `PUBLIC_API_ROUTES` allowlist consulted by `classifyPath`.** Same defect, one indirection
  further away, and it would put a caller-facing decision behind a list that fails open when a
  future edit drops an entry from it — ADR-0015's exact shape.
- **Gate `/api/` but let unrouted `/api/` paths through so a sign-in route could be added later.**
  Would discard the strongest property this task has: that a route that does not exist yet is
  already protected.
- **Declare it as a gap and leave the placement to W2-CP-06.** What the PR effectively did by
  saying nothing. The information a later task needs is not "there is a problem here" but "here is
  where it goes and here is the one thing you must not forget", which is what this record is.
