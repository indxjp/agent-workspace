---
changelog: sdk
section: Changed
---

- `AgentVersionSource.project` no longer lists `models` in its `Pick<ProjectDocument, …>`: `agentFromVersionBody()` never read it, because the body names its model connection itself. A full `ProjectDocument` is still accepted.
