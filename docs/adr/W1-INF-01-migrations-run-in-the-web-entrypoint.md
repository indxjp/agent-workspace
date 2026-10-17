# W1-INF-01 — Migrations and the seed run in `web`'s entry point, not in a sixth service

Status: accepted
Date: 2026-09-03
Decided by: W1-INF-01 (Infra)
Scope: `Dockerfile` (`web` target `CMD`), `compose.yaml`

## Context

Spec §46's completion criterion is three commands, one of which is `docker compose up -d`, followed
immediately by using the application. Nothing between them runs a migration. But the schema has to
exist before the first request, and W1-DB-01's seed has to have created the workspace, the
bootstrap owner and §19.5 rule 3's built-in **General** agent.

§33 says five services are enough and warns against splitting things. A `migrate` service would be
a sixth.

## Decision

**`web`'s command is `migrate && seed && next start`, `&&`-chained.**

Both steps are idempotent by construction, and that is a property of the code rather than a hope:
`packages/core/src/db/migrate.ts` takes a Postgres advisory lock, keeps a ledger, and refuses on
drift; `seed.ts` runs one transaction of `onConflictDoNothing` and returns the ids it found whether
it created them or not. A restart re-runs both harmlessly. The chain is `&&` so that a failure at
either step stops the container rather than starting a web server in front of a schema that is not
there — a check that cannot run must fail (ADR-0015), and "the migration failed but the site is up"
is that failure with a green tick beside it.

`web` waits on `postgres` with `condition: service_healthy`, so the first step does not race the
database's own initialisation.

## Alternatives rejected

* **A sixth `migrate` service with `depends_on: {web: service_started}` inverted.** Correct in
  Kubernetes, where it is a `Job`. In compose it is a service that exits immediately and shows as
  `Exited (0)` forever in `docker compose ps`, and it is the sixth service §33 exists to prevent.
* **`docker compose run --rm web pnpm db:migrate`, documented as a step.** Adds a command between
  §46's `docker compose up -d` and using the application, which is exactly what the criterion says
  is not there. It also does not survive a `docker compose up` on a machine that has been
  rebuilt from a newer image with a newer migration.
* **Migrate lazily on first request.** Puts a schema change on the request path, behind whatever
  concurrency the first burst of traffic has, and makes the failure mode a 500 rather than a
  container that will not start.
* **Bake the schema into the image.** Not reproducible against an external `DATABASE_URL`, which is
  the configuration §31 and §37 both expect an operator to use.

## Honest downside

**This is correct for exactly one `web` replica.** §32 Cluster Mode runs several, and several
replicas each running `migrate` on start is a thundering herd against one advisory lock: they will
serialise rather than corrupt anything — that is what the lock is for — but every replica after the
first waits for the first to finish before it starts serving, and a slow migration becomes a slow
rollout. The Helm chart of A.5 must run migrations as a `Job` and drop this from the container
command. That is W6's problem and it is written here so it is not a surprise.

**The seed runs on every start.** It is a transaction and a handful of `onConflictDoNothing`
statements, so the cost is negligible and the effect after the first run is nil — but it does mean
an operator who deletes the bootstrap admin row gets it back at the next restart. That is arguably
the right behaviour for a bootstrap identity and it is certainly a surprise; §21's real accounts
(W2-CP-06) are where it stops mattering.

**`BOOTSTRAP_ADMIN` is now load-bearing at start-up.** An invalid email address in `.env` stops the
container rather than producing a warning, and the operator reads the reason in
`docker compose logs web`.
