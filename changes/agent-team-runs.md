---
changelog: platform
section: Added
---

- Agent teams run (ADR-0104 acceptance, spec 04 §5.18, #1517). `POST /api/agent-teams/:id/runs`
  starts the team's newest version on its lead, as a run start of the lead (the same body without
  `version`, the same `Idempotency-Key` and refusals; `409 agent_team_has_no_version` for a team
  with no version; a scoped token is `403 token_out_of_scope`). The root run records its team
  version in the new nullable, tenant-paired `runs.agent_team_version_id` (migration 0098).
- The lead sees each member as `agent__<member>` (`mcp__agent__<member>` on the Claude engine),
  served by `POST /api/runs/:id/members/mcp` on the lead run's own token at `AW_PUBLIC_URL`. A
  member call starts a child run of the member's pinned version for the person behind the lead, with
  its own definition met with the ceiling, at most 16 per root (under a lock), waits for it and
  returns its answer, or a typed tool error (`AGENT_TEAM_TOOL_ERROR_CODES`) that never carries
  provider text. A child run gets no member tools, and interrupting the root interrupts every live
  child through the durable cancellation path.
- SDK `aw.agentTeams.run(id, input)` and CLI `aw agent-teams run <team> <prompt>` (with
  `--session`, `--idempotency-key`, `--wait`, `--follow` and `--fail-on-error`).
