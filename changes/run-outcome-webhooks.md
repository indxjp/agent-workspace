---
changelog: platform
section: Added
---

- The "Webhooks" resource guide (issue #250, N-3): register an endpoint, what a `WebhookEvent`
  carries, the Standard Webhooks v1 signature and `verifyWebhookSignature`, the retry schedule,
  deduplication and who may manage webhooks. "Integrate a backend" shows a receiver that verifies
  the raw body, deduplicates on the event id and answers a fast `2xx`, and "Retries and
  idempotency" points at a webhook instead of a polling loop. The roadmap's N-3 entry is removed.
