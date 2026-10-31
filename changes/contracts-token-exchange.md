---
changelog: contracts
section: Added
---

- `@indx-workspace/contracts/token-exchange`: `TokenExchangeRequestSchema`,
  `TokenExchangeResponseSchema`, `TOKEN_EXCHANGE_PROBLEM_CODES`, `TOKEN_EXCHANGE_TTL_SECONDS`,
  `OAUTH_ACCESS_TOKEN_PATTERN` and the RFC 8693 type identifiers (ADR-0161). Endpoint clients gain
  the `app-backend` kind and `oidcAudience`; the audit trail gains `user-token-exchanged`; the
  route catalogue gains `auth.exchange`.
