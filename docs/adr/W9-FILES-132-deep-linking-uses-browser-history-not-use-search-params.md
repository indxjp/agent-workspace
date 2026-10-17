# ADR-W9-FILES-132 — The current folder is deep-linked via `window.history`, not `next/navigation`'s hooks

Status: accepted
Date: 2026-09-11
Decided by: W9-FILES-132 agent
Scope: `apps/web/components/resources/resource-screens.tsx`'s `useFileBrowser`

## Context

The task card's minimum implementation asks for "a canonical current-folder state, deep-linked
through a query parameter on the existing `apps/web/app/(shell)/files` route, driving `GET
/api/files?path=<folder>`", and explicitly notes: "No new page file, so no new mockup." The obvious
way to read `?path=` in a Next.js App Router client component is `useSearchParams()` from
`next/navigation`, paired with `useRouter()` to update it.

`apps/web/components/agents/agents-screens.test.ts`'s own header already documents why that is not
free here: `useRouter()`/`useSearchParams()` throw outside a mounted app router, which is exactly the
harness `resource-screens.test.ts` renders every screen in (`react-dom/server`'s
`renderToStaticMarkup`, with no router provider) — that file's own comment is why its
`NewAgentScreen` is never rendered in a test at all. Reaching for `useSearchParams()` here would make
`FilesScreen` (and the new `FilePicker`) untestable the same way, unless `page.tsx` were changed to
pass the App Router's own `searchParams` prop down instead — which is exactly the new page-file
surface area the card's own line rules out.

## Decision

`useFileBrowser` reads the initial folder from `window.location.search` (guarded for
`typeof window === 'undefined'`, so a server/static render — including every existing test —
sees the root) and writes it back with `window.history.pushState` on every navigation, listening for
`popstate` to keep state in sync with the browser's own Back/Forward buttons. This is the browser's
native equivalent of what `next/navigation` would otherwise provide, and it satisfies the card's
"deep-linked through a query parameter" requirement — the URL still round-trips through `?path=` and
survives a reload or a copied link — without requiring a mounted app router, and therefore without
requiring `apps/web/app/(shell)/files/page.tsx` to change at all.

## Alternatives considered

- **`useSearchParams()` + `useRouter()`.** Rejected for the reason above: it throws outside a mounted
  router, which every test in this file's harness is, and fixing that would mean either wrapping the
  hook in a `<Suspense>` boundary in a new/changed `page.tsx` (ruled out by the card) or leaving this
  screen's most important new behaviour untested by the very suite this task's acceptance commands
  name (`pnpm vitest run apps/web/components/resources`).
- **Do not deep-link at all; keep the folder only in component state.** Rejected: the card's minimum
  implementation names deep-linking explicitly, and the verifier attack itself operates by
  hand-editing the URL, which presupposes the URL carries the folder.

## Consequences

Nothing here reaches beyond a plain `URLSearchParams`/`history` API, so it costs nothing in test
setup and nothing in new dependencies. The trade is that this screen manages its own small slice of
URL state by hand rather than through the framework's router primitives, which is a pattern local to
this screen rather than one this task establishes as a repository-wide convention.
