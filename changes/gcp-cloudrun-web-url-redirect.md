---
changelog: platform
section: Fixed
---

- On Google Cloud Run without a custom domain, `aw deploy` now reports the web app at the URL the
  app itself uses for sign-in, `https://<name>-web-<project number>.<region>.run.app`. Before, the
  `web:` line and the `web_url` output showed the service's other address (`…a.run.app`), so an
  operator who registered `<web>/api/auth/callback` with their OIDC provider got
  `redirect_uri_mismatch` at sign-in. When single sign-on is configured, `aw deploy` now also
  prints the exact redirect URI to register.
