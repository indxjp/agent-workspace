---
changelog: platform
section: Fixed
---

- An evaluation case's `expect.tool` matches a tool called with the engine's prefix: `tool: search_files` now passes when Claude reports `mcp__agent-workspace__search_files`, as a surface's `toolResults` key already did. The prefixed name still matches.
