# ADR-0104 — A team is a resource: a lead calls members as tools, in one trace

Status: proposed — draft from the developer-journey hearing (decision D7); kept in the end state and scheduled for phase D by the blueprint decision Q4 of 2026-10-04
Date: 2026-10-01
Decided by: the product owner, in the developer-journey hearing; to be confirmed when this ADR is accepted
Scope: `packages/contracts` (a `teams` family), `apps/runner`, `packages/engine` (the engine port), `apps/web` (run view), `packages/sdk`

## Amendment — teams stay in the end state, built in phase D (blueprint decision Q4, 2026-10-04)

Decided by the Owner, in the blueprint review of 2026-10-04 (the blueprint, decision log Q4). Teams are part of the end state and are built in phase D of the
developer-journey plan, after versions, evaluation and promotion are in place. Until then a
version's unit stays one agent, and nothing in the version model may assume it always will be
([ADR-0101](0101-the-platform-owns-agent-versions.md): "the unit is one agent or one team"). The
one-trace model is written in Lean before the runner work starts. Moving teams into phase B
(scope roughly doubles) and dropping `handoff` were both declined.

## Context

There is no multi-agent resource today. `docs/sdk/site/building/embedding.mdx` offers several
agents side by side in a switcher, and a backend can chain runs itself. Neither makes "a lead hands
off to a specialist" something the platform can version, evaluate, show as one trace, or bill as
one conversation.

Engines differ: the Claude Agent SDK has subagents, the OpenAI Agents SDK has handoffs, and Mastra
has workflows. The engine port (ADR-0065) keeps engine-native behaviour behind a neutral surface.

## Decision

- A **team** is a published unit (ADR-0101) with a lead and members. Each member is an agent of
  the same workspace.
- Two modes:
  - `handoff` — the lead sees each member as a tool, `agent__<name>`. Calling it runs the member
    in its own sandbox, with its own permissions, and returns its answer to the lead.
  - `switcher` — no lead. Users choose the agent in the surface (ADR-0105). Each person keeps one
    session per agent.
- The platform implements `agent__<name>` itself, as a tool, not through an engine's native
  subagents. This keeps the behaviour identical across engines and keeps every member inside the
  policy ceiling (ADR-0102).
- One user message produces one **run tree**: the lead's run and its members' child runs, with one
  trace, one cost and one evaluation.
- A team's version pins the version of each member, so a team is reproducible.

## Alternatives rejected

- **Engine-native subagents only.** Rejected: behaviour and permissions would differ by engine,
  and a member's work would not be visible as its own run.
- **Backend orchestration only** (today). Kept as an option for custom flows, but it cannot be
  versioned or evaluated as a unit.

## Consequences

- Runs gain `parentRunId`, and the run view renders a tree.
- Cost and usage roll up from child runs to the root.
- A member's permissions never exceed its own definition, even if the lead's are wider.

## Open questions

- Recursion depth, and whether a member may itself be a team.
