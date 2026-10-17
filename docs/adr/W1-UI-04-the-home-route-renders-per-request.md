# W1-UI-04 — `/` renders per request; it does not stop saying "no agent store is configured"

Status: accepted
Date: 2026-09-04
Decided by: W1-UI-04 (UI + Infra)
Scope: `apps/web/app/(shell)/page.tsx` (the `dynamic` export only — this task's `Owns:` line forbids touching the file's content otherwise)

## Context

A fresh operator-acceptance verifier found `apps/web/app/(shell)/page.tsx` prerendered at build
time and served from a long-lived cache thereafter (`x-nextjs-cache: HIT`, an identical `ETag`
across requests), regardless of what `composerAgents()` would answer if the route were actually
invoked again. `composerAgents()` reads `currentAgentsRuntime()`, a `globalThis` registry that
`instrumentation.ts`'s `register()` populates once at process boot — state that exists and can
change *after* the build that produced the cached HTML, so a route reading it must render on every
request, not once ahead of time.

Separately, and visible in this same file's own header comment (unchanged by this task — see the
scope note above): `composerAgents()` does not actually branch on that state today. It returns
`{ kind: 'no-agents', reason: NO_AGENT_STORE }` when the runtime is unconfigured, and
`{ kind: 'no-agents', reason: NO_WORKSPACE }` **unconditionally** otherwise — the file's own words
are "Nothing can resolve the workspace here," because a Server Component has no `Request` to hand
`AgentsRuntime.resolveWorkspace`, and the session cookie carries a workspace *slug*, not the id the
store needs. Supplying that link is named in the file itself as later integration work.

## Decision

Add `export const dynamic = 'force-dynamic';` to `page.tsx`, and nothing else in that file. This is
the Next 16.3.4 route-segment config that stops the route being statically generated at build time
— confirmed against this repository's pinned Next version rather than assumed, and identical in
shape to the same export `apps/web/app/api/agents/route.ts` already carries for the same reason
(reads request-time state; must not be answered from a build-time snapshot).

**What this fixes:** the route now executes on every request. Two requests no longer return the
same cached bytes with the same `ETag`; `x-nextjs-cache` is no longer `HIT`. If
`configureAgentsRuntime` were ever called with a runtime that changes its answer between requests,
this route would see the new answer on the very next request instead of never.

**What this does not fix, and is not this task's to fix:** `composerAgents()`'s own logic still
always returns `no-agents`, for the two structural reasons stated in its own header — no store
wired outside tests, and no server-component path from a session to a `workspaces.id`. Removing
the build-time cache makes the route re-evaluate that logic on every request; it does not change
what the logic decides. An operator who creates an agent through `/agents` (this task's other
half) and then hard-reloads `/` will still see "No agent store is configured" or "This workspace
could not be resolved" — not because the fix did not work, but because the sentence was never a
function of whether an agent exists. Proving otherwise would require inventing a workspace
resolution this file explicitly declines to invent, which is the same ADR-0015 failure the file's
own header is written against.

## Alternatives considered

- **Rewrite `composerAgents()` to actually resolve the workspace, since it is "just a cache
  problem otherwise."** Rejected: this task's `Owns:` line is explicit — "the force-dynamic fix
  ONLY - do not touch its content" — and the file's own header already explains, correctly, why the
  Server Component has no `Request` to resolve one with. Doing this properly is a `Request`-shaped
  seam this route does not have, which is the same class of problem `agents-list.tsx` sidesteps by
  fetching from the browser instead (see that file's header).
- **`revalidate = 0` instead of `dynamic = 'force-dynamic'`.** Considered and rejected: `revalidate`
  governs ISR staleness for a route that is still statically generated once; it does not stop the
  build-time prerender the verifier's report describes, which is the actual defect (a render that
  happened once, before the runtime existed, not a render that happened and then went stale).
- **Do nothing, and re-scope the whole caching complaint as unfixable without touching content.**
  Rejected: the caching defect and the "no workspace resolution yet" gap are two different, only
  loosely related problems living in the same file, and the first is fixable — and is this task's
  named job — without touching the second.

## Evidence

The before/after `curl -D -` header comparison and the `next build` output showing the route's
static/dynamic marker change are pasted in this task's pull request description, per ADR-0016 rule
3 (command output belongs in the PR, quoted, not summarised into this record).

## Consequences

- `/` is no longer served from a build-time snapshot. Every other route already renders per
  request (there was only ever this one static exception), so this removes an inconsistency rather
  than introducing a new rendering strategy.
- Phase 0's completion criterion — an agent created via `/agents` becoming visible on the home
  screen — remains unmet after this task's PR, and is declared as such here and in the PR
  description, rather than implied fixed by the caching change alone.
