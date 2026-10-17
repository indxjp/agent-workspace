# W1-UI-02 — The home screen does not carry the mockup's Projects section

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-02 (UI)
Scope: `apps/web/app/(shell)/page.tsx`, `apps/web/components/composer/home-chat.tsx`

## Context

`ui/home.html` ends with a **Projects** section: a heading, an **All projects** control, and three
project rows. The specification's own drawing of the home page does not have it. §45 prints the page
as the heading, the composer, and **Recent**, and closes with "That is enough." §19.5's block diagram
is the same three things. This task's card names three: "composer, three pickers, Recent list".

Projects are §20.5, and nothing in Wave 1 implements them: `packages/core/src/db/schema/` has
`agents`, `model-connections`, `memberships`, `runs`, `sessions`, `users` and `workspaces`, and no
`projects` table. The sidebar's Projects entry carries `href: null` for the same reason.

## Decision

Omit the section. The home screen is the heading, the sub-line, the composer and **Recent**.

Where the mockup and the specification differ, the specification wins — plan §0 rule 1 — and here
they differ on whether the section is part of the page at all. §45 is not silent; it prints the page
and closes it.

## Alternatives considered

- **Transcribe the section with the mockup's three projects.** Rejected twice over: they are content
  from a fictional workspace, and they would link to a screen that does not exist.
- **Transcribe the section and render it empty.** Rejected: a heading and an **All projects** control
  over nothing, on a page §45 says is finished without them — furniture on the one screen §43 is most
  concerned about.

## Consequences

- The screen is shorter than `ui/home.html` by one section. This is a deliberate divergence and the
  side-by-side comparison in the pull request names it rather than glossing it.
- When projects land (Wave 2 or later, §20.5), whoever builds them decides whether §45 should be
  amended to include the section. That is a specification change and it should be made as one.
