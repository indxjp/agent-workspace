---
changelog: contracts
section: Changed
---

- In the engine catalogue, `limits.maxBudget: 'adapter'` now means the platform around the engine
  enforces the budget, and since ADR-0162 that is the gateway, not the adapter (#342). The OpenAI
  Agents, Mastra and pi adapters no longer price usage or stop a run themselves, so a client that
  shows who enforces a run's budget should name the gateway for `'adapter'`. `maxTurns: 'adapter'`
  still means the adapter. The value names are unchanged.
