---
changelog: platform
section: Added
---

- Agent Store catalog: a live entry may carry `next: { source, demo }`, a rebuild staged in its own `use-cases/<slug>`.
  The staging deploy seeds the rebuild and the real-model verification (R1) runs on it, while visitors and the
  promotion check keep the current source. A repoint that moves `next` into place keeps the record R1 made, so the
  entry is never live without a passing record for its current source (ADR-0174).
