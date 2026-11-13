---
changelog: platform
section: Fixed
---

- Approving or rejecting a paused run now works when an Owner or Admin decides another member's run, and when the run had file attachments; the continuation no longer fails with `session_not_usable` or `run_file_scope_not_granted` after the decision is consumed.
- A run paused for approval is now cancelled with `approval_expired` once its 24 hour deadline passes, so an approval-gated trigger no longer stays blocked by undecided runs.
- An `Idempotency-Key` used on an agent-team run route is no longer treated as a replay of a run started on another team or on the lead agent directly.
- A run start refused after its new session was opened no longer leaves an empty session behind.
