---
changelog: sdk
section: Added
---

- `aw.webhooks.list | create | remove` (N-3, issue #250, ADR-SDK-18-N3-250): register the endpoints
  a run's outcome is posted to. `create` answers `{ webhook, secret }`, the only time the `whsec_`
  signing secret is returned; `remove` resolves on the `204`.
- `verifyWebhookSignature({ secret, headers, body, toleranceSeconds?, now? })` checks a delivery's
  Standard Webhooks v1 signature with Web Crypto (any `v1` entry may match, compared in constant
  time; the timestamp must be within 5 minutes) and returns the contract-checked `WebhookEvent`.
  A refusal is a `WebhookVerificationError` whose `code` is `missing_header`, `invalid_secret`,
  `timestamp_out_of_tolerance`, `signature_mismatch` or `invalid_payload`.
