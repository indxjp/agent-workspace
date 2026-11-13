---
changelog: contracts
section: Added
---

- `LocalRuntimeReadyMessageSchema` takes an optional `databaseUrl`: the local runtime's own
  PostgreSQL, a `postgres://` or `postgresql://` URL on `127.0.0.1`, `localhost` or `[::1]` only
  (`LocalRuntimeDatabaseUrlSchema`), for `aw dev` to migrate and run a generated app on. A
  `ready` without it parses as before.
