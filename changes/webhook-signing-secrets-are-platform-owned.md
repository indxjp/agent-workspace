---
changelog: platform
section: Security
---

- A webhook's signing secret (`WEBHOOK_<id>_SIGNING_SECRET`, issue #250) is platform-owned, like a
  storage connection's secret: a run's tools, connectors and tool endpoints never receive it, and
  `/api/secrets` refuses to create or replace a secret with that exact name (`409`); deleting it is
  still allowed. Other names such as `WEBHOOK_STRIPE_SIGNING_SECRET` stay ordinary secrets. A
  delivery attempt that fails inside the platform (an unreadable secret or run) now counts as a
  failed attempt and ends `failed` after the usual 8 attempts instead of being claimed forever.
