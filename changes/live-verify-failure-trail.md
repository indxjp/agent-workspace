---
changelog: platform
section: Changed
---

- A failed real-model verification record (R1, the daily production test) now says what the turn
  did: the tools it called in order, the calls that waited for a person and the engine's stop
  reason, and an approval moment says whether the write ran without approval, was called but refused
  or failed, or was never called.
  The evidence keeps no transcript, so this is what tells a gate that did not hold from an agent
  that stopped early.
