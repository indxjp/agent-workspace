---
changelog: platform
section: Changed
---

- A session-state blob save now takes the same steps as a file save: a pending row first, the
  `PUT` body streamed to object storage (it is no longer held in memory, up to the 32 MiB cap),
  then a confirm against the row's reservation token. Retention marks a blob row deleting before it
  deletes the bytes, and the cleanup job finishes deleting rows and abandoned reservations.
