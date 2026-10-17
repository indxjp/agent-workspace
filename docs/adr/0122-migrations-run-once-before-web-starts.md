# ADR-0122 — Migrations run once, in a one-shot step that finishes before web starts

Status: accepted
Date: 2026-10-08
Decided by: the issue #795 plan (C2), reviewed in the pull request
Scope: `compose.yaml` (`migrate`), `infra/helm/agent-workspace/templates/migrate-job.yaml`, `migrations.*` in the chart values, `packages/core/src/db/migrate.ts`

## Context

[W1-INF-01](W1-INF-01-migrations-run-in-the-web-entrypoint.md) runs migrations and the seed in
`web`'s entry point and rejects a separate service, so the Compose file keeps five. That is safe
for one replica. It is not a statement an operator can rely on once more than one `web` starts at
once, as the Helm chart does with two replicas: every replica migrates, and a replica that is
already serving traffic to a new schema is the only signal that an upgrade failed.

`runMigrations` already takes a PostgreSQL advisory lock on a dedicated connection and checks that
the ledger holds as many rows as the journal has entries (R-15 §3). What was missing is proof that
two starters really serialise, and a place to run migrations that is not a serving container.

## Decision

- Compose runs a one-shot `migrate` service from the `web` image (`node
  /srv/packages/core/dist/db/migrate.js`, `restart: 'no'`). `web` depends on it with
  `service_completed_successfully`, so a failed migration stops `docker compose up` before `web`
  starts. The service sees `DATABASE_URL` only.
- The Helm chart runs the same command in a `pre-install,pre-upgrade` Job, which Helm waits for
  before it creates or replaces any pod. The Job reads only the database Secret and uses no
  ServiceAccount, because the chart's ServiceAccounts do not exist at `pre-install`.
  `migrations.enabled: false` turns it off for an operator who migrates out of band.
- `web`'s entry point keeps its `migrate` step. After the one-shot step it finds nothing pending and
  returns under the same lock, so it is a safety net rather than a second migrator. It still covers
  the deployments that have no one-shot step (below).
- A PostgreSQL-backed test starts two `runMigrations` against a database one revision behind. Exactly
  one applies the pending migrations and the other applies none; with a third client holding the
  lock, both queue on it and neither writes. Removing the lock makes both tests fail.

This partly supersedes W1-INF-01: the entry point still migrates, and "no sixth service" no longer
holds for the repository's `compose.yaml`.

## Alternatives

- **Leave migrations in the entry point only.** Correct under the lock, but a failed migration
  surfaces as a crash-looping `web` rather than a failed upgrade step, and with Helm a rolling
  update starts new pods against the old schema while the migration is still running.
- **`depends_on: {web: service_started}` inverted.** Rejected by W1-INF-01 for good reason: web would
  serve before its schema exists.
- **Remove the entry-point migrate.** Not yet: the project `aw` generates and the Cloud Run module
  have no one-shot step and rely on it.

## Consequences

Follow-ups, deliberately not in this change: a Cloud Run Job for migrations, a `migrate` service in
the generated Compose template, a Dockerfile entry point that skips `migrate` when a one-shot step
ran, and `gateway` waiting on `migrate`. Migrations only go forward, so a rollback across a migration
needs a database restore; the runbook in [Deploy a project](../sdk/site/guides/deploy.mdx) states
the backup and restore steps.
