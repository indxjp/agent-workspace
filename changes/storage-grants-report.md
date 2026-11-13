---
changelog: platform
section: Added
---

- `docs/operations/storage-grants-report.sql`, a read-only report of the agent versions whose
  storage-connection folders cannot be bound at run time (deployed before per-version grants, or
  granting a deleted connection), with the environments pointing at each. The runbook says when to
  run it.
