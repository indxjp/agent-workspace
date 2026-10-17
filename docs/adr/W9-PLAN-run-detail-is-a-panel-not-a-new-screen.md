# W9-PLAN — Issue #136's run detail is a deep-linkable panel, not a new screen

Status: accepted
Date: 2026-09-11
Decided by: W9-PLAN-00 (the Wave 9 planner)
Scope: `apps/web/app/(shell)/runs/**` and `apps/web/components/run/**` in W9-UI-136; the same rule
applied to W9-PROJ-123, W9-PROV-128, W9-FILES-132 and W9-TEAM-122

## Context

Issue #136 asks for *"a run detail surface that combines durable summary with event stream/transcript
where authorized"*, and its acceptance criteria include *"A detail page explains errors and links to
authorized agent/project/session context"* and *"Filters and pagination preserve URL state"*.

The obvious reading is a new route, `apps/web/app/(shell)/runs/[id]/page.tsx`. This repository makes
that more expensive than it looks. `tests/screen-inventory.test.ts` enforces §9.1's
*"screens = `ui/*.html`"* gate as a two-way correspondence:

- every shipped page file must be named by a declaration under `tests/screen-declarations/`, whose
  message on failure is *"these page files ship but no `ui/*.html` declares them"*;
- every `ui/*.html` mockup must be declared by exactly one owner, and *"`ui/files.html` is declared
  twice"* is a hard failure.

So a new page needs a new mockup. `ui/run.html` — the natural candidate — is already declared by
W2-INT-00 for the live run view, and `ui/runs.html` by W6-CP-06 for the Runs list. A new page therefore
means authoring a new `ui/*.html` mockup plus a screen declaration, in a task whose actual subject is
data honesty about tokens, cost and accounting state.

The criteria do not require a route segment. A `?run=<id>` query parameter on the existing Runs route
is a URL a user can copy, bookmark and share, which is what "deep link" and "preserve URL state" ask
for, and #136 already requires the filters and pagination to live in the URL on that same route.

## Decision

**Run detail in W9-UI-136 is a panel on `apps/web/app/(shell)/runs`, selected by `?run=<id>`. The task
ships no new page file, no new `ui/*.html` mockup, and no screen declaration.**

The transcript and event stream are **linked to**, not embedded: the existing run view already renders
them and is already declared against `ui/run.html`. The panel carries the durable summary — status,
provider, model, token counts, cost with accounting state, duration, timestamps, agent, project, user,
workspace, and the error — and links out for the stream.

**The same rule is applied across Wave 9 wherever an issue's criteria can be met on an existing
route**, and each affected card says so in its `Deliberately not built` field:

| Task | Surface | Existing route and mockup |
| --- | --- | --- |
| W9-PROJ-123 | project create and edit | `(shell)/projects`, `(shell)/projects/[id]` — `ui/projects.html`, `ui/project.html` |
| W9-PROV-128 | provider detail, edit, rotate | `(shell)/admin/models` — `ui/models.html` |
| W9-FILES-132 | nested file browser, current folder in the URL | `(shell)/files` — `ui/files.html` |
| W9-TEAM-122 | members and pending invitations | `(shell)/admin/users` — `ui/users.html` |
| W9-MODEL-130 | workspace default model | `(shell)/admin/settings` — `ui/settings.html` |

**W9-UI-120 is the one exception.** A workspace switcher needs somewhere to list, create and configure
workspaces, and no existing route is that place. It ships exactly **one** new route,
`apps/web/app/(shell)/workspaces`, carrying the directory, the create form and the settings form
together, with exactly one new mockup `ui/workspaces.html` and one declaration
`tests/screen-declarations/W9-UI-120.ts` — three surfaces on one route so that one mockup suffices.

## Consequences

- Five UX tasks write no mockup and no screen declaration, so `tests/screen-inventory.test.ts` stays
  green on their branches without any of them touching a file the gate derives its partition from.
- The Runs route carries list and detail. At narrow widths the panel becomes a full-width view of the
  same route, which is the ordinary responsive treatment and is covered by the accessibility spec.
- A run detail URL is `?run=<id>` rather than `/runs/<id>`. If a later wave wants the path form, it
  adds the mockup and the declaration then; the panel's state already lives in the URL, so the
  migration is a route addition rather than a rewrite.
- This is a narrowing of #136's *wording*, not of its criteria. A verifier is told, on the card, that
  the absence of `apps/web/app/(shell)/runs/[id]/page.tsx` is deliberate.

## Alternatives rejected

**Author `ui/run-history.html` and ship the page.** Correct and more expensive: a mockup is a design
artefact and W9-UI-136's subject is not design. It also adds a second mockup describing a run, next to
`ui/run.html`, which invites the two to drift.

**Re-declare `ui/run.html` for the new page.** `tests/screen-inventory.test.ts` fails a mockup declared
twice, by design, and naming both pages in W2-INT-00's declaration file would have W9-UI-136 write
outside its own globs.

**Render detail in a modal with no URL state.** Fails #136's deep-link criterion outright.

## Related

- `tests/screen-inventory.test.ts` and `tests/screen-declarations/` — the gate this decision is shaped
  by; [ADR-0025](0025-the-route-inventory-is-partitioned-by-owner.md) is the partition rule it follows.
- The development plan §9.1 — *"spec-inventory tests … screens = `ui/*.html`"*.
