---
changelog: platform
section: Fixed
---

- A run on the claude-agent-sdk engine that asks for structured output with a schema naming its
  draft 2020-12 `$schema` (as `z.toJSONSchema` writes it) no longer fails before the model is
  asked: the engine hands Claude Code the schema without that reference, which its validator
  cannot resolve.
