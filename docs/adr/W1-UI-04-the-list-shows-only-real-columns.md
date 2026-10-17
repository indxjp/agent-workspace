# W1-UI-04 — The agent list keeps only the columns a real agent record can answer

Status: accepted
Date: 2026-09-04
Decided by: W1-UI-04 (UI + Infra)
Scope: `apps/web/components/agents/agents-list.tsx`

## Context

`ui/agents.html` draws an eight-column table: Agent, Status, Model, Runtime, Runs (7d), Cost (7d),
Last run, and a Run action. `AgentResource` (`server/agents/contract.ts`, the frozen W1-CP-05 wire
shape) carries `id`, `name`, `instructions`, `modelConnectionId`, `model`, `permissions`,
`createdAt`, `updatedAt`. Five of the mockup's eight columns have no field to read: there is no
runtime profile on an agent, no run counter, no cost accumulator and no last-run timestamp
anywhere in this wave's schema, and the Run action points at `agent-run.html`, a screen no Wave 1
task builds.

## Decision

The list shows three columns: **Agent** (name, with a one-line preview of `instructions` in place
of the mockup's non-existent description, as `.cell-sub`), **Model** (`describeModel`, honest about
`null` meaning "workspace default" rather than asserting a specific model name), and **Created**
(`agents.createdAt`, which does exist). The Status, Runtime, Runs (7d), Cost (7d), Last run columns
and the per-row Run action are not rendered.

The alternative — filling five columns with data that does not exist — is the same failure
`ADR-0016` names in prose and `ADR-0015` names in a capability claim: a number or a status nobody
measured, presented as if it had been. "128 runs" next to an agent that has never run is not a
simplification, it is a fabrication with a table around it.

## Alternatives considered

- **Show the five columns as permanent placeholders (`—`).** Rejected: five columns of dashes is
  furniture — the same "framed empty state that says nothing" `W1-UI-02-empty-recent-is-absent.md`
  already rejected for a different screen, applied here to whole columns instead of one section.
- **Show the mockup's Run action, linking to `/`.** Rejected: the home page's agent picker is
  itself not wired to real agents in this wave (`app/(shell)/page.tsx` always answers
  `no-agents` — see `W1-UI-04-the-home-route-renders-per-request.md`), so the link would be
  `W1-UI-02-unbuilt-destinations-are-not-links.md`'s exact failure one hop later: a control that
  looks live and lands on a screen that cannot do what it promised.
- **Add a `runs`/`cost` aggregate now, computed from `InMemoryRunStore`.** Out of scope: `RunStore`
  has no method to list a workspace's runs (`app/(shell)/page.tsx`'s own header states this for
  Recent), and building one is not a "UI wiring" change to a screen this task owns — it is a change
  to `server/runs/**`, which this task does not own.

## Consequences

- The list is visually shorter than the mockup. That is the correct rendering of a workspace whose
  runtime, run history and cost tracking do not exist yet, not a defect in this table.
- When a runtime profile, a run counter or a cost figure becomes real, the corresponding mockup
  column has a natural home to return to; nothing here has to be redesigned, only extended with a
  new field this table already knows how to add a `<th>`/`<td>` pair for.
