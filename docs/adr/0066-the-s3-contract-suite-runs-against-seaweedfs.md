# ADR-0066 — The S3 contract suite runs against SeaweedFS, not MinIO

Status: accepted
Date: 2026-09-27
Decided by: the Owner (replace MinIO in tests rather than redistribute it)
Scope: `scripts/test-with-services.mjs`, `.github/workflows/ci.yml` (the heavy-checks S3 step),
`scripts/check-workflows.mjs`, `packages/core/src/storage/s3-store.test.ts` and the suite's
documentation comment in `contract.ts`; since the 2026-10-01 amendment also
`scripts/test-services/` and `tests/test-services.test.ts`. Not `compose.yaml`, not the CLI's
generated deployment.

## Context

The S3 object-store contract suite (`packages/core/src/storage/s3-store.test.ts`) needs a real
S3-compatible server. `pnpm test` (`scripts/test-with-services.mjs`) and the CI heavy-checks job
both started one from
`quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`.

Since 2026-09-26 MinIO's public images can no longer be pulled anonymously: quay.io and Docker Hub
both answer `401`/`denied`. Every `pnpm test` and every CI heavy-checks run failed before a test
started, and the suite cannot be skipped instead — the no-skip gate fails a run that skipped it.

Two ways out were available: mirror the last pullable MinIO image into a registry we control, or
test against a different S3-compatible server. Mirroring would make the project a redistributor of
AGPL-3.0 software, which is exactly what
[W1-INF-01](W1-INF-01-minio-is-referenced-not-redistributed.md) establishes we do not do. The Owner
decided to replace MinIO in tests.

The suite uses only basic S3: `PutObject`, `GetObject`, `HeadObject`, `DeleteObject(s)`,
`ListObjectsV2`, `CopyObject`, `CreateBucket` and `HeadBucket`, path-style addressing
(`forcePathStyle: true`), SigV4 with one static key pair.

## Decision

**Tests and CI run the S3 contract suite against SeaweedFS** (`chrislusf/seaweedfs`, Apache-2.0),
release `4.47`, pinned by its multi-arch image index digest
`sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882`
(linux/amd64, arm64, 386, arm/v7). The tag is recorded in a comment beside each pin; the digest is
what is pulled.

* **One container.** `weed mini` runs master, volume server, filer and the S3 gateway in one
  process; only the S3 port `8333` is published. The launcher maps it to a random loopback port
  (`127.0.0.1::8333`); CI maps it to the fixed `127.0.0.1:9000`, so `TEST_S3_ENDPOINT` there is
  unchanged.
* **Credentials.** `AWS_ACCESS_KEY_ID=agent_workspace` and `AWS_SECRET_ACCESS_KEY=agent_workspace`
  in the container environment make SeaweedFS create its only S3 identity (an admin) from them. No
  config file is mounted. Verified by hand against 4.47: an anonymous `ListBuckets` and an anonymous
  `CreateBucket` answer `403 AccessDenied`, a request signed with the wrong secret answers `403
  SignatureDoesNotMatch`, and the correct pair lists buckets.
* **Readiness.** `GET /healthz` on the S3 port. Measured locally from a cold start, the first
  `CreateBucket`/`PutObject`/`GetObject` issued the moment `/healthz` first answered `200` succeeded
  in three of three runs, so the probe does not open a window in which the suite can race startup.
* **Names are neutral.** The launcher's function is `provideObjectStore`, its container
  `aw-test-s3-<suffix>`; the CI step is "Start the S3 test server for the object-store contract
  suite" (the workflow gate in `scripts/check-workflows.mjs` requires that name) and its container
  `aw-ci-s3`. The `TEST_S3_*` variable names are unchanged, so an operator who points the suite at
  their own endpoint changes nothing.

The product is out of scope. `compose.yaml`, `packages/cli/templates/compose.yaml`,
`packages/cli/src/deployment.ts` and the deployment docs still reference MinIO's image; whether the
generated deployment keeps MinIO is a separate decision, tracked separately.

## Alternatives considered

* **Mirror the last MinIO image into our own registry.** Rejected by the Owner: it is
  redistribution of AGPL-3.0 software, which W1-INF-01 deliberately avoided.
* **RustFS (`rustfs/rustfs`, Apache-2.0).** A viable second choice with the same shape. Not needed:
  SeaweedFS passed every test of the suite unchanged, and it has the longer release history.
