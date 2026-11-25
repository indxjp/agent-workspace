---
changelog: platform
section: Added
---

- In an Agent Store demo, a write tool a seed declares as recorded now keeps the change once the
  visitor approves the paused call: the platform writes it into the visitor's own records stand-in
  before the continuation run starts, so the next read in that demo workspace returns it, no other
  visitor's workspace sees it, and it is deleted with the workspace. A write nobody approved, or
  whose arguments are not a valid calendar event, task, access change or booking, changes nothing
  and is answered with a typed error (ADR-0169).
