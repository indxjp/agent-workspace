---
changelog: app
section: Added
---

- The portal template signs a person in (issue #1510): `/sign-in`, `GET /api/sign-in`,
  `GET /api/sign-in/callback` and `POST /api/sign-out`, each route one line over the app kit's new
  `signInRoutes()` (`@indx-workspace/app/server`). It runs an OpenID Connect code flow at
  `AW_OIDC_ISSUER_URL` with S256 PKCE, a `state` and a `nonce` in a signed 10-minute cookie, then
  `aw.auth.exchange` with the app's `app-backend` client (ADR-0161), and keeps the `awo_live_`
  token in the `aw_user_token` cookie `currentPerson` reads. Refusals keep the platform's codes
  (`subject_not_member`, …); a missing variable is `503 sign_in_not_configured`. The sign-in
  notice links to `/sign-in?next=`, the navigation has Sign in and Sign out, and every string is
  in English and Japanese. Under `aw dev` it signs in at the development issuer with nothing to
  set. File reads stay outside the routes ADR-0161 admits for that token, so the Dashboard's file
  count and `/files` keep their localized notice after sign-in.
