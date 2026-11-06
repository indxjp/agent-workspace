---
changelog: platform
section: Fixed
---

- A Builder `trial_run` whose run fails after it started now interrupts that run by id before the failure propagates, so it cannot keep spending under the full policy budget.
- `evals_run` runs each case under the policy's trial budget, as `trial_run` does, and starts nothing when the run API cannot interrupt a run.
- The Builder's log line for a failed trial interrupt carries the error class and a system code such as `ECONNRESET`, never the message.