* **Garage or Ceph RGW.** Garage needs a layout and key bootstrap step after start, so it is not
  one `docker run`; Ceph RGW is far heavier than a test fixture needs. Neither buys anything over
  SeaweedFS for eight basic operations.
* **Skip the S3 suite when no server is available.** Rejected: it would weaken the no-skip gate and
  leave the S3 backend without a deterministic proof.

## Consequences

* `pnpm test` and the CI heavy-checks job start again; the S3 contract suite runs for real (60
  tests locally against 4.47).
* The suite now proves the S3 backend against SeaweedFS's S3 dialect, not MinIO's. The Compose
  deployment still ships MinIO, so a MinIO-specific behaviour is no longer caught by CI. ADR-0056's
  live AWS proof remains the check against real S3.
* Upgrading SeaweedFS means changing the digest in both the launcher and the CI step together, as
  their comments say.

## Amendment — native test services for the Docker-less `dgx` pool (issue #429, 2026-10-01)

The Owner moved every indx-dev stage back to the self-hosted `dgx` pool, which is ARM64, runs as
an unprivileged user and has no Docker socket by design. `pnpm test` started both of its services
with `docker run`, so it could not run there. The launcher now picks, per service:

1. `TEST_DATABASE_URL` / `TEST_S3_ENDPOINT`, when set — unchanged; CI sets both and never runs the
   launcher;
2. Docker, when `docker info` succeeds — unchanged: the same image, digest, credentials and probe;
3. otherwise a native fallback. `AW_TEST_SERVICES=docker|native` forces 2 or 3; an unknown value, or
   a forced `docker` without a daemon, fails with a typed error instead of falling back.

**Native PostgreSQL** is the `embedded-postgres` pin `packages/embedded` already declares (17.10),
in a fresh directory under `os.tmpdir()` on a free loopback port, with `postgres` as superuser. It
runs in a helper process (`scripts/test-services/postgres-native-child.mjs`) that leads its own
process group, because importing the library installs an exit hook that would replace the Vitest
exit status. The client-close check after a green run is the same `pg_stat_activity` query, sent
through `pg`. The root `package.json` declares `embedded-postgres` and `pg` at exactly the versions
`packages/embedded` and `packages/core` pin, so the helpers import them by name and the lockfile
keeps one copy of each; `tests/test-services.test.ts` fails if the two pins drift apart.

**Native SeaweedFS** is the release binary of the same version, `4.47`, one archive per host
(`linux-arm64`, `linux-x64`, `darwin-arm64`, `darwin-x64`), each pinned by SHA-256 in
`scripts/test-services/pins.mjs` beside the image digest. The SHA-256 values are the digests GitHub
records for the release assets; `linux_amd64.tar.gz` was also downloaded, hashed and checked
against the release's published `.md5`. The archive is downloaded once into
`${XDG_CACHE_HOME:-~/.cache}/agent-workspace/seaweedfs/4.47/`, hashed while it streams, and moved
into place only when it matches. On every use the cached archive is copied into the run's own
directory and verified again before `weed` is extracted. A mismatch, of a download or of the cache,
**fails closed** with `seaweedfs_checksum_mismatch` and names both digests; nothing is extracted,
and nothing is downloaded again behind the user's back. `weed mini` runs on free loopback ports
(each with its `+10000` gRPC port), with the same `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
identity, the same `/healthz` probe, and telemetry off.

**Cleanup.** Every container, process and directory is registered with a run-once, last-in
first-out cleanup before it is created, and the cleanup runs on success, on failure and on SIGINT,
SIGTERM and SIGHUP. Directories carry an `aw-test-pg-` or `aw-test-s3-` prefix, and concurrent runs
on one host share no port, directory or binary. A launcher killed with SIGKILL cannot clean up: the
PostgreSQL helper still stops its cluster when its stdin closes, but `weed` and the directories can
remain.

**Upgrade rule.** A SeaweedFS upgrade changes `SEAWEEDFS_VERSION`, the image digest, every binary
SHA-256 and the CI step together. `tests/test-services.test.ts` fails while the launcher's digest
and `ci.yml`'s differ.

**Coverage on `dgx`.** Every suite gated on `TEST_DATABASE_URL` or `TEST_S3_ENDPOINT` runs. The
three suites that drive a real Docker daemon skip there by design, as on any host without one, and
`ci.yml` still runs them: `packages/runtime/src/docker.test.ts`,
`packages/runtime/src/registry.test.ts` and `apps/web/app/api/runtimes/[id]/runtimes-route.test.ts`.
