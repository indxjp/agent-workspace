---
changelog: platform
section: Changed
---

- The model gateway parses its settings once, before it opens the database, and names every
  refused variable in one start-up error. A missing or invalid `GATEWAY_PRICING_JSON` now stops
  start-up before any database connection. `docs/operations/settings.md` lists the gateway's
  variables.
