---
changelog: platform
section: Changed
---

- ADR-0104 is accepted for `handoff` mode (U4.2a, #1515). The resource is an _agent team_
  (`./agent-teams`, `agent_teams*` tables, `/api/agent-teams/**`, `aw.agentTeams`,
  `aw agent-teams`). A lead calls a member as the tool `agent__<member>`, which
  `POST /api/runs/:id/members/mcp` serves on the lead run's token. Each call starts a child run
  that has its own policy, met with the ceiling. The depth is at most 1, a team has at most
  8 members, and a root has at most 16 child runs. The tree cost is summed when it is read, and
  interrupting the root cancels its children. The API specification gains §5.18 and the
  `parentRunId`, `children` and `treeCost` run fields, which land in U4.2b and U4.2c. The run tree
  is modelled in Lean (`Concepts/RunTree.lean`), with its normative theorems.
