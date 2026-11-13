---
changelog: app
section: Added
---

- `aw-app migrate --app <name> --dir <migrations-folder>` applies the app's migrations to its schema
  `app_<name>` with `migrateApp`, reading the connection string from `DATABASE_URL` only (never
  the command line). A refused app name, a missing `DATABASE_URL` or a failed migration goes to
  stderr with exit code 1, a misused command line with 2. `aw dev` runs it before it starts the
  app.
- `migrateApp` runs `CREATE SCHEMA` only when the app's schema is missing, so the schema's owner
  needs no `CREATE` privilege on the database. It applies the journal itself, in Drizzle's ledger
  layout, instead of calling Drizzle's `migrate()`, which always runs `CREATE SCHEMA IF NOT EXISTS`.
