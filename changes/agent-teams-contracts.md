---
changelog: contracts
section: Added
---

- `@indx-workspace/contracts/agent-teams`: the agent-team wire contract of ADR-0104's acceptance
  (spec 04 §5.18, #1516). `CreateAgentTeamRequestSchema` and `CreateAgentTeamVersionRequestSchema`
  (a lead and 1–8 members, each pinned to an agent version; no repeated agent or member name, and
  the lead is not a member), `AgentTeamResourceSchema`, `AgentTeamVersionSchema`, the cursor-paged
  list responses, `AGENT_TEAM_PROBLEM_CODES` (`agent_team_not_found` 404, `agent_team_name_taken`
  409, `agent_team_member_invalid` 422) and the tool error `team_member_limit`. A member name is a
  slug of at most 52 characters, so `mcp__agent__<member>` fits the 64-character tool-name budget.
