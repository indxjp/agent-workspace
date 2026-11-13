---
changelog: app
section: Added
---

- The agent panel bound to a record. `agentPanelRoutes({ resources, agents })` from
  `@indx-workspace/app/server` serves `app/api/agent-panel/[...path]/route.ts`: it starts a run
  about the record as the signed-in person (after the resource's own read check), streams the run's
  events with `Last-Event-ID` resumption, reads the run with the call it waits on, and approves or
  rejects that call. `409 session_busy` is passed on as "the agent is still working"; every other
  refusal of Agent Workspace's is passed on by its code and status only.
- `AgentPanel` from `@indx-workspace/app/react` draws it, for `ResourceDetail`'s `aside` slot: an
  agent picker, the conversation, the tool steps and the run's status in `ja` and `en`, and a
  `renderApproval` slot for the approval prompt (a notice to decide in Agent Workspace when none is
  given). `agentPanelClient` is its transport, reconnecting a dropped stream up to five times.
- `agent_panel_sessions` keeps the platform sessions of each record, agent and person in the app's
  own schema (`createAgentPanelSessionsSql`, `agentPanelSessionsOf`, and `memoryAgentPanelSessions`
  in `./testing`); the app template's first migration creates it. Each person continues only their
  own conversation, and a session is never overwritten, so a run of an older one stays the
  record's.
