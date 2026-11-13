---
changelog: embedded
section: Added
---

- The local runtime's `ready` message names its database (`databaseUrl`) when the workspace runs on
  a loopback PostgreSQL, the embedded one by default, so `aw dev` can migrate and run a generated
  app on it. A remote `DATABASE_URL` is never named.
