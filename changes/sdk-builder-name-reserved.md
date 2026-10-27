---
changelog: sdk
section: Added
---

- `BuiltinAgentProblemCode` is exported, and `agents.create` and `agents.update` can throw
  `ApiProblemError` with code `builder_name_reserved` (`403`) when a Member gives an agent a name
  the deployment's `builder.allow` lists.
