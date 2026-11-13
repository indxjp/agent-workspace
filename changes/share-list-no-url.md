---
changelog: contracts
section: Changed
---

- `ShareListItemSchema` no longer has `url`, and refuses an item that carries one: a public link
  is in the `201` of `POST /api/shares` only (`ShareResourceSchema.url`), because the server keeps
  only the token's hash.
