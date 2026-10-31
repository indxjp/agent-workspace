---
changelog: platform
section: Added
---

- `POST /api/auth/token-exchange` (ADR-0161): an app backend exchanges the signed-in person's ID
  token from the deployment's own `OIDC_ISSUER_URL` for a 300-second `awo_live_` access token of its
  new `app-backend` endpoint client. The token acts as that person on `POST /api/agents/:id/runs`
  (bound agents only), `GET /api/runs/:id`, `GET /api/runs/:id/events`,
  `POST /api/runs/:id/interrupt` and `GET /api/me`, through the person's own role and agent grants,
  and every exchange writes one `user-token-exchanged` audit row. Migration `0096` adds
  `endpoint_clients.oidc_audience` and widens the kind and audit-action checks (expand only).
