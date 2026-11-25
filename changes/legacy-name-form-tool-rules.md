---
changelog: platform
section: Security
---

- A `deny` that an agent version saved before #1109 holds by an MCP connector's name
  (`mcp__<connector>__<tool>`) now still denies the connector's tool when a same-named tool
  connector moves the connector to its `connector-<id>` key: the run adds the connector's key to the
  rule. In the same case a name-form `autoApprove` or `tools.base` entry is dropped instead of
  granting the tool connector that now holds the name. Save the agent again to store its rules by
  connector id, which also keeps them after a rename (#2446).
