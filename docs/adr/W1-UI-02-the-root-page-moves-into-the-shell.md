# W1-UI-02 — `apps/web/app/page.tsx` is deleted; `/` lives inside the shell group

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-02 (UI)
Scope: `apps/web/app/page.tsx` (removed), `apps/web/app/(shell)/page.tsx`

## Context

`apps/web/app/page.tsx` is the Next.js starter placeholder — "The control plane UI is built in a
later wave." W1-UI-01 built the shell as a route group, `app/(shell)/layout.tsx`, and its header
states plainly that "the home chat screen at `/` is W1-UI-02's file (`(shell)/page.tsx`, spec §19.5,
§45) and this task must not write it".

A route group adds no path segment. `app/page.tsx` and `app/(shell)/page.tsx` therefore both resolve
to `/`, and only one of them can be served.

**Next.js 16.3.4 does not report the collision.** It was expected to fail the build with "you cannot
have two parallel pages that resolve to the same path"; it does not. `next build` succeeds, prints a
single `○ /` in the route table, and serves `app/page.tsx` — the placeholder — while
`app/(shell)/page.tsx` is compiled and never reached. Measured on this branch before the deletion:
`curl localhost:3111/` returned the placeholder markup, with no sidebar and no composer, from a build
that had compiled both files without a warning.

That is a gate failing open in the sense ADR-0015 names: nothing objected, so the wrong page shipped
and the acceptance criterion would have been checked against a screen the user never sees.

## Decision

Delete `apps/web/app/page.tsx`. `/` is `app/(shell)/page.tsx` and inherits the sidebar and top bar.

The file is outside the globs the development plan §6 grants this task, so it is declared in
the pull request's Ownership section with this reason, under
[ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md)'s condition 3. It is disjoint
from every sibling at this stack level: no other Wave 1 task's globs name it, and W1-UI-01 — whose
`apps/web/app/(shell)/**` is the nearest neighbour — is this branch's base rather than a sibling.

## Alternatives considered

- **Keep both and put the screen in `app/page.tsx`.** Rejected: that file is outside the shell group,
  so the home screen would render with no sidebar and no top bar, and spec A.3 requires the runtime
  chip on every screen.
- **Leave the placeholder and let a later task remove it.** Rejected: the placeholder *wins*. Leaving
  it means this task's entire deliverable is unreachable, and the wave would discover that at
  integration rather than here.
- **Escalate rather than touch a file outside the card.** Rejected on ADR-0018's own reasoning: the
  §6 cards were written before any code existed and name the substance of a task, not a file
  manifest. The declaration plus the CI ownership gate give a reviewer everything an escalation
  would, without serialising the wave behind a plan edit.

## Consequences

- Anyone adding a second `/` page in this application gets no error from the framework. There is no
  gate for this in the repository, and this record is the only place it is written down. A test that
  asserts "exactly one file resolves to each route" would be the real fix; `tests/route-inventory.ts`
  is the natural home for it and it belongs to no task in this wave.
- The removal is a deletion in the diff, which is the shape a reviewer should expect to see once and
  never again.
