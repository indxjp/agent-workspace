# ADR-0069 — The engine-identity migrations require a single-revision cutover

Status: accepted
Date: 2026-09-27
Decided by: the Owner ("cutover + ADR", recorded on issue #317; agent-engines programme, tracker
#299, unit ENG-02a)
Scope: `migrations/0024_*`, `migrations/0025_*`; `docs/deploy/azure-container-apps.md`,
`docs/deploy/kubernetes.md`, `docs/deploy/single-vm.md`,
`docs/sdk/site/concepts/data-plane.mdx` (Google Cloud Run)

## Context

ENG-02a (#317) gives the engine that runs an agent loop its own identity, as ADR-0065 requires. Two
of its migrations change shapes the previous release reads and writes:

- `0024` renames `sessions.claude_session_id` to `sessions.engine_session_id`. Any process from the
  previous release that reads or writes a session names the old column, so it fails against a
  migrated database.
- `0025` rewrites the discriminant of the `agents.policy` JSON document from `provider` to
  `engine`. The previous release parses that document with a schema that requires `provider`, so it
  can no longer read an agent the new release has migrated.

Neither migration is compatible with the previous release. That would be a staging detail if
migrations ran in a separate, operator-sequenced step, but they do not:
[W1-INF-01](W1-INF-01-migrations-run-in-the-web-entrypoint.md) runs `migrate` in `web`'s entry
point, so the first new revision to start migrates the database under every old revision that is
still serving. On Cloud Run, Azure Container Apps and Kubernetes a rolling update does exactly that
by default.

## Decision

**This release is a single-revision cutover.** Before the new revision starts, the operator drains
the old revision or scales it to zero; the new revision then migrates and serves alone. Old and new
revisions never serve against the same database. Each deployment guide carries the step:

- Azure Container Apps and Google Cloud Run: route all traffic away from, and deactivate or scale to
  zero, the previous revision of `web`, `gateway` and the runner manager before the new revision is
  created.
- Kubernetes: scale the previous release's `web`, `gateway` and runner-manager Deployments to zero
  before `helm upgrade`.
- Single VM: `docker compose down` (without `-v`) before `docker compose up -d` with the new images.

In-flight runs on the old revision are lost at cutover, as they are on any stop; an operator who
cares waits for the run list to drain before scaling down.

### Rejected — expand/contract

An expand/contract sequence (add `engine_session_id` beside `claude_session_id`, dual-write both
and both policy keys for one release, drop the old names in the next) would make the upgrade
rolling. It was rejected: the product is pre-1.0, the only installations are the Owner's own, and
carrying a dual-write release would leave the old `claude_*` name and the `provider` key in the
code for a full release after ADR-0065 retired them. The rename stays clean.

### Future breaking migrations

A later migration that the previous release cannot run against is allowed only with the same
record: an ADR that names the incompatible statements, states the cutover (or the expand/contract
plan chosen instead), and adds the step to each deployment guide. A migration without such a record
is required to be compatible with the previous release.

## Consequences

- The upgrade to this release has downtime: from scaling the old revision down until the new one
  has migrated and passed its health check.
- Rollback is a restore, not a redeploy: the previous release cannot read a migrated database, so
  going back means restoring the pre-upgrade database backup together with the previous images.
  Take the backup before the cutover.
- The two CHECK constraints `0024` adds on existing tables (`runs_engine_valid`,
  `sessions_engine_valid`) are created `NOT VALID` and validated in `0025`. That does not weaken
  the lock or shorten the cutover: drizzle's `migrate()` applies all pending migrations in one
  transaction, so `0024`'s ACCESS EXCLUSIVE lock is still held while `0025` validates. The split
  buys re-runnability (validating an already-validated constraint is a no-op) and control over
  where the scan happens (after `0025`'s backfill); it does not make the release compatible.

## Related decisions

- [ADR-0065](0065-an-agents-engine-is-an-extension-point-behind-one-port.md) — why the column and
  the policy key are renamed at all.
- [W1-INF-01](W1-INF-01-migrations-run-in-the-web-entrypoint.md) — why a new revision migrates the
  database the moment it starts.
- [ADR-0068](0068-openai-wire-protocols-are-passthrough-ingress.md) — the previous migration that
  stayed compatible through a column default; the contrast this record draws.
- [ADR-0003](0003-adr-naming-preserves-file-ownership.md) — why this record is `0069-<slug>.md`.
- Issue [#317](https://github.com/indxjp/agent-workspace/issues/317) — the unit and the
  Owner's decision; tracker [#299](https://github.com/indxjp/agent-workspace/issues/299).
