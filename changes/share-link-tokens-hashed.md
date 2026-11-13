---
changelog: platform
section: Security
---

- Public share links are looked up by the SHA-256 of their token, stored in a new `shares.token_hash`
  column, the way API keys and other bearer tokens already are. PostgreSQL fills the column for
  every existing link, so links made before the upgrade keep working. The plain token is still
  stored for now, because the share list shows each public link again; a follow-up removes it once
  a link is shown only when it is created.
