---
changelog: platform
section: Added
---

- `aw dev` runs a development OIDC issuer on `127.0.0.1` when no `OIDC_*` variable is set (issue
  #2075, ADR-0161's 2026-11-01 amendment), so the local console and a generated app sign a person
  in with a member's email and the local console password. The app gets `AW_OIDC_ISSUER_URL`,
  `AW_OIDC_CLIENT_ID`, `AW_OIDC_CLIENT_SECRET`, `AW_APP_CLIENT_ID` and `AW_APP_CLIENT_SECRET`, and
  `aw dev` makes its `app-backend` endpoint client for the project's agents, so the app's
  `aw.auth.exchange` starts runs as the signed-in person. One to three `OIDC_*` set is refused
  (`oidc_configuration_incomplete`). The local runtime takes `environment.devIssuer`, refuses a
  hand-set `OIDC_*` beside it (`dev_issuer_oidc_set`) and links the bootstrap Owner's identity at
  the issuer. The production posture refuses a non-`https:` `OIDC_ISSUER_URL` at boot
  (`oidc_issuer_not_https`). The local runtime's key may create an `app-backend` endpoint client
  and rotate its secret in the local posture only. The console's sign-in uses
  `client_secret_basic` with an issuer that serves only that. `awu_live_` is still refused on
  every run route.
