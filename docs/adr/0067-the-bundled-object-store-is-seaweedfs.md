# ADR-0067 — The bundled object store is SeaweedFS, not MinIO

Status: accepted
Date: 2026-09-27
Decided by: the Owner (replace MinIO fully, 2026-09-27)
Scope: `compose.yaml`, `.env.example`, `packages/cli/templates/compose.yaml`, the CLI's generated
`.env` (`packages/cli/src/render/env.ts`) and its image, validation and answer handling
(`deployment.ts`, `validate.ts`, `create.ts`, `profile-defaults.ts`), `docs/deploy/single-vm.md`.
Supersedes [W1-INF-01](W1-INF-01-minio-is-referenced-not-redistributed.md) for the product.

## Context

[ADR-0066](0066-the-s3-contract-suite-runs-against-seaweedfs.md) moved the S3 contract suite to
SeaweedFS because MinIO's public images stopped being pullable anonymously on 2026-09-26. It left
the product alone: the repository's `compose.yaml` and the CLI-generated Compose project still ran
a `minio` service. That service can no longer be pulled by a new self-hoster, so a fresh
`docker compose up` fails before anything starts.

[W1-INF-01](W1-INF-01-minio-is-referenced-not-redistributed.md) established that we *reference*
MinIO and never redistribute it. Mirroring the last pullable image into a registry we control
would break that, so the only way to keep the product installable is a different S3-compatible
server. The Owner decided to replace MinIO fully.

The platform needs only basic S3 from the bundled store: SigV4 with one static key pair,
path-style addressing, `CreateBucket`/`HeadBucket` (the web composition root creates its bucket on
first boot with `ensureS3Bucket`), and object put/get/head/delete/list/copy. The S3 contract suite
already proves the S3 backend against SeaweedFS 4.47 for exactly those operations.

## Decision

**The bundled object store is SeaweedFS** (`chrislusf/seaweedfs`, Apache-2.0) release `4.47`,
pinned by the same multi-arch image index digest as the test suite:
`sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882`. The Compose service is
`seaweedfs`; the app's S3 endpoint becomes `http://seaweedfs:8333`.

### `weed server -s3`, not `weed mini`

SeaweedFS documents `weed mini` as *"a complete SeaweedFS setup with all components optimized for
small/dev use cases"* (`weed help mini`, 4.47): it also starts a WebDAV gateway and an Admin UI
whose authentication is disabled unless `-admin.password` is set, and tunes shutdown and volume
sizing for development. That is the right shape for a test fixture (ADR-0066) and the wrong one
for a deployment that holds a customer's files.

`weed server` is the documented single-node form: *"start both a volume server … and a master
server … Optionally, a filer server can be started. Also optionally, a S3 gateway can be
started"*, acting *"exactly the same as starting them separately"*. With `-s3` it runs master,
volume, filer and S3 gateway in one process and nothing else. The image's entry point adds
`-dir=/data -volume.max=0 -master.volumeSizeLimitMB=1024`, so volumes, the filer's LevelDB
metadata and the master's state all live under `/data`, which is one named volume
(`seaweedfs-data`). Verified: objects written before `docker compose up --force-recreate` are
listed and read back after it.

The flags, the same in both Compose files:

| Flag | Why |
| --- | --- |
| `-ip=127.0.0.1 -ip.bind=127.0.0.1` | Master (9333), volume (8080) and filer (8888) answer unauthenticated HTTP and gRPC. They stay on the container's loopback; from the network they refuse connections. |
| `-s3 -s3.ip.bind=0.0.0.0` | Only the S3 gateway (8333, and its gRPC port 18333) listens on the network. |
| `-s3.port.iceberg=0 -s3.port.lance=0` | The Iceberg REST catalog and Lance namespace servers are on by default; nothing here uses them. |
| `-master.telemetry=false` | The master otherwise reports anonymous cluster statistics to `telemetry.seaweedfs.com`. A self-hosted store does not report home by default. |

### Credentials

