---
changelog: platform
section: Security
---

- The Builder's run-token door (`POST /api/builder/mcp`) limits each run to 120 requests a minute
  (`429 builder_rate_limited` with `Retry-After`) and refuses a write or spend tool call that
  carries no engine tool-use id (`invalid_arguments`) instead of minting one.
- A credential that cannot read agents (a scoped API key or browser token) now gets the `404
  agent_not_found` of a missing agent, not `403 builtin_agent_read_only`, for a write to the
  built-in Builder agent.
