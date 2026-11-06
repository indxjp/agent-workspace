---
changelog: platform
section: Added
---

- Run-outcome webhooks (N-3, #250): `GET`/`POST /api/webhooks` and `DELETE /api/webhooks/:id`
  register, list and remove up to 10 endpoints per workspace (Owner and Admin; `runs` feature). The
  `whsec_` signing secret is returned once by the create answer and kept in the secrets service. A
  delivery worker in the web process (PostgreSQL only, no new service) posts a Standard Webhooks v1
  signed `WebhookEvent` when a run completes, fails or is cancelled, through the egress policy at
  create and on every attempt, and retries a failed attempt with jittered backoff (8 attempts over
  about 21 hours) under the same `webhook-id`.
- `contracts`: the route table lists `webhooks.list`, `webhooks.create` and `webhooks.remove`, and
  the OpenAPI document carries them.
