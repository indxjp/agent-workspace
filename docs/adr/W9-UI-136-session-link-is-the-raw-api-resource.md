# ADR-W9-UI-136 — The run detail panel's session link points at the API resource, because no session-viewing screen exists yet

Status: accepted
Date: 2026-09-12
Decided by: W9-UI-136 (implementing agent)
Scope: `apps/web/components/run/run-detail-panel.tsx`

## Context

Issue #136's card asks for "deep links out to the run's session, agent and project." Agent and
project have real destinations — `apps/web/app/(shell)/agents/[id]/page.tsx` and
`apps/web/app/(shell)/projects/[id]/page.tsx` both exist and are declared screens. A session does
not: this repository has no `(shell)` route that reads `GET /api/sessions/:claudeSessionId` or
`GET /api/sessions/:claudeSessionId/transcript` and renders them. The only place a session's
content is ever shown to a person is `RunView`
(`apps/web/components/run/run-view.tsx`, `ui/agent-run.html`), and it is reached exclusively
through `components/composer/home-chat.tsx`'s in-memory state machine — there is no URL parameter,
on `/` or anywhere else, that hydrates it from a past, already-ended session id. Confirmed by
reading `home-chat.tsx` end to end: every `sessionId` it touches comes from a `POST` response in
the same browser tab's lifetime, never from a query string.

The task card's own "Deliberately not built" list forbids building that viewer here — "No
transcript or event-stream viewer inside the history panel; it links to the existing run view,
which already has one" — so the honest options are narrow: link to a page that cannot actually
resume this specific session (dishonest — the composer would open empty), or link to something
that is real.

## Decision

**The session line links to `GET /api/sessions/:claudeSessionId` itself** — an authenticated,
workspace-scoped, real resource this build already serves, rather than to a product page that
cannot show the intended session. The link is labelled "session data" with an inline note that no
session viewer is built yet, so nobody mistakes a JSON response for a missing feature.

## Alternatives considered

- **Link to `/`, hoping a person "continues" the session from there.** Rejected: `/` starts a fresh
  composer; it does not resume an arbitrary past session, so the link would silently fail to do
  what it says.
- **Render the session id as plain text, no link at all.** Considered seriously — it is the
  honest minimum. Rejected in favour of the API link because the API link is _also_ honest (it
  really does return this exact session's data, workspace-scoped and authorised) and is strictly
  more useful to an operator who wants to see the underlying transcript today, at the cost of one
  sentence explaining what it is.
- **Build a minimal session-transcript page in this task.** Rejected: it is a new screen with no
  `ui/*.html` mockup, exactly the class of addition `docs/adr/W9-PLAN-run-detail-is-a-panel-not-a-new-screen.md`
  says this task does not make, and it is explicitly out of the card's "Deliberately not built".

## Consequences

- Opening the link shows raw JSON, not a formatted transcript. A future task that builds a real
  session-transcript screen replaces this `href` with that screen's route and changes nothing else
  about this panel.
- The link's authorisation is exactly `GET /api/sessions/:claudeSessionId`'s own — this task adds no
  new authorisation surface and asserts nothing about who may read what.
