# W1-UI-03 — The first message starts the run *view*; it does not claim a run started

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-03 (UI)
Scope: `apps/web/components/run/model.ts`, `apps/web/components/composer/home-chat.tsx`

## Context

§19.5.1 rule 5 says the screen becomes the run view once the first message is sent. On this branch
that transition happens entirely in the browser: nothing is posted anywhere. The reasons are
recorded elsewhere and are not this task's to fix — `app/(shell)/page.tsx` cannot resolve a
workspace (the session cookie carries a slug, not `workspaces.id`; see
[W1-CP-06-session-carries-the-workspace-slug](W1-CP-06-session-carries-the-workspace-slug.md)), no
agent store is installed outside tests
([W1-CP-04-run-api-is-installed-not-imported](W1-CP-04-run-api-is-installed-not-imported.md)), and
`server/runs/environment.ts` refuses to serve a run until a runtime adapter is registered.

So the screen has to render a run view about a run that has not started. `ui/agent-run.html` shows
that region fully populated — a green **Running** badge with a live dot, a session id, a container
name, a turn count, a cost, three rail cards. Every one of those is a claim, and this screen has
checked none of them.

## Decision

**Every region of the run view whose value has not been observed is absent, and the type permits
absence.** Concretely, what the home chat builds when **Send** is pressed:

| Region | Value | Why |
| --- | --- | --- |
| `heading.title` | the selected agent's name | the screen chose it |
| `heading.subtitle` | `''` → no line | no session id exists to print |
| `heading.status` | `null` → no badge | no event has been received |
| `heading.actions` | `[]` | nothing can be interrupted |
| `rail` | `[]` → no `<aside>` | no container, cost or turn count was read |
| `technical` | empty → "No SDK events have been received for this run." | true, and it says so |
| `followUp.status` | the agent's sandbox line | already shown on the composer, already true |

The transcript holds the user's message, attributed to a `Speaker` the caller supplied. When the
caller supplies none, **Send** is refused rather than the message being attributed to "You" — a
name nobody checked is still a claim about authorship.

Two smaller decisions follow the same rule and are worth naming because each was wrong in a first
draft:

- **`RunBadge` carries `dot` as data, not derived from `tone`.** The mockup puts a live dot on
  `Running` and none on `Completed · 23 s · $0.08`, and both are `.badge.ok`. The dot means *live*,
  not *green*. Inferring it from the colour would make the screen report a run still in flight
  because of a coincidence of palette.
- **The activity marker is chosen on `state`, not on whether a duration is present.** A running step
  legitimately has no duration — the mockup prints `—` — and a truthiness test on that cell draws it
  as finished.

## Alternatives considered

- **Show a `Running` badge on send.** Rejected: it is the exact failure ADR-0015 names. The run is
  not running; nothing started it. A user watching a green badge over a screen where nothing will
  ever happen is worse served than one watching no badge at all.
- **Invent a `Starting…` or `Queued` badge.** Rejected on two grounds. It is a string the mockup does
  not contain, and this is a PL-0 transcription where inventing copy is a defect. And it would be
  false in the same way: nothing was queued.
- **Populate the rail from the composer's own selections** (agent, files, connectors). Rejected as a
  category error: the rail describes *what the run is doing* — a container, a cost, files that were
  hydrated — not what was requested. Filling it from the request would make the screen report a
  sandbox that was never created.
- **Refuse to transition at all until a run API answers.** Rejected: it makes rule 5 untrue and the
  acceptance criterion unreachable, to avoid a problem the type system solves.

## Consequences

- The run view reached from the home chat today is sparse: a heading, one message, a collapsed
  disclosure with three empty panels, and a follow-up box. That is exactly what is known. The
  screenshots in this task's pull request show it, so nobody mistakes it for the finished screen.
- Every field the streaming task has to fill is already typed and already has a rendered empty state,
  so wiring W1-CP-04's relay to this screen adds values, not regions.
- **A user could send a message and see nothing further happen.** That is a real and visible
  shortcoming of Wave 1 rather than a defect this task can close, and it is declared as a gap on the
  pull request. The alternative — a screen that looks busy — would hide it.
