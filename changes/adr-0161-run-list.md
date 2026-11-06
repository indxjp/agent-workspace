---
changelog: platform
section: Changed
---

- ADR-0161 is amended (issue #1530): an `app-backend` access token (`awo_live_`) is also admitted
  on `GET /api/runs`. The list is the one the person gets in the console, narrowed to the agents
  the endpoint client binds; an `agent` filter outside them is `403 token_out_of_scope`. An app's
  Dashboard (`dashboardRoutes()`) and the portal template's Dashboard and `/runs` page now list
  the signed-in person's runs instead of answering `401`.
