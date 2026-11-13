---
changelog: platform
section: Security
---

- A public share link is shown once, when it is published, and only the SHA-256 of its token is
  stored. Migration `0105` clears every stored plain token; existing links keep working because
  they are already looked up by hash. The publish dialog now says the link won't be shown again.
  The plain `token` column stays, nullable, for one release so a web process from the previous
  release can still publish during a rolling update; the next release drops it.
