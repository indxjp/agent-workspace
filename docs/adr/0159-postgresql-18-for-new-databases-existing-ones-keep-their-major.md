# ADR-0159 — PostgreSQL 18 for new databases; an existing one keeps its major until its data moves

Status: accepted
Date: 2026-10-25
Decided by: Owner decision (2026-10-25, "move everything to 18 in this PR"), with the data-safety
boundaries below
Scope: `packages/embedded/{package.json,src/postmaster.ts,src/embedded-db.ts}`, `package.json`,
`compose.yaml`, `packages/cli/{src/deployment.ts,src/create/args.ts,src/create/deployment-v1.ts,templates/compose.yaml}`,
`.github/workflows/{ci,live-e2e}.yml`, `scripts/check-workflows.mjs`, `scripts/test-services/**`,
`infra/tests/isolation/{kind-deploy,chart-smoke}.mjs`
Related: W1-INF-02 (CI runs against a real database), BH061-006 (initdb is never run on an
initialised cluster), ADR-0109 (the local runtime), ADR-0090 (`render`)

## Context

Every database this repository starts was PostgreSQL 17: the local runtime's `embedded-postgres`
17.10, the `postgres:17-alpine` CI service and test launcher, the repository's `compose.yaml`, and
the image a generated Compose deployment pins. `embedded-postgres` 18.4 shipped on the same day as
17.10, so staying on 17 was not a security gap; the move is the platform upgrade itself.

A PostgreSQL major cannot open a data directory another major initialised. Three kinds of data
directory already exist outside this repository: a developer's `aw dev` directory
(`.agent-workspace/postgres`), a developer's `postgres-data` volume under the repository's
Compose file, and an operator's deployment volume. None of them may be lost, and none may be
emptied by a tool that only meant to start a server. The `embedded-postgres` platform packages ship
`initdb`, `pg_ctl` and `postgres` only, with no `pg_dump` or `pg_upgrade`, so the local runtime
cannot carry a 17 directory forward itself.

The `postgres:18` image also moved its default data directory: `PGDATA` is
`/var/lib/postgresql/18/docker` and the declared volume is `/var/lib/postgresql`. A volume mounted
at the old `/var/lib/postgresql/data` would no longer be where the server writes.

## Decision

1. **Every database this repository creates is PostgreSQL 18:** `embedded-postgres` 18.4.0-beta.17,
   `postgres:18-alpine` for CI, `pnpm test`'s Docker path and the isolation harness, the repository's
   `compose.yaml` (pinned by index digest), and new generated Compose deployments. CI's step
   "PostgreSQL service is a real PostgreSQL 18" asserts the major it got, as W1-INF-02's step did for
   17. W1-DB-01's schema evidence, produced on 17.11, is re-run by the whole database suite on 18 in
   this change (`pnpm test` locally through the native `embedded-postgres` 18, and CI's service).
2. **An existing data directory is never migrated, emptied or reinitialised by a start.** The local
   runtime reads `PG_VERSION` when its postmaster exits before it is ready, and a major other than
   `EMBEDDED_POSTGRES_MAJOR` stops the start with `EmbeddedDatabaseError('data_directory_version')`.
   That error names no path, says nothing in the directory changed, and points at "Upgrade the local
   database" in the `aw dev` docs. A test holds `EMBEDDED_POSTGRES_MAJOR` to the major of the pinned
   `embedded-postgres`.
3. **A generated deployment keeps its major until its operator moves the data.** `render --upgrade`
   already never moves `POSTGRES_IMAGE` (a new major is a data migration, not an image swap), and
   that stays. The template sets `PGDATA: /var/lib/postgresql/data`, the directory both majors then
   use at the existing mount point, so re-rendering a 17 deployment changes nothing it runs. The
   deploy guide's runbook moves one with its own backup and restore.
4. **A PostgreSQL 17 answer is refused by name.** The generator's database answer only validates;
   the version comes from the image pin, so accepting "PostgreSQL 17" would deploy 18 to an operator
   who asked for 17. As with the retired MinIO answer, the refusal says what a new deployment runs.
5. **The cloud modules keep their own versions.** `infra/terraform/gcp-small` takes a digest-pinned
   `POSTGRES_IMAGE` from its caller, and `infra/terraform/azure-container-apps` runs a managed
   PostgreSQL 16 server. Changing either default would start a major upgrade of a running
   production database on the next `terraform apply`, so they are left to an operator's planned
   upgrade.

## Consequences

- A developer whose `aw dev` directory, or repository `postgres-data` volume, was created by 17
  starts empty or exports first; both are documented (`docs/sdk/site/cli/dev.mdx`,
  `CONTRIBUTING.md`) with the commands.
- `PGDATA` in the template is required while any deployment may still run 17 from the same file.
- Measurements quoted on PostgreSQL 17.11 in earlier ADRs and code comments stay as the evidence
  they were; they are not rewritten to 18.
