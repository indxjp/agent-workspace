---
changelog: platform
section: Added
---

- The agent-team routes of ADR-0104's acceptance (spec 04 §5.18, #1516): `GET/POST
  /api/agent-teams`, `GET/DELETE /api/agent-teams/:id` and `GET/POST /api/agent-teams/:id/versions`,
  cursor paged, decided as the `agents` resource (every role reads, a Builder writes its own teams,
  Owner and Admin any) and audited as an agent change naming the team. A bad lead or member list is
  `422 agent_team_member_invalid`; another workspace's team is `404 agent_team_not_found`.
- Run trees on the run read: every run renders `parentRunId`, and `GET /api/runs/:id` adds
  `children` (at most 16, oldest first, one indexed read) and `treeCost`, the exact decimal sum of
  `cost` over the run and its children. Lists carry neither. Nothing starts a child run yet.
