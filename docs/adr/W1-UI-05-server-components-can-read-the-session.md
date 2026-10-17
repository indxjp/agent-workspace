# W1-UI-05 — a Server Component can read the session; the earlier "no `Request`" claim was false

Status: accepted
Date: 2026-09-04
Decided by: W1-UI-05 (UI)
Scope: `apps/web/app/(shell)/page.tsx`

## Context

`apps/web/app/(shell)/page.tsx`'s own header, and `docs/adr/W1-UI-04-the-home-route-renders-per-request.md`
after it, stated as settled fact that `composerAgents()` could not resolve the session's workspace
because "a Server Component has no `Request` to hand `AgentsRuntime.resolveWorkspace`". The W1-UI-04
ADR goes further and calls this reasoning correct: *"the file's own header already explains,
correctly, why the Server Component has no `Request` to resolve one with."* Neither task built
around this by omission — the earlier one was scoped away from touching it, but the claim itself was
never checked against the code already in the repository.

This task's brief asked for exactly that check before building anything else, naming two files as
the place to look: `apps/web/server/auth/index.ts` and `apps/web/app/signin/actions.ts` both import
`{ cookies }` (and, for the second, `headers`) from `next/headers`.

## What was actually true, checked

`next/headers`'s `cookies()` is available to any Server Component, not only to a Route Handler or a
Server Action — it returns a **read-only** view of the incoming request's cookies (mutation —
`.set()`, `.delete()` — is the part restricted to a Route Handler or a Server Action; reading is not).
This is documented Next.js App Router behaviour, and it was already being exercised in this exact
route tree before this task touched anything:

`apps/web/app/(shell)/layout.tsx` — the Server Component that wraps `page.tsx` on every request
to `/` — is `export default async function ShellLayout(...)` and its first line is
`const session = await getSession();`, where `getSession` (`apps/web/server/auth/index.ts`) is:

```ts
export async function getSession(): Promise<VerifiedSessionClaims | null> {
  const secret = readSessionSecret(process.env);
  if (!secret.ok) { ... return null; }
  const store = await cookies();
  const result = await verifySessionToken(store.get(SESSION_COOKIE_NAME)?.value, secret.secret);
  return result.ok ? result.claims : null;
}
```

`ShellLayout` uses the result to build the sidebar's identity chip and workspace name — a real,
already-shipped feature that depends on a Server Component reading the session. It has been doing
so on every request to every page in `(shell)`, `page.tsx` included, since the layout was built. The
"no `Request`" claim was falsified by a file two directories over that this task's own route tree
already imports and renders on every load.

What *is* true, and what the earlier reasoning got right by accident: `AgentsRuntime.resolveWorkspace`
takes a `Request`, specifically, not a cookie jar — and a Server Component genuinely is not handed
one by Next's rendering path. That half of the claim survives. It just does not follow that the
workspace cannot be resolved; it follows only that `resolveWorkspace` cannot be called with the
`Request` Next would have handed a Route Handler, because there isn't one.

## Decision

`composerAgents()` (`page.tsx`) builds a `Request` carrying exactly the session cookie `cookies()`
already exposes, and passes it to `runtime.resolveWorkspace()` unchanged:

```ts
async function requestCarryingThisSessionCookie(): Promise<Request> {
  const store = await cookies();
  return new Request('http://localhost/', { headers: { cookie: store.toString() } });
}
```

`instrumentation.ts`'s implementation of `resolveWorkspace` reads only `request.headers.get('cookie')`
— confirmed by reading it, not assumed — so this synthetic `Request` is indistinguishable, to that
function, from the one a real `POST /api/agents/:id/runs` would have carried. The URL is a fixed
placeholder because nothing downstream reads it.

This means `composerAgents()` runs the *same* session-verification-and-membership-lookup code path
every `/api/**` route already runs (HMAC verify → `workspaces.slug` lookup → `users.email` lookup →
membership join), rather than a second, page-local reimplementation of it that could drift from the
API's own answer about the same session.

## Alternatives considered

- **Reimplement the verification in `page.tsx` directly, calling `getSession()` and doing the
  workspace/membership lookup by hand.** Rejected: this task does not own `apps/web/server/**`, and
  the lookup needs a `Database` handle that only `instrumentation.ts`'s composition root holds —
  `resolveIdentity` there is not reachable from a file this task may edit. Building the `Request` and
  calling the existing `resolveWorkspace` reuses the one implementation instead of adding a second.
- **Leave `composerAgents()` unauthenticated-only (`unauthenticated`/`no-agents` forever) and declare
  the workspace resolution itself out of scope again.** Rejected: this is the actual Phase 0 blocker
  named in this task's brief, and the claim blocking it does not hold up.

## Evidence

Verified by reading `apps/web/app/(shell)/layout.tsx` (already calling `getSession()` from an async
Server Component) and `apps/web/server/auth/index.ts` (`getSession`'s use of `cookies()`), both
before this task edited either file. The resulting browser walk — sign in, create an agent, see it
offered on `/`, Send, watch a real run's events stream — is pasted in this task's pull request
description per ADR-0016.

## Consequences

- `docs/adr/W1-UI-04-the-home-route-renders-per-request.md`'s "Alternatives considered" section
  calls the "Server Component has no `Request`" reasoning correct. That characterisation is wrong;
  this record supersedes it on that one point. W1-UI-04's own decision (the `force-dynamic` export)
  is unaffected and stands.
- `composerAgents()` now has four real branches — no store, no session, no membership, an empty
  workspace — where it previously had two, both unreachable-in-practice paraphrases of "workspace
  resolution is impossible". See `page.tsx`'s own header for the full account.
- `apps/web/components/agents/agents-list.tsx`'s header repeats the same "Server Component has no
  `Request`" claim as its reason for fetching `/api/agents` from the browser instead of reading the
  store server-side. That file is outside this task's `Owns:` line (it belongs to a different task's
  ownership), so it is not changed here — its own claim is now known to rest on the same false
  premise, and is left as a gap for whichever task next touches that file to correct or to justify
  on other grounds (its browser-fetch approach may still be the right call for reasons unrelated to
  this one, e.g. matching what an operator's own tooling would see).
