---
changelog: platform
section: Fixed
---

- MCP connector Test Connection now sends every request through the egress policy, accepts CRLF and CR line endings on SSE streams, and reports JSON-RPC error codes outside the protocol range as server refusals instead of "not an MCP server".
