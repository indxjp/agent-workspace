# `infra/nx-cache` — this repository's Nx remote cache

A small, zero-dependency Node service that implements the
[Nx self-hosted remote cache API](https://nx.dev/docs/kb/self-hosted-caching)
in front of Google Cloud Storage (or a local filesystem). It replaced Nx
Cloud's remote cache in 2026-10 — see
[ADR-0110](../../docs/adr/0110-nx-cloud-is-replaced-by-a-self-hosted-oidc-gated-remote-cache.md)
for why, and [`docs/operations/ci.md`](../../docs/operations/ci.md) → "Who may read and who
may write" for how CI uses it.

The code is vendored from a sibling project's `infra/nx-cache`, unchanged except
`deploy-gcp.sh`, which derives every resource name from `SERVICE` so this repository runs its
**own instance** (`aw-nx-cache`) — own bucket, service account, signing key, read token and OIDC
audience — next to a sibling project's cache in the same GCP project. A minted token names no
service, so a shared signing key would let one repository's `main` write the other's cache.

```
Nx (NX_SELF_HOSTED_REMOTE_CACHE_SERVER + _ACCESS_TOKEN)
  │  GET/PUT /v1/cache/{hash}            ← the only API Nx calls
  ▼
cache API (this directory; Cloud Run, h2c)
  │  ifGenerationMatch=0 create · streamed read
  ▼
GCS bucket (private; only the service identity, create + read, no delete)
```

## API

| Endpoint | Auth | Result |
| --- | --- | --- |
| `GET /v1/cache/{hash}` | read or write token | `200` tar stream · `404` · `401` |
| `PUT /v1/cache/{hash}` | write token | `200` · `409` exists · `403` read token · `401` · `411` · `413` · `400` length mismatch |
| `POST /v1/token` | GitHub Actions OIDC JWT (`aud=aw-nx-cache`) | `200 {token, role, expires_at}` · `401` · `403` |
| `GET /v1/health` | none | `200 ok` |

(`/healthz` is not used: Cloud Run's front end reserves paths ending in `z`.)

`{hash}` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`.

## Security properties

- **Role is decided server-side.** Static tokens map to a fixed role;
  OIDC-minted tokens get `write` only when GitHub's signed claims say
  `repository=example-org/example-repo`, `repository_id=123456789`,
  `ref=refs/heads/main`, `event_name ∈ {push, schedule}`. Any other run of the
  repository gets `read`. A pull request cannot obtain `write`, even by
  editing its workflow.
- **Immutable keys, first writer wins** — GCS `ifGenerationMatch=0`
  (fs backend: `link(2)`), atomically. Concurrent writers: one `200`, the
  rest `409`.
- **No partial records** — bodies are length-checked; GCS simple uploads are
  all-or-nothing; the fs backend publishes only after `fsync`.
- **Least privilege** — the service account has `storage.objectCreator` +
  `storage.objectViewer` on the bucket only: no overwrite, no delete.
- **No secrets in logs** — JSON lines with explicit fields only; principals
  are logged as `static:<digest prefix>` / `oidc:<repo>@<ref>#<run>`.
- **Streaming** — memory stays flat regardless of artifact size (tested at
  256 MiB both directions). The GCS data path deliberately uses
  `node:https`, not `fetch()`: undici's `fetch` was measured buffering whole
  bodies.

## Configuration

All configuration is environment variables — see the header of
[`src/main.mjs`](src/main.mjs) for the full list. The important ones:

| Variable | Purpose |
| --- | --- |
| `NX_CACHE_STORAGE` | `gcs` (default) · `fs` · `memory` |
| `NX_CACHE_GCS_BUCKET` / `NX_CACHE_FS_ROOT` | where artifacts live |
| `NX_CACHE_HTTP2=1` | serve h2c — required behind Cloud Run `--use-http2` |
| `NX_CACHE_READ_TOKENS` | comma-separated static read tokens (secret) |
| `NX_CACHE_WRITE_TOKENS` | break-glass static write tokens — **unset in normal operation** |
| `NX_CACHE_SIGNING_KEY` | enables `POST /v1/token` (secret) |
| `NX_CACHE_OIDC_REPOSITORY` / `_REPOSITORY_ID` / `_WRITE_REFS` / `_WRITE_EVENTS` | OIDC trust policy |

## Testing

```bash
node --expose-gc --test 'infra/nx-cache/test/*.test.mjs'     # contract, race, streaming, OIDC, failures
NX_CACHE_IT_GCS_BUCKET=<bucket> NX_CACHE_IT_GCS_TOKEN=$(gcloud auth print-access-token) \
  node --test infra/nx-cache/test/gcs.integration.test.mjs    # real GCS: precondition race, >32 MiB
```

Test matrix (numbers used in the test names): 1 no auth → 401 · 2 invalid
token → 401 · 3 read GET · 4 read PUT → 403 · 5 write PUT → 200 · 6 write
GET · 7 missing → 404 · 8 duplicate → 409 · 9 concurrent duplicates → one
winner · 10 byte-exact round trip · 11 256 MiB streamed without buffering ·
12 unsafe hashes rejected · 13 storage errors → safe 5xx, no record ·
14 no token in logs. Every case runs against the memory, fs and (emulated)
GCS backends; `gcs.integration.test.mjs` repeats the race against real GCS.
`.github/workflows/ci-nx-cache.yml` runs the suite plus a live check that a PR's OIDC token
yields a read-only token whose `PUT` gets `403`.

## Deploying

```bash
PROJECT=<project> OIDC_REPOSITORY=example-org/example-repo OIDC_REPOSITORY_ID=123456789 REGION=us-central1 infra/nx-cache/deploy-gcp.sh
```

Idempotent: creates/updates the bucket (`<project>-aw-nx-cache`; private, uniform access,
30-day lifecycle, no soft delete), service account (`aw-nx-cache`), Secret Manager secrets
(`aw-nx-cache-read-tokens`, `aw-nx-cache-signing-key`, generated, never printed),
Artifact Registry repo, the image (Cloud Build) and the Cloud Run service
(`--use-http2`, scale to zero, max 4 instances). Then set the repository
variables `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and
`INDX_NX_REMOTE_CACHE_ENABLED=true`. Operator runbook (Nx Cloud
decommission, rotation, rollback): the operator runbook (maintainers' copy).

### Running elsewhere

The image is runtime-agnostic. On a VM or an existing host:

```bash
docker build -t nx-cache infra/nx-cache
docker run -d -p 8080:8080 -v /srv/nx-cache:/data \
  -e NX_CACHE_STORAGE=fs -e NX_CACHE_FS_ROOT=/data \
  -e NX_CACHE_READ_TOKENS=... -e NX_CACHE_SIGNING_KEY=... \
  -e NX_CACHE_OIDC_AUDIENCE=aw-nx-cache \n  -e NX_CACHE_OIDC_REPOSITORY=example-org/example-repo -e NX_CACHE_OIDC_REPOSITORY_ID=123456789 \
  nx-cache
```

The image runs as the unprivileged `node` user (uid 1000), so
`chown 1000 /srv/nx-cache` first. Put TLS in front (Caddy/nginx/a load balancer); HTTP/1.1 has no size limit
there, so `NX_CACHE_HTTP2` stays unset. Nx configuration does not change —
only the `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` variable does.
