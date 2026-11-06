---
changelog: platform
section: Fixed
---

- An evaluation now interrupts, and waits for the interrupt of, a case run that is paused for an approval, abandoned at the deadline, or whose event stream cannot be read, before it answers. Under the Builder's trial limits an evaluation that cannot stop a case run answers a typed `trial_not_stopped` refusal and stores no row; `POST /api/agents/{id}/evaluations` keeps storing the row and logs the failure.
- Evaluation log lines for a failed interrupt, judge call or stream read name the error class only and no longer carry the error's message.
