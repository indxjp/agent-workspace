# ADR-0104 — A team is a resource: a lead calls members as tools, in one trace

Status: accepted — handoff mode (U4.2a, 2026-10-31); switcher stays proposed. Draft from the developer-journey hearing (decision D7), kept in the end state by the blueprint decision Q4 of 2026-10-04
Date: 2026-10-01; accepted 2026-10-31
Decided by: the product owner, in the developer-journey hearing; accepted for `handoff` mode by the Owner's recorded default O-4 of the agent portal programme ("accept ADR-0104 agent teams before recipes", issue #1515, 2026-10-31)
Scope: `packages/contracts` (an `agent-teams` family), `apps/web` (the member endpoint, the run view), `packages/core` (three tables and `runs.parent_run_id`), `packages/sdk` (`aw.agentTeams`), `packages/aw` (`aw agent-teams`); the engine port only maps a tool name

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

## Acceptance (U4.2a, 2026-10-31)

Accepted for `handoff` mode by the Owner's recorded default O-4 (issue #1515): agent teams are
accepted before recipes. This section settles what the decision above left open and what today's
code contradicts, so the contract and storage unit (U4.2b) and the runner unit (U4.2c) need no
further design. The one-trace model is written in Lean first, as the amendment above requires:
`formal/AgentWorkspace/Concepts/RunTree.lean`, with its theorems in
`formal/AgentWorkspace/Theorems/Normative/RunTree.lean`. The API is amended in
[the API specification](../sdk/04-api-specification.md), §5.18 and §5.12.

1. **Names: the resource is an _agent team_.** "Team" already means the people of a workspace:
   the contracts entry `./team` (`MEMBERSHIP_ROLES`, `MeResponse`), the SDK's `aw.team`, the CLI's
   `aw team` and the console's team pages. Names that differ from those by one letter would be
   read as the same concept, so every layer says _agent team_, named alike (ADR-0114):
   - contracts `./agent-teams` (`packages/contracts/src/agent-teams.ts`);
   - tables `agent_teams`, `agent_team_versions` and `agent_team_version_members`;
   - routes `/api/agent-teams/**`;
   - SDK `aw.agentTeams`;
   - CLI `aw agent-teams`.

   The earlier plan's `contracts/teams`, `aw.teams` and `aw teams` are superseded. The tables take
   the next free migration number when U4.2b writes them (today `0097`, after
   `0096_app_backend_endpoint_clients`), not a number reserved earlier. Every row carries
   `workspace_id` with tenant-paired foreign keys, and the migration is expand-only.
2. **Scope: `handoff` only.** Only `handoff` is accepted and built. `switcher` stays proposed. It
   is a surface concern (ADR-0105) and needs no platform state beyond today's one session per
   (person, agent).
3. **The tool name.** The neutral tool name is `agent__<member name>`. Each engine adapter maps it
   to the form its engine shows. The Claude engine sees member tools as one MCP server with key
   `agent`, so the model sees `mcp__agent__<member name>`. Approval and policy rules are written
   against the neutral name and mapped the same way. A member name is team-local: a slug
   (`[a-z0-9][a-z0-9_-]*`) of at most 52 characters, so `mcp__agent__<member name>` stays within
   `TOOL_NAME_MAX_LENGTH` (64), which `assertToolNamesFit` checks at run time. It defaults to the
   agent's name when that fits. A team whose member name does not fit, or repeats, is refused at
   write time with `422 agent_team_member_invalid`, never at run time. Reason: an agent name may
   be up to 200 characters, and the engine port (ADR-0065) owns how a tool is spelled.
4. **Where `agent__` is served.** A control-plane MCP endpoint, `POST /api/runs/:id/members/mcp`,
   serves a lead run's member tools. It is authenticated by the **lead run's** run token, admitted
   at the edge exactly as the runner's `/api/sessions/**` seam admits that token (never a person's
   `aw login` token). The proxy admits this one path pattern, and the route adapter verifies the
   token again and admits it only when the token's run is the `:id` of the path. Reason: only the
   control plane can start a run (`startRunOnSession`, `createRunnerLauncher`). The gateway stays
   the only caller of tool sandboxes (ADR-0134 D7), and this endpoint does not touch them.
