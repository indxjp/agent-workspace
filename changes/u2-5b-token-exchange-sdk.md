---
changelog: sdk
section: Added
---

- `aw.auth.exchange({ clientId, clientSecret, idToken })` (ADR-0161) trades the signed-in person's
  OIDC ID token for a 300-second `awo_live_` access token of an `app-backend` endpoint client,
  posting `/api/auth/token-exchange` with the client pair as `Authorization: Basic`. A client built
  with the new `auth: { kind: 'access-token', token }` presents that token as a bearer and acts as
  the person: it starts runs on the client's bound agents the person may run, reads and interrupts
  their runs, and reads `me`.
