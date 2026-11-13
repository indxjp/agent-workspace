---
changelog: platform
section: Security
---

- `SESSION_SECRET` no longer signs six things directly. The session, workspace-selection and
  invitation cookies, the OIDC sign-in transaction, CLI device codes and the public-share visitor
  key each use their own key, derived from the secret with HKDF, so a token signed for one can never
  be accepted as another. Nobody is signed out by the upgrade: tokens signed the old way are still
  accepted until they expire (at most 12 hours). Refactoring part 06 step 5.
