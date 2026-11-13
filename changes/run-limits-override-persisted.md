---
changelog: platform
section: Fixed
---

- A run started under a lower-only limits override (a Builder trial's budget, for one) now keeps it
  across an approval continuation: the override is stored on the run (`runs.limits_override`, a
  nullable column added by migration 0093) and the continuation reads it back, where before it fell
  back to the agent's full policy budget. A lower policy budget still wins.
- The daily cost cap now counts a run whose usage settlement failed as unpriced even when it wrote
  no ledger row that day, so a settlement failure can no longer leave a workspace looking under its
  cap. Two indexes (`run_usage_records (workspace_id, created_at)` and a partial index on the audit
  log's agent restore rows) keep the cap's window sum and the archive sweep's restore lookup off
  full scans.
