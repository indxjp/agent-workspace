---
changelog: contracts
section: Added
---

- `bareToolName(toolName)` and `namesTool(name, toolName)` in `@indx-workspace/contracts/surfaces`: a run's tool name without the engine's prefix (`mcp__<connector>__search_files` is `search_files`), and whether a definition's tool name names a run's tool. `toolResultFor` uses them.
