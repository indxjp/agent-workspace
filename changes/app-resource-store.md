---
changelog: app
section: Added
---

- `Person` and `allows`: who an operation runs for, in person or through an agent, and the one
  access check (`'member'`, `'role:<x>'` meaning that role or higher, a `person()` field, or any
  of a list).
- `@indx-workspace/app/db`: `storeOf(resource, { db, appName })`, the resource store every page,
  route and agent tool goes through. Each operation is scoped to the person's workspace,
  cursor-paged (50 by default, at most 200), validated and access-checked; an agent writes only
  the fields `agents.write` lists and never more than the person may. Audited resources write one
  `app_audit_events` row per write in the same transaction, naming fields and the agent's run but
  never values. Refusals are `AppStoreError`s with a fixed message per code.
- `tablesOf` and `appAuditTable`, the Drizzle tables in the app's schema `app_<name>`;
  `createTableSql` and `createAuditTableSql`, the same tables as deterministic SQL;
  `migrateApp`, which applies an app's migrations to its schema under an advisory lock and checks
  the ledger; `appSchemaName`.
- `@indx-workspace/app/testing`: `memoryStoreOf`, the in-memory twin of `storeOf` with the same
  behaviour, a call counter and the audit rows written, and `fakePerson`.
- The package now has `drizzle-orm` (0.45.4) and `pg` (^8) as peer dependencies, for
  `@indx-workspace/app/db`.
