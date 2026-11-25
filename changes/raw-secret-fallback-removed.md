---
changelog: platform
section: Security
---

- Sign-in sessions, workspace-selection and invitation cookies, OIDC sign-in transactions and
  `aw login` device codes are now verified only with their own purpose key derived from
  `SESSION_SECRET`. 0.6.13 still accepted a token signed with the raw secret for one release, so an
  upgrade signed nobody out; that fallback is removed. A deployment upgrading straight from 0.6.12
  or earlier signs its users out once, and a sign-in, invitation or `aw login` in flight during that
  upgrade must be started again.
