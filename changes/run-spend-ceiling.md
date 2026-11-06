---
changelog: platform
section: Added
---

- A run stops at its spend ceiling on every engine (ADR-0162, #1524). `runs.spend_ceiling_usd`
  (migration 0099) holds the lowest of the agent's `limits.maxBudgetUsd`, the deployment ceiling's
  and the start's new `spendCeilingUsd` (`aw.runs.start(agentId, { spendCeilingUsd })`,
  `aw runs start --spend-ceiling-usd <usd>`), which can only narrow: a higher value is
  `403 policy_cannot_widen` with the detail `spendCeilingUsd`. The run resource returns it as
  `spendCeilingUsd`. Once the run's cost reaches it, the gateway refuses the next model call with
  `403` `run_budget_reached` and ends the run `failed` with that failure code (`503
  run_budget_unavailable` when the end cannot be written). The engine receives the same value as
  its `limits.maxBudgetUsd`. The console run view says "Stopped at its spend ceiling (<n> USD)",
  shows the ceiling next to the cost, and says when an unpriced model leaves it unenforced.
