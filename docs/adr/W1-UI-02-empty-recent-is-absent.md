# W1-UI-02 — An empty Recent list renders no section, not an empty container

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-02 (UI)
Scope: `apps/web/components/composer/home-chat.tsx`

## Context

`ui/home.html` shows **Recent** with four runs. It shows no empty state, because a demonstration
never has one. A new installation always does: nothing has run yet, and in Wave 1 nothing can (see
[W1-UI-02-mockup-content-is-a-fixture-not-data.md](W1-UI-02-mockup-content-is-a-fixture-not-data.md)).

So the screen needs an answer the mockup does not give, and every answer except one requires writing
copy the specification does not contain.

## Decision

When `recent` is empty, the heading, the **See all** control and the `.rows` container are not
rendered at all. The composer is the last thing on the page.

This is the only option that invents no string. `.empty` in `ui/assets/app.css` would have needed a
heading and a line of body copy, both written here; §43's "calm, sparse, obvious" and PL-0's "if it
is not in the spec, it is not in the PR" both point the same way. §45 supports it directly — the home
page is a place to type, and "That is enough."

## Alternatives considered

- **A framed empty state (`.empty`) inside the `.rows` box.** Rejected: two invented strings and a
  204-pixel box that says nothing. It is furniture, and Risk #10 in plan §10 is about exactly this
  accumulation.
- **An always-present heading over an empty box.** Rejected for the same reason, minus the copy.
- **A skeleton or placeholder rows.** Rejected outright: rows that look like runs and are not.

## Consequences

- A workspace with no runs sees a shorter page than the mockup. That is correct, and it is what the
  screenshot in this task's pull request shows.
- The first run makes the section appear. No task has to remember to remove an empty state.
- If a later wave decides an empty Recent should say something, the copy has to be added to the
  specification first, which is the right order.
