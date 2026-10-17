# W1-CP-06 — The middleware gates `/api/**`; the page surface passes through

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-06 (Control Plane)
Scope: `apps/web/middleware.ts`, `apps/web/server/auth/paths.ts`

## Context

Spec §34 fixes the rule this task implements: *"The public routes live under `/p/` rather than
`/api/` so that 'is this request authenticated?' is answerable by looking at the path prefix
alone."* The classifier therefore returns three surfaces — `api`, `public`, `page` — because those
are the three the prefix rule distinguishes.

The acceptance criterion covers one of them: *"Unauthenticated request to any `/api/**` route
returns 401."* Nothing in the task says what happens to `/settings` or `/agents/3` when the browser
carries no session, and the honest answers available were:

1. **Redirect an unauthenticated page request to `/login`.** The conventional answer, and it does
   not work in Wave 1: **no Wave 1 task owns a sign-in page.** W1-UI-01 owns
   `apps/web/app/(shell)/**`, W1-UI-02 owns the home chat, W1-UI-03 owns the run view; nobody owns
   `apps/web/app/login/**`, and W1-CP-06 owns `apps/web/server/auth/**` and `middleware.ts` and
   cannot create one. The redirect would point at a 404, and every page in the product would be
   unreachable — including the one the wave's own goal names: *"run one Claude Agent SDK agent
   through a browser on a self-hosted machine."* Three parallel UI branches would fail at
   integration on a decision none of them took.
2. **Let page requests through and authenticate in the server component.**

## Decision

**`enforcementFor('page')` returns `allow`.** The middleware denies `api` and allows `public` and
`page`. Page-level authentication is `requireSession()` / `requireWorkspaceScope()` from
`@/server/auth`, called by the server component that needs an identity.

The classifier still computes the third surface, and `tests/auth.test.ts` asserts it. Turning page
gating on later is one `return` in `enforcementFor` plus a redirect in the middleware — not a
redesign — and the day a `/login` route exists is the day to do it.

## Why this is not the fail-open shape ADR-0015 forbids

ADR-0015 forbids a gate that *passes because its check could not run*. This is the opposite: the
check ran, returned `page`, and `page` is mapped to `allow` by an explicit, exhaustive `switch`
whose `default` throws rather than allowing. A fourth surface added tomorrow fails loudly instead
of being let through. The decision is recorded in the enforcement table, in this record and in the
PR's Declared gaps — it is not an absence.

## Honest downside

**An unauthenticated browser can fetch a page shell.** Today that leaks nothing, because there is
no page that renders workspace data: `apps/web/app/page.tsx` is a placeholder. The risk arrives
with the first server component that queries the database without calling `requireSession()`
first, and nothing in this task mechanically prevents that — see the same gap in
[W1-CP-06 — the session carries the workspace slug](W1-CP-06-session-carries-the-workspace-slug.md).
It is declared, not mitigated.

The narrower cost: an unauthenticated user gets a page that then fails every `/api/**` fetch with
401 rather than a clean redirect to sign in. That is a worse experience than the redirect and a
better one than a 404 loop.

## Alternatives rejected

- **A `/login` prefix exemption plus a redirect, shipped now.** The exemption is a one-entry
  allowlist for a route this task cannot create, so it would be a rule written against a file that
  does not exist and could not be tested end to end. Rejected as a claim rather than a capability.
- **Putting sign-in under `/p/`.** It would fit the prefix rule — a sign-in POST really is a public
  route — but `/p/:token` is Wave 5's namespace, and reserving `/p/auth` inside it is a decision
  about someone else's route table taken without them.
- **Gating pages and letting the redirect 404.** Breaks the wave goal outright.
