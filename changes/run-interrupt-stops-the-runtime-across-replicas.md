---
changelog: platform
section: Fixed
---

- `POST /api/runs/:id/interrupt` now stops the runtime within about one cancellation-watch interval
  (2 s) whichever replica serves it. Before, an interrupt served by a replica that did not hold the
  run's stream made the run `cancelled` and revoked its tokens, but the runtime kept running until
  its credential-bounded lifetime ended. The replica holding the run now reads the committed status
  and interrupts its runtime (ADR-0151-FU-1440 D1, issue #261). No migration.
