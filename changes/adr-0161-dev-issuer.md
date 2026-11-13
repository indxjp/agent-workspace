---
changelog: platform
section: Changed
---

- ADR-0161 is amended (issue #2075): `aw dev` runs a development OIDC issuer on `127.0.0.1`, so an
  app signs a person in and acts as them by the unchanged token exchange locally. The issuer is a
  CLI tool (Ed25519 keys from `node:crypto`, no new dependency), runs only when no `OIDC_*`
  variable is set, and asks for a member's email and the local console password. The local
  runtime's `start` message gains `environment.devIssuer` (ADR-0109 contract C1). The production
  posture refuses a non-`https:` `OIDC_ISSUER_URL` at boot (`oidc_issuer_not_https`). The app's
  five variables are `AW_OIDC_ISSUER_URL`, `AW_OIDC_CLIENT_ID`, `AW_OIDC_CLIENT_SECRET`,
  `AW_APP_CLIENT_ID` and `AW_APP_CLIENT_SECRET`. ADR-0083 is unchanged: `awu_live_` is still
  refused on run routes. This records the decision; the issuer lands with G1.
