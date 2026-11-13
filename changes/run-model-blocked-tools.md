---
changelog: react
section: Added
---

- `Run.blocked` and `withBlockedTool` in `@indx-workspace/react/run-model`, with the `BlockedTool`
  type: the tool calls an engine refused without asking anyone, each recorded once by its call id.
  `beginRun` starts it empty.
