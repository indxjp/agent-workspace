---
changelog: cli
section: Fixed
---

- Resolving an image digest (`aw create`, `aw deploy`, `agent-workspace render`) now tries again
  when the registry or the network fails for a moment (no route to host, a timeout, a reset
  connection, a TLS handshake, a DNS miss, a 5xx or 429, or docker failing without a message):
  up to 4 tries, waiting 2, 4 and 8 seconds. A 401, 403 or "not found" is still refused at once
  with the same message; when every try fails, the message is unchanged apart from
  "(after 4 attempts)".
