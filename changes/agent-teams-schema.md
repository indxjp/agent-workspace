---
changelog: platform
section: Added
---

- Migration `0097_agent_teams` (expand-only, #1516): the tenant-paired tables `agent_teams`,
  `agent_team_versions` and `agent_team_version_members`, where a team version pins the lead's and
  each member's agent version, and the nullable `runs.parent_run_id`, a run of the same workspace
  and never the run itself. Nothing writes `parent_run_id` yet. The core `AgentTeamRepository`
  numbers versions under the team's lock and refuses another workspace's agent, an unknown version
  and the lead listed as a member. The formal ER model gains the three tables and the column.
