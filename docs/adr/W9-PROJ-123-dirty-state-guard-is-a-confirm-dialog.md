# W9-PROJ-123 — The dirty-state guard is a `confirm()` dialog and a `beforeunload` listener

Status: accepted
Date: 2026-09-11
Decided by: W9-PROJ-123 (implementing agent)
Scope: `apps/web/components/projects/project-form.tsx`'s `confirmDiscard` and
`useBeforeUnloadGuard`; the Cancel button and the "Back to projects" link in
`apps/web/components/projects/projects-screen.tsx` and `apps/web/components/projects/project-detail.tsx`

## Context

Issue #123's Proposed Changes ask for "cancel/dirty-state protection", and the task card's Verifier
attack is explicit about what that has to survive: "Start editing a project, change the
instructions, and navigate away without saving. Assert the dirty-state guard fires."

No precedent exists in this repository. `grep -rn "beforeunload|confirm(|isDirty|dirty"
apps/web/components` (run before writing any code here) returns nothing: `../agents/agent-detail.tsx`,
the nearest sibling ("one form, submits the whole editable shape, PATCH on save"), has no Cancel
button and no protection against navigating away with unsaved changes at all. There is therefore no
"≥1 landed precedent" this task could cite under the development plan §3.2, and the choice of
*mechanism* is this task's own to make and record — more than one approach would work: a routing
middleware, a `Proxy`-wrapped state store, a context provider that every navigation link consults,
or the two browser-native primitives already built for exactly this problem.

## Decision

**The guard is two small, independent pieces, both in `project-form.tsx` so the create form and the
settings surface share one implementation:**

1. `confirmDiscard(dirty: boolean): boolean` — `window.confirm('Discard the changes you made?')`,
   gated on `dirty` so a clean form is never interrupted. Called from every affordance that can
   discard an edit inside this app: the create form's Cancel button, the settings surface's Cancel
   button, and the settings surface's "Back to projects" link (whose `onClick` calls
   `event.preventDefault()` when the answer is "no").
2. `useBeforeUnloadGuard(dirty: boolean): void` — a `beforeunload` listener, installed only while
   `dirty` is true, covering the paths an in-app `onClick` cannot reach at all: a tab close, a
   reload, or a typed-URL navigation.

Neither piece is a generalised "unsaved changes" framework. Each is the smallest thing that
satisfies the one behaviour asked for, on the one screen pair that has it.

## Alternatives considered

**A `beforeunload` listener alone, with no `confirm()` for in-app navigation.** Rejected: Next.js's
`<Link>` performs a client-side transition, which `beforeunload` never fires for — the Verifier
attack's own scenario (Back to projects) would silently lose the edit.

**A routing-level guard (a Next.js `router.events`-style hook, or wrapping every `<Link>` in the
app).** Rejected as exactly the abstraction the Simplicity Mandate rules out here: two screens need
this, not the whole application, and a router-wide interceptor is a second place — beyond
`confirmDiscard`'s call sites — where "does this navigation lose data" would need to be answered
correctly forever.

**A custom inline modal instead of `window.confirm`.** Rejected for this wave: a modal is more
control over styling, but it is also new state, new focus-trap handling, and a new accessible-dialog
pattern this task would be the first to build. `window.confirm` is synchronous, blocks navigation by
construction, and is keyboard- and screen-reader-accessible for free.

## Consequences

- `confirmDiscard` and `useBeforeUnloadGuard` read `window` directly and therefore only run in a
  browser; `apps/web/components/projects/project-form.test.tsx` exercises `confirmDiscard` by
  stubbing `window` with `vi.stubGlobal`, and never calls `useBeforeUnloadGuard` outside of
  `renderToStaticMarkup`, which does not execute effects — the one Node-only test environment this
  repository has (`apps/web/vitest.config.mjs`) has no `jsdom`, so a test that actually fired the
  listener is out of reach this wave.
- Every future screen that needs the same protection can reuse these two exports rather than
  re-deriving them; if a third screen needs it, that is the "≥1 landed precedent" this ADR exists to
  provide.
- `beforeunload`'s prompt text is not customisable in any browser still shipping — every one shows
  its own fixed wording regardless of the string `useBeforeUnloadGuard` assigns to
  `event.returnValue`. `preventDefault()` is what actually triggers the prompt in a current browser;
  the `returnValue` assignment is there only for a browser that still keys the legacy behaviour off
  it, which requires a non-empty string (or `true`), not an empty one.
