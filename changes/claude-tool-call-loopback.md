---
changelog: platform
section: Fixed
---

- A claude-agent-sdk run now ends at most 5 seconds after its `result`, even when the SDK's stream
  stays open after it: the boundary aborts the SDK and its CLI, and the run ends with the result it
  reached. Before, a CLI that lingered held the run open until its credential expired. Issue #2076
  found the reported failure (an app-connector `tools/call` refused `ECONNREFUSED` under `aw dev`
  after `tools/list` succeeded, then a run that did not end) to be a harness artefact, not a
  platform bug. A journeys harness that ran Playwright with `spawnSync` blocked the process that
  serves the scripted model. The run's model request was answered only after Playwright returned,
  as the harness stopped `aw dev`, so the tool call reached an app that had stopped. The apps lane
  runs Playwright without blocking (`attemptAsync`), and a lane test now keeps every synchronous
  call out of the journeys step. With that fixed, the lane showed why triage still left the ticket
  as it was. A recipe step's run asserts its person as an API-key subject, which holds no role, so
  the service-desk `ticket`'s `member` rules refused it with `resource_not_found`. The reference
  app's `ticket` now also admits its `requester` on read and update, and triage moves the ticket
  to `in_progress` under `aw dev`.
