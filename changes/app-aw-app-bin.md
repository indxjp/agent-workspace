---
changelog: app
section: Added
---

- The `aw-app` bin: `aw-app sql --app <name> <resource-spec-json>` prints the migration SQL
  (`createTableSql`) of one resource that `aw generate resource` parsed, built with the same field
  builders the generated resource file uses. A refused spec or app name goes to stderr with exit
  code 1, a misused command line with 2. `aw` spawns it from the project's own install and never
  imports the app kit.
- The audit table refuses an agent row without a run id (`app_audit_events_agent_run_check`), so
  every agent write carries the run it was made in at the database too. The app template's first
  migration now matches `createAuditTableSql` exactly, which a parity test holds.
