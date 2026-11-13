---
changelog: platform
section: Added
---

- An app backend acting as the signed-in person (ADR-0161) may decide the approval a run waits on:
  `POST /api/runs/:id/approval` is now in the `app-backend` grammar, admitted for an `awo_live_`
  token, and refused `403 token_out_of_scope` for a run of an agent the endpoint client does not
  bind. The decision still clears the person's own run and approval checks.
