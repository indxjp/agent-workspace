---
changelog: platform
section: Changed
---

- A run start refused with `429 daily_cost_cap_reached` no longer lists `spentUsd` in `details`: it carries `capUsd` and `resetsAt` (and `unpricedUsage: true` when it applies), as the mid-run stop already did. The agent page also reads its tabs again after a restore, and a failed sweep listing is retried at the next delivery instead of after an hour.