`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the container environment make SeaweedFS create
its only S3 identity, an admin (it logs `Added admin identity from AWS environment variables`).
Nothing is mounted and nothing is hard-coded in either Compose file:

* **Repository `compose.yaml`:** `seaweedfs` reads `OBJECT_STORAGE_ACCESS_KEY_ID` and
  `OBJECT_STORAGE_SECRET_ACCESS_KEY` from `.env` — the same two variables `web` already signed
  with — so the two ends cannot disagree. Both services now demand them with `${…:?}`; the
  previous `:-agent_workspace` fallbacks are gone, so a `.env` without them is refused before
  anything starts. `.env.example` keeps its example values and says to replace the secret.
* **CLI template:** `seaweedfs` reads `SEAWEEDFS_ACCESS_KEY_ID` and `SEAWEEDFS_SECRET_ACCESS_KEY`,
  rendered with the generated secret that also fills `OBJECT_STORAGE_SECRET_ACCESS_KEY`. They are
  separate variables because the template's store is profile-gated (`object-storage`) and Compose
  interpolates the whole file before it applies profiles: a project that chose the local
  filesystem renders `OBJECT_STORAGE_*` empty, and the `seaweedfs` service's `${…:?}` demands must
  still hold. This is the same shape the MinIO service had with `MINIO_ROOT_*`.

With an identity configured SeaweedFS refuses an unsigned request. Verified against the
`compose.yaml` service: anonymous `ListBuckets`, `GetObject`, `PutObject` and `CreateBucket` all
answer `403`; a wrong secret answers `SignatureDoesNotMatch`; the filer and master ports refuse
connections from the network.

### Health, bucket, hardening

* **Healthcheck:** `wget -q -O /dev/null http://127.0.0.1:8333/healthz` (the image carries BusyBox
  `wget`). ADR-0066 measured that the first S3 request issued the moment `/healthz` answers `200`
  succeeds; `web` waits on `service_healthy`.
* **Bucket:** unchanged. No `mc` init container ever existed — `web`'s composition root creates
  the configured bucket idempotently on first boot. SeaweedFS also auto-creates a bucket on first
  upload for an admin identity, but nothing relies on that.
* **Generated project hardening:** the template runs the service as the image's `seaweed` user
  (`user: '1000:1000'`, which owns `/data` in the image and therefore in a fresh named volume) with
  `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges` and a `/tmp` tmpfs. Running as that
  user directly skips the entry point's root-only `chown` and `su-exec`, which `cap_drop: [ALL]`
  would refuse. Verified healthy, with signed put/get/list and anonymous `403`, from a project the
  generator wrote.

### What is renamed, and what stays compatible

The app's S3 contract is unchanged: `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`,
`OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`,
`OBJECT_STORAGE_FORCE_PATH_STYLE` and the `AWS_*` names `web` reads. Only the endpoint's default
value changes (`http://minio:9000` → `http://seaweedfs:8333`).

The MinIO names the product exposed are renamed, and each break is explicit rather than silent:

| Before | After | Compatibility |
| --- | --- | --- |
| Generated `.env` `MINIO_IMAGE` | `SEAWEEDFS_IMAGE` | `start` still digest-gates `MINIO_IMAGE` in a project generated earlier (it has its own MinIO-era `compose.yaml`). |
| Generated `.env` `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `SEAWEEDFS_ACCESS_KEY_ID` / `SEAWEEDFS_SECRET_ACCESS_KEY` | New projects only; existing projects keep their own files. |
| `AW_MINIO_IMAGE` (generator override) | `AW_SEAWEEDFS_IMAGE` | Refused by name for `--cloud local`, never silently ignored. |
| Interactive storage answer `MinIO` | `SeaweedFS` | Refused with a message naming `SeaweedFS`, never silently substituted. |
| `validate` skip for host `minio` | skip for host `seaweedfs` | The `minio` skip stays, so `validate` still passes on an earlier project. |
| Compose service / volume `minio` / `minio-data` | `seaweedfs` / `seaweedfs-data` | Data does not move by itself — see the upgrade note. |

## Upgrade note — existing self-hosters with data in a MinIO volume

After upgrading, the `seaweedfs` service starts on an empty `seaweedfs-data` volume. The old
`minio-data` volume is untouched and nothing deletes it. `web` creates an empty bucket in the new
store on its next boot, so copy the data **before** `web` serves requests again. The copy reuses
the MinIO image the host already has (it could not have run otherwise), and that image ships the
`mc` client, so nothing has to be pulled from MinIO's registries. The commands below assume the
repository's `compose.yaml` (project `agent-workspace`, network `agent-workspace_agent-workspace`,
bucket `agent-workspace`, MinIO's literal `agent_workspace` credentials).

```sh
# 0. Note the MinIO image the host has; the pre-upgrade compose.yaml pinned this tag.
docker image ls minio/minio
# 1. Stop web so nothing writes during the copy, then update the checkout and start the new store.
docker compose stop web
git pull
docker compose up -d --wait seaweedfs
# 2. Run the old MinIO once more, on the old volume and the same network.
docker run -d --name aw-minio-legacy --network agent-workspace_agent-workspace \
  -v agent-workspace_minio-data:/data \
  -e MINIO_ROOT_USER=agent_workspace -e MINIO_ROOT_PASSWORD=agent_workspace \
  minio/minio:RELEASE.2025-09-07T16-13-09Z server /data
