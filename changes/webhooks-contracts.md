---
changelog: contracts
section: Added
---

- `@indx-workspace/contracts/webhooks`: the run-outcome webhook contract (N-3, #250):
  `WebhookEndpointSchema`, `CreateWebhookRequestSchema`, `CreateWebhookResponseSchema`,
  `WebhookListResponseSchema`, the signed `WebhookEventSchema` envelope, `WEBHOOK_EVENT_TYPES`,
  the Standard Webhooks v1 header names and `webhookSignedContent`, and `WEBHOOK_PROBLEM_CODES`.
- `ApiRoute.headers` declares the request headers a route reads beyond the shared ones; `runs.start`
  declares its optional `Idempotency-Key`, and the OpenAPI document emits it as a header parameter.
