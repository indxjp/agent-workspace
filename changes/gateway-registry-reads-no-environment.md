---
changelog: gateway
section: Changed
---

- `createProviderRegistry()` no longer reads `AW_SCRIPTED_MODELS_DIR` itself: scripted models are
  off unless the caller passes `scripted`, for example `scriptedModelsFromEnv(env)`, now exported
  from `@agent-workspace/gateway/providers/registry` with `createScriptedModels`. The gateway entry
  reads the variable at start-up, before the database opens, so a relative or non-local setting
  stops start-up before any connection.
