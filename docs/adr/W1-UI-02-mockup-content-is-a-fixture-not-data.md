# W1-UI-02 — The mockup's agents and runs are a test fixture; the screen renders what the control plane read

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-02 (UI)
Scope: `apps/web/app/(shell)/page.tsx`, `apps/web/components/composer/**`

## Context

`ui/home.html` demonstrates the home chat with a fictional workspace: five agents (General, Customer
Support Agent, Contract Review, Invoice Triage, Security Review Bot), four file sets, four
connectors, four recent runs with costs, and three projects. The task is PL-0 — transcribe the
mockup — and its acceptance criterion is that the composer, the three pickers and the Recent list
match it.

Two things in Wave 1 make "just transcribe it" the wrong reading.

**Rule 2 is about exactly this.** §19.5.1 rule 2 says the pickers can only offer what the selected
agent is already permitted to use, "so the chat screen can never grant capability the agent does not
have". A picker listing four connectors that no installation has configured is that failure in its
purest form — the screen would be describing a workspace nobody owns. W1-UI-01 reached the same
conclusion for the shell chrome and declined to ship the mockup's "Meridian Manufacturing" as the
workspace name (`W1-UI-01-the-shell-shows-what-it-knows.md`).

**Nothing in this wave can answer the question honestly either.** The agent routes reach their store
through a module-global that only tests install (`server/agents/runtime.ts`;
`GET /api/agents` answers `503 agents_runtime_not_configured` in production for the same reason).
`AgentStoreProvider.forWorkspace` wants a `workspaces.id`, `AgentsRuntime.resolveWorkspace` derives
one from a `Request` that a server component does not have, and the session cookie carries `ws`,
documented in `server/auth/session.ts` as the workspace **slug**, "not `workspaces.id`". And
`RunStore` has no method that lists a workspace's runs, while a `runs` row carries neither a title
nor a cost — two of the four things a Recent row shows.

## Decision

The **shapes** are transcribed; the **content** is a prop.

`HomeChat` takes `agents: ComposerAgents` and `recent: readonly RecentSession[]`.
`app/(shell)/page.tsx` builds both from the control plane and from nothing else. In this wave both
links above are missing, so it returns `{ kind: 'no-agents', reason }` naming the check that did not
pass, and an empty Recent list. The composer renders with its three pickers visibly disabled, **Send**
disabled, and the reason in the status slot where the mockup prints "Standard Sandbox · read-only".

In particular the screen does **not** fall back to the built-in **General** agent of §19.5 rule 3,
even though the specification promises every workspace has one and `packages/core`'s seed creates it.
Nothing on this path read that row. Offering it would be a capability asserted because nothing
contradicted it, which is ADR-0015's failure, and the pickers would then be describing a permission
set nobody checked.

The mockup's content is transcribed once, into `components/composer/mockup-fixture.ts`, and used to
render the screen for the side-by-side comparison the acceptance criterion asks for. `model.test.ts`
asserts that no file under `apps/web/app/` imports it, deriving the file list from the tree rather
than naming files.

Two smaller readings follow and are recorded here rather than in records of their own:

- **The agent picker's summary reads "Agent: none" when there is no agent.** The mockup always has
  one, so it prints no label for this state. "none" fills the same value slot; it adds no furniture.
- **The fixture attaches the mockup's eight file and connector rows to General only.** A static page
  has one selected agent, so `ui/home.html` prints the panels of the agent its markup marks selected
  and says nothing about the other four. Their `.d` lines gesture at sets ("Handbook + Jira", "2
  connectors") the mockup never enumerates, and enumerating them would be invention. The four
  unselected agents' `sandbox` strings are read off their own `.d` lines.

## Alternatives considered

- **Ship the mockup's rows as the screen's content.** Rejected: it is the §19.5.1 rule 2 violation
  the rule exists to prevent, and the first click on **Send** would prove it.
- **Show General because the specification says it exists.** Rejected above. The seed does create the
  row; this page did not read it, and "the document says so" is not a read.
- **Wire the store from this file — resolve the workspace from the session slug.** Rejected: it
  invents a slug-to-id mapping no module in this repository states, on the one parameter spec §25
  makes a tenant boundary. That seam is integration work.
- **Render nothing until a store exists.** Rejected: §45 says the first thing on the screen is a
  place to type. The composer is the screen; the disabled pickers are the honest part.

## Consequences

- **On this branch the home screen cannot start a run.** It shows the composer, three disabled
  pickers and one sentence saying why. That is the honest state of Wave 1's control plane and it is
  declared as a gap in the pull request, not hidden behind demo rows.
- The acceptance comparison is evidenced by rendering `HomeChat` against `mockup-fixture.ts` — a
  temporary two-line `page.tsx` during the comparison, reverted before the commit. A reviewer can
  reproduce it the same way.
- When the integration branch installs a store and a request-free workspace resolution, only
  `composerAgents()` in `page.tsx` changes. The component and the model do not.
