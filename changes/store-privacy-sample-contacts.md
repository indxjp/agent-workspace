---
changelog: platform
section: Fixed
---

- Agent Store: the privacy review use case's sample design memo (`use-cases/privacy`) plants its
  test member's phone number and email address in the ranges set aside for fiction
  (`090-0000-2286`, `@example.com`), so the sample-data check that every live entry passes accepts
  it; the planted personal data is still there for the agent to spot.
- The sample-data check that refuses a real-looking email address or phone number now runs on
  every coming-soon entry seeded with its code too, so it fails before that entry's R1 run rather
  than at its flip.
