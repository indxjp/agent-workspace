---
changelog: platform
section: Added
---

- The console has a **Sign out** button under the signed-in person in the sidebar. It expires the
  session cookie (and the workspace-selection and invitation cookies) and goes back to the sign-in
  screen. Before, nothing ended a session: a shared computer stayed signed in until the cookie
  expired, up to 12 hours. Sessions stay stateless, so a copied cookie is still valid until it
  expires.