5. **A member call.**
   - The call creates or reuses **one session per (root run, member)** for the member agent. A run
     reaches its agent only through its session, so a member needs its own. Inside that session it
     starts a child run whose `parent_run_id` is the lead run, through `startRunOnSession`. The
     start is idempotent (S-6, ADR-0151): the key is derived from the lead run and the tool call
     id, so a retried tool call does not start a second child.
   - It waits for the child to reach a stopped status. It returns the child's `output.text`
     (ADR-0143) as the tool result, or a typed tool error when the child failed or was cancelled.
   - The member runs with **its own** agent definition, policy and permissions, met with the
     deployment's ceiling (`meetPolicyCeiling`, ADR-0102 SD6), never with the lead's. A member's
     permissions never exceed its own definition, even when the lead's are wider, and the ceiling
     only narrows. The team version pins which member version runs (decision 11).
6. **Depth and fan-out.** The depth is at most 1. A member may not be a team, and a member run gets
   no `agent__` tools, so a child never has children. A team has at most 8 members, and a root run
   has at most 16 child runs. A call over a limit is not started. It returns the tool error
   `team_member_limit` to the lead, which can answer without it.
7. **Cost, trace and evaluation.**
   - Each child run keeps its own `cost_usd` and usage, settled as any run's. The root's rolled-up
     cost is a read-time sum over the tree (`GET /api/runs/:id` answers `treeCost`). There is no
     denormalised column, so the sum cannot disagree with its parts.
   - The trace is the root's events plus each child's events, linked by `parent_run_id`. The
     streams are not merged. The run view renders the tree (`children` on `GET /api/runs/:id`).
   - An evaluation targets the root run, whose answer is the team's answer.
8. **Cancellation.** Interrupting the root interrupts every live child through the durable
   cancellation path of #261 (ADR-0151-FU-1440): the interrupt commits each child's `cancelled`
   status and revokes its tokens, and the replica holding each child's stream stops its runtime on
   the cancellation watch. A child that fails or is cancelled on its own returns an error to the
   lead and does not, by itself, fail the root.
9. **Identity.** A child run inherits the root's caller (ADR-0142 D2 `caller`) and its initiating
   principal and user, so grants, tool-caller assertions and audit name the person who asked.
   Agents never exceed the person: every member write carries its own `run_id`, the child's.
10. **RBAC.** The agent-teams routes reuse the existing `agents` RBAC resource: reading a team is
    reading an agent, and creating, versioning or deleting a team is the same write as on an agent
    (Builder and above; a Builder on their own teams, as on agents). No new authorisation resource
    is added, so the authorisation model needs no new resource. Running a team is the `run` verb
    on the lead agent. Agents never exceed the person: a member call is made only when the person
    the root run acts for may also `run` that member agent, and otherwise returns a typed tool
    error. Every member is an agent of the team's workspace (tenant-paired foreign keys).
11. **Versioning.** A team version pins `(agent_id, agent_version_id)` for its lead and for each
    member (ADR-0101: "the unit is one agent or one team"), so a team run is reproducible. Team
    versions are immutable and numbered per team. There are no promotion pointers for team
    versions yet; a team runs its newest version until a later decision adds them.
12. **Naming note for #1281.** ADR-0104 teams are **agent** teams: groups of agents that a lead
    agent calls. They are not groups of people, and a person is never a member of one. A
    people-grouping concept does not exist and is out of this ADR. ADR-0142 D3's `{team}` grant
    placeholder, which resolves "against the teams ADR-0104 defines", therefore has no source in
    this ADR. It needs its own decision on grouping people before #1281 can be built.

**Answered open question.** Recursion: no. The depth is at most 1 and a member may not be a team
(decision 6). Nested teams would need a new decision.

## Open questions

- Recursion depth, and whether a member may itself be a team. **Answered** by the
  [acceptance](#acceptance-u42a-2026-10-31), decision 6: the depth is at most 1, and a member may
  not be a team.
