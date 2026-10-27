---
changelog: contracts
section: Added
---

- `BUILTIN_AGENT_PROBLEM_CODES` gains `builder_name_reserved` (`403`): the name is one the
  deployment's `builder.allow` lists, which only a workspace Owner or Admin may give. The closed
  list's key type is exported as `BuiltinAgentProblemCode`.
