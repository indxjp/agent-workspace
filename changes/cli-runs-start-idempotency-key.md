---
changelog: aw
section: Added
---

- `aw runs start --idempotency-key <key>` sends the key as the `Idempotency-Key` header (issue
  #250, S-6), so a start rerun with the same key and prompt prints the run the first one started
  instead of starting another. A key reused with another prompt exits with
  `run_idempotency_conflict`; a blank key is a usage error, refused before any request.
