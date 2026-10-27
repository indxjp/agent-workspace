---
changelog: platform
section: Added
---

- A run of the Builder, or of a person-made agent whose name the deployment's `builder.allow`
  lists, now has the `aw-control` tools. A run the rule does not give them to is refused
  `not_allowed_to_build` at the door, before anything is journalled. The composed door does not
  widen the agent. The server logs one warning per agent when it first sees a run of an allow-listed
  agent whose owner is not an Owner or Admin of its workspace.
- Creating an agent with a name in the deployment's `builder.allow`, or renaming one to it, needs a
  workspace Owner or Admin; a Member is answered `403 builder_name_reserved`. An edit that keeps an
  agent's stored name is not a rename.
- A console create of an agent now takes the per-workspace creation lock, so it cannot race a
  Builder or agent create past the workspace's agent limit.
