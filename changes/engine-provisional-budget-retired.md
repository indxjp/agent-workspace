---
changelog: platform
section: Removed
---

- The provisional adapter-side budget caps of the OpenAI Agents, Mastra and pi engines (ADR-0074 D7,
  #342) are retired, as ADR-0162 decides: `limits.maxBudgetUsd` is enforced by the gateway for every
  engine. The adapters no longer price usage, stop a run `max_budget` or refuse a cap on a model
  their price table did not list; such a run now starts. `@agent-workspace/engine` no longer exports
  `provisionalBudget`, `subagentBudgetRefusal`, `provisionalPriceFor`, `PROVISIONAL_MODEL_PRICES` or
  `PROVISIONAL_PRICES_CHECKED_ON`.
