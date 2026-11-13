---
changelog: sdk
section: Added
---

- `aw.agentTeams` (ADR-0104, #1516): `list`, `listAll`, `get`, `create`, `remove`,
  `versions.create` and `versions.list` over `/api/agent-teams/**`. `runs.get` returns a
  `RunDetail` with `parentRunId`, `children` and `treeCost`, and `fixtures.runDetail(run)` in
  `@indx-workspace/sdk/testing` builds the read's answer for a test double.
