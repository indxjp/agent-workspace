---
changelog: platform
section: Fixed
---

- A run's Technical details, its error and the call it is waiting to have approved no longer show
  the folder the run works in on the runtime's host, such as `/srv/runner-ws/<ids>/…`; it reads
  `<workspace>`, and a path inside it keeps its relative part: `<workspace>/outputs/report.md`.
  Runs recorded before this change are shown the same way (UX-02 in #2086).
