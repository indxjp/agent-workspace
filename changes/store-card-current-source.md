---
changelog: platform
section: Fixed
---

- Agent Store: a live card says "verified with real Claude" only from a real-model record of the source it runs now
  (its source hash, generated at build time into `source-hashes.generated.ts`). A record made for another source,
  such as a rebuild staged as `next` (ADR-0174), no longer changes the card.
