---
changelog: platform
section: Security
---

- An approval gate on an MCP connector (`requireApproval: mcp__<connector>__<tool>`) now keeps
  guarding the write after the connector is renamed, or when a same-named tool connector moves it to
  its `connector-<id>` key. The gate was stored under the connector's name, so in either case it
  matched no tool and the write ran without waiting for a person. A save now stores the gate by the
  connector's id, as it already stored tool rules (a demo template's seed included); a run points every gate at the connector's key in
  that run, a gate an earlier version stored by name included; and a run in which a gate on one of
  its connectors would still match none of its tools is refused with `approval_gate_unresolved`
  instead of starting without the gate (ADR-0145, amendment #2439). A gate an earlier version stored
  by name, on a connector renamed since, cannot be linked to it: save the agent again with the gate
  on the new name.
