# W1-UI-03 — §19.5.1 rule 5's seam is in the home chat, so this task declares that file

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-03 (UI)
Scope: `apps/web/components/composer/home-chat.tsx`, and this task's `Owns globs:` line

## Context

The development plan §6.3 grants W1-UI-03 one glob, `apps/web/components/run/**`, and gives it
this acceptance criterion:

> One run component; a test asserts the home route renders it after send

Those two statements cannot both be satisfied inside that glob, and the reason is structural rather
than a matter of taste. The home route is `apps/web/app/(shell)/page.tsx`, which renders
`components/composer/home-chat.tsx` and nothing else. For the home route to render the run view,
*something outside `components/run/**` has to reach into it.* There are exactly two candidate seams
and both are files this task's card does not name:

| Seam | Owner per the plan | What it would have to do |
| --- | --- | --- |
| `app/(shell)/page.tsx` | W1-UI-02 | render a different component |
| `components/composer/home-chat.tsx` | W1-UI-02 | return the run view once a run exists |

Choosing neither means shipping a run component nothing renders and an acceptance criterion that
cannot be executed — and §19.5.1 rule 5 is not a wiring detail, it is the rule: *"Once the first
message is sent, the screen becomes the run view of section 19 … There is no second chat
implementation."* A run view that the home chat does not become is the second implementation the
rule forbids, arrived at by obeying a file list.

[ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) already ruled on this exact
shape, twice in Wave 1a — `apps/web/middleware.ts` for W1-CP-06, `pnpm-workspace.yaml` for W1-DB-01
— and states the general case plainly: the §6 cards "name the *substance* of a task, not an
exhaustive file manifest", the effective boundary is the PR's `Owns globs:` line, and "an acceptance
criterion that names a file the task may not write is incoherent."

## Decision

**This task declares `apps/web/components/composer/home-chat.tsx` in its PR's Ownership section,
with the reason above, and changes nothing else in it.** `app/(shell)/page.tsx` is *not* declared and
is not touched.

The change is the smallest one that makes rule 5 true, and it is four things:

1. Two optional props — `run` (the conversation this screen opens on, `null` for the home page) and
   `user` (who is typing).
2. One piece of state, seeded from `run`.
3. An early return: `screenFor(started)` decides, and a `run` screen returns `<RunView>`.
4. An `onClick` on the **Send** button that already existed and did nothing.

The *decision* — which screen is shown — lives in `components/run/model.ts`, inside this task's own
glob, as a function a test calls. The home chat holds the state and calls it. That split is why the
edit outside the glob is four lines of wiring rather than a rule reimplemented in someone else's
file.

Two conditions ADR-0018 attaches are satisfied and checkable:

- **Disjoint from siblings at the same stack level.** W1-UI-02 is not a sibling; it is this branch's
  *base* (`aw/w1-09-home-chat`, at `d0d9803`). W1-UI-03 is the only task at its level in the UI
  substack of plan §6.3, so there is no concurrent writer to intersect with.
- **Declared with its reason.** The PR body carries it in the Ownership section, which is what the
  CI gate reads.

`apps/web/vitest.config.mjs` is declared for a separate reason, recorded in
[W1-UI-03-the-web-project-can-load-its-own-components-in-a-test](W1-UI-03-the-web-project-can-load-its-own-components-in-a-test.md).

## Alternatives considered

- **Build the run view and leave it unrendered, declaring the wiring as a gap.** Rejected. It ships
  the failure mode ADR-0015 is written against, in the form the specification cares most about: a
  capability that appears complete because nothing contradicted it. The acceptance criterion would
  be reported as unmet, and the next task to touch this area would find a run component with no
  caller and a plausible reason to write its own.
- **Write a second, run-only chat under `components/run/**` so nothing outside the glob changes.**
  Rejected outright — that is the second chat implementation §19.5.1 rule 5 names, and the task
  brief says to stop and say so rather than do it. The glob would be respected and the specification
  broken, which is the wrong trade in a programme whose §2.3 concurrency exists to serve the spec.
- **Declare `app/(shell)/page.tsx` as well and pass the run down from the route.** Rejected: it is a
  second out-of-glob file for no gain. The run begins in the browser when Send is pressed, so a
  server component has nothing to give it, and the seam would still have to exist in the chat.
- **Raise a plan amendment and wait.** Rejected by ADR-0018's own reasoning: it serialises the wave
  behind a plan edit, and the declaration plus the CI gate already give a reviewer everything the
  amendment would.

## Consequences

- The plan's card and this PR's `Owns:` line diverge by one file. ADR-0018 says they will, "permanently
  and by design"; the wave manifest records the divergence per task.
- A reviewer must read four lines of `home-chat.tsx` that this task wrote and W1-UI-02 did not. They
  are marked in place, and the header of that file now names rule 5 and points at
  `components/run/run-view.test.ts`.
- If a later wave splits the home route from the chat implementation, this seam moves with the
  chat, not with the route. The test that enforces rule 5 reads both files and will say so.
- **The mirror-image risk is real and unmitigated.** This record makes it acceptable for a task to
  write outside its card when the card is incomplete; it does not make it acceptable to write
  outside it silently. The whole control is the declaration, and an undeclared change remains a
  violation whatever this record says.
