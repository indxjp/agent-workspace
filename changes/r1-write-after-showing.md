---
changelog: platform
section: Fixed
---

- The returns desk, terminology checker and document translator use cases (`use-cases/returns`,
  `use-cases/glossary`, `use-cases/translator`) now go on to their approval-gated write in the
  same turn as the table or translation they show, instead of ending after it, and say which
  requests ask for the file (R1 run 44985488322 found the write never called).
- A failed real-model verification record (R1, and the daily production test's maintenance
  reason) now says whether the turn ended on a question or a statement, never quoting the answer,
  so an agent that asked for a go-ahead in prose can be told from one that stopped silently.
