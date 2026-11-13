---
changelog: gateway
section: Security
---

- The gateway now refuses a run token whose own claims give it a lifetime longer than one hour,
  the same cap that minting already enforced.
