---
changelog: platform
section: Security
---

- A draft that names `aw-control` in any case or with surrounding space is refused as the reserved
  connector, and a write that was already journaled is no longer replayed once the workspace has
  switched the Builder off.
- The Builder's run-token door logs the error class, never its message, when it fails closed.