# 3. Mirror the bucket with the mc bundled in that image, then compare. The new key pair is the
#    one in .env.
NEW_KEY=$(sed -n 's/^OBJECT_STORAGE_ACCESS_KEY_ID=//p' .env)
NEW_SECRET=$(sed -n 's/^OBJECT_STORAGE_SECRET_ACCESS_KEY=//p' .env)
docker exec -e NEW_KEY="$NEW_KEY" -e NEW_SECRET="$NEW_SECRET" aw-minio-legacy sh -c '
    until mc ready local >/dev/null 2>&1; do sleep 1; done
    mc alias set old http://127.0.0.1:9000 agent_workspace agent_workspace &&
    mc alias set new http://seaweedfs:8333 "$NEW_KEY" "$NEW_SECRET" &&
    mc mb --ignore-existing new/agent-workspace &&
    mc mirror --overwrite old/agent-workspace new/agent-workspace &&
    mc diff old/agent-workspace new/agent-workspace'
# 4. `mc diff` printing nothing means every object matches. Remove the helper and start web.
docker rm -f aw-minio-legacy
docker compose up -d
# 5. Only once the application shows the migrated files: docker volume rm agent-workspace_minio-data
```

Rehearsed end to end on 2026-09-27 against a seeded MinIO volume (three objects, one key with
spaces): mirror, empty `mc diff`, and every object read back through SeaweedFS after a container
recreate.

**A CLI-generated project** keeps its own copy of the MinIO-era `compose.yaml` and keeps working
while the MinIO image stays in the host's cache. To move it: replace its `minio` service and
`minio-data` volume with the `seaweedfs` service and `seaweedfs-data` volume from
`packages/cli/templates/compose.yaml`, rename `minio` to `seaweedfs` in `web`'s `depends_on`, and
in `.env` add `SEAWEEDFS_IMAGE` (the digest above), `SEAWEEDFS_ACCESS_KEY_ID` and
`SEAWEEDFS_SECRET_ACCESS_KEY` (the values of `OBJECT_STORAGE_ACCESS_KEY_ID` /
`OBJECT_STORAGE_SECRET_ACCESS_KEY`), and set `OBJECT_STORAGE_ENDPOINT=http://seaweedfs:8333`. Then
run the same steps with the network `agent-workspace_control` and MinIO's credentials from
`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`.

`rclone sync` between two S3 remotes is an equivalent copy for an operator who prefers it; the
steps are the same with `rclone` in place of `mc`.

## Alternatives considered

* **Keep MinIO and mirror its last image.** Rejected by the Owner, as in ADR-0066: it makes the
  project a redistributor of AGPL-3.0 software, which W1-INF-01 avoided.
* **`weed mini`.** What the tests run. Rejected for the product for the reasons above: it is
  documented for small/dev use and starts a WebDAV gateway and an Admin UI with auth off by
  default. Disabling each extra would still leave the product on the mode SeaweedFS does not
  recommend for data it has to keep.
* **Separate master, volume, filer and S3 containers.** SeaweedFS's production layout for a
  cluster. On one VM it is four services where spec §33 wants one per component, with no
  durability gain: the data is on one disk either way.
* **An S3 identity config file (`-s3.config`).** More expressive (several identities, per-bucket
  actions), but it has to be rendered with the secret inside it and mounted. One admin identity
  from the environment is all the platform uses.
* **RustFS or Garage.** ADR-0066's reasons apply: RustFS is viable but unnecessary; Garage needs
  a layout and key bootstrap after start.

## Consequences

* A fresh `docker compose up` and a fresh generated project pull only images that are publicly
  pullable, and the store the product ships is the store the S3 contract suite proves.
* W1-INF-01's reasoning about AGPL references no longer has a subject in the product; the record
  stays as the history of why MinIO was acceptable while it was pullable.
* Existing deployments have a one-time data copy to make; until they make it they can keep their
  MinIO-era files and cached image.
* The S3 gateway's gRPC port (18333) shares the S3 bind address and is not authenticated. It is
  reachable only on the private Compose network, where every peer already holds the S3 key; do not
  publish it.
* Upgrading SeaweedFS means changing the digest in `compose.yaml`, `packages/cli/src/deployment.ts`,
  `scripts/test-with-services.mjs` and the CI step together.
