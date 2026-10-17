# CI: the Nx task graph and its remote cache

Decisions: [ADR-0053](../adr/0053-ci-runs-on-nx-and-blacksmith-never-on-a-self-hosted-runner.md)
(Nx; runners per its 2026-10-16 amendment), [ADR-0110](../adr/0110-nx-cloud-is-replaced-by-a-self-hosted-oidc-gated-remote-cache.md)
(Nx Cloud → self-hosted cache). Operator steps: the operator runbook (maintainers' copy).

## What runs where

Every workflow runs on ephemeral VMs, never a self-hosted runner. Every job runs on GitHub's
`ubuntu-latest` except the four that set a run's length (`formal`, `generated-project-e2e`,
`journey-e2e`, `tool-sandbox-e2e`). Those run on the label in the repository variable
`CI_BOTTLENECK_RUNNER` (`blacksmith-4vcpu-ubuntu-2404`), and on `ubuntu-latest` when it is unset
(ADR-0053, Amendments 2026-10-16). `scripts/check-workflows.mjs` refuses the variable on any other
job. If Blacksmith stops picking jobs up, delete the variable
(`gh variable delete CI_BOTTLENECK_RUNNER`) and re-run. In `ci.yml`, the `build` job runs `nx run-many -t build`
once for every workspace but `@indx-workspace/embedded` and uploads the outputs as the
`workspace-build` artifact. Beside it, `build-embedded` runs embedded's webpack build, uploads
`embedded-build` and runs embedded's tests. The jobs that
need built packages restore them (`.github/actions/workspace-build`) instead of building; only
`release-checks`, `generated-project-e2e`, `journey-e2e` and `docs-claims` wait for embedded. `release-images` (the runtime, gateway and egress-proxy image
checks) needs neither build and starts at once:
`typecheck-lint`
(typecheck and lint, one target per runner), `heavy-checks` (four test shards, one Vitest task per
project), `release-checks`, `formal`, `generated-project-e2e`, `journey-e2e` (then
`tests/journey/run.mjs`, the slice-1 developer-journey exit test), `docs-claims` and
`tool-sandbox-e2e`. Their Nx targets run with `--excludeTaskDependencies`, so nothing is rebuilt.
`fast-checks` runs only static gates and needs no other job. The jobs that build Docker images free
room first (`.github/actions/free-disk`): about 30 GB of unused SDKs are deleted in the background
while the job installs. The jobs that need embedded run after `build` only, beside `build-embedded`, and
`.github/actions/workspace-build` waits for its artifact; `generated-project-e2e` and
`tool-sandbox-e2e` (which needs no build job at all) build their Docker images before that wait.
`journey-e2e` runs the journey and the first-hour stopwatch as two matrix legs, and `docs-claims`
runs its pages as three shards (`run.mjs --shard i/3`), each with its own report. A pull request runs typecheck, lint and
tests for `nx affected` against its merge base with `main`; a push to `main` runs the whole graph.

`ci-success` is the one check branch protection requires. It needs `fast-checks`, `build`,
`build-embedded`, `typecheck-lint`, `heavy-checks`, `release-checks`, `release-images`, `formal`, `image-scan`, `generated-project-e2e`, `journey-e2e` and `tool-sandbox-e2e` (#847: a
code tool pushed, run in its tool sandbox and promoted on the Compose stack). A skipped job fails
`ci-success`, so a required job never has a job-level `if:`; it filters paths inside a step and
ends green when the diff does not reach it. The developer journey moved from its own workflow
(`journey-e2e.yml`) into `ci.yml` (#514), so a red journey run blocks merges. It takes on
`ci.yml`'s triggers and concurrency, which is a trade-off: an `edited` pull request event (a title
or body change, which the ownership gate needs) re-runs it, and a superseded run is cancelled, on
`main` too. A `main` commit that a quick follow-up merge supersedes therefore records no
`journey-timings`; read the measurement from the latest `main` run whose journey reached its report
(the upload warns rather than fails when the file is missing), or re-measure any ref with
`workflow_dispatch`.

`journey-live.yml` (#609) runs the same journey against the real Anthropic API
(`node tests/journey/run.mjs --live`) nightly and on `workflow_dispatch`. It is not a required
check and not a `ci-success` need, so a model outage never blocks a merge. It needs the repository
secret `ANTHROPIC_API_KEY` and fails at its first step, naming the secret, when it is missing. Its
`journey-live-timings` artifact holds the same record as `journey-timings`, with `model: "live"`
and each widget answer's first-token latency under `firstTokenSeconds`.

**Nx OSS stays; Nx Cloud is gone.** The task graph, `nx affected`, hashing, the inputs and outputs
declared in `nx.json` and each `package.json`'s `nx` block, and the local cache are all Nx OSS.
`nx.json` has no `nxCloudId` and sets `"neverConnectToCloud": true`; no workflow holds an Nx Cloud
token. There are no Nx Agents: every task runs on the job's own runner.

## Local cache and remote cache

- **Local cache** — inside one job, Nx replays a task whose hash it has already computed. This is
  why `heavy-checks`' test step does not rebuild what its build step just built. It is always on
  and needs nothing.
- **Remote cache** — between jobs and between runs. The five Nx jobs of one run build the same
  packages side by side, and a pull request rebuilds what `main` already built. The remote cache
  lets each of them download a finished task's outputs and terminal log instead. It is an
  **optimisation only**: with it off, CI is slower and exactly as correct.

The remote cache is this repository's own server (`infra/nx-cache`), on Cloud Run with GCS
storage. It implements Nx's self-hosted cache API: Nx calls `GET`/`PUT /v1/cache/{hash}` when a job
has `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` set. Only
`.github/actions/nx-remote-cache` sets them. `scripts/ci/check-nx-cache-config.mjs` fails a
workflow that sets them any other way.

## Who may read and who may write

| Run                                | Role               | Why                                             |
| ---------------------------------- | ------------------ | ----------------------------------------------- |
| push to `main`                     | `write`            | trusted: the code is reviewed and merged        |
| pull request (same repository)     | `read`             | replays `main`'s results, can never add to them |
| pull request from a fork           | none (local cache) | GitHub issues no OIDC token to a fork           |
| `workflow_dispatch`, any other ref | `read`             | not a trusted `main` build                      |

**How it is enforced.** There is no write secret anywhere in GitHub. Each Nx job has
`permissions: id-token: write`. The action asks GitHub for the job's OIDC token
(audience `aw-nx-cache`) and posts it to the server's `POST /v1/token`. The server checks GitHub's
signature, then reads the signed claims: `repository` must be `<owner>/<repo>` and
`repository_id` must be `<repository-id>`. It returns a 3-hour token whose role it chose itself: `write`
only for `ref=refs/heads/main` with `event_name` `push` or `schedule`, otherwise `read`. A pull
request run's token says `ref=refs/pull/<n>/merge` and `event_name=pull_request`, whatever its YAML
says. So a pull request that edits `ci.yml` to ask for `write` still gets `read`.

Belt and braces on the workflow side:

- The workflow computes the plan **once**, as `env.NX_REMOTE_CACHE_KIND` (`write|read|off`).
- Each Nx job has an "Assert pull_request runs cannot select remote-cache write" step.
- The action fails the job if the server grants **more** than planned. A grant of less is used,
  with a warning.

## The threat this defends against: cache poisoning

A cache entry is "the outputs of the task whose inputs hash to H". Suppose someone could write an
entry under a hash that `main` will later compute, for example by building a modified tool or test
in a pull request. Every later `main` run would then replay their bytes as if `main` had built them.
That is the CREEP class of attack (CVE-2025-36852) against the deprecated `@nx/*-cache` bucket
packages, where every CI job holds one read/write bucket credential. Here:

- Pull requests can only read (see above).
- **Keys are immutable.** The server creates an object only if none exists (GCS
  `ifGenerationMatch=0`, atomic). A second `PUT` of the same hash returns `409`, and the first
  writer's bytes are kept. Concurrent writers: exactly one `200`.
- The service account has `storage.objectCreator` + `storage.objectViewer` only. It cannot
  overwrite or delete, even through a server bug.
- Outputs never include `.env*`: the guard rejects such an `outputs` glob.

## Kill switch

Repository variables (Settings → Secrets and variables → Actions → Variables):

- `INDX_NX_REMOTE_CACHE_ENABLED` — `true` enables the cache. Anything else, or unset, means
  local cache only.
- `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` — the service URL. Empty also means local cache only.

Both take effect on the next job. Nothing else changes when the cache is off.

## Outage behaviour

Nx 23's HTTP cache client treats **any** transport error or 5xx from the cache server as fatal. It
prints `Failed to send request: … /v1/cache/<hash>` or `Misconfigured remote cache endpoint …` and
exits 1 even when every task passed. This was measured on this repository: unreachable server, raw
`nx` exits 1. So:

- The action checks `GET /v1/health` first and skips the cache if it fails. It also skips when no
  OIDC token is available, or when the token exchange fails. In every case it warns and continues.
- Every task-running `nx` call goes through `scripts/ci/nx.sh <nx args>`. If `nx` failed **and** its
  output carries one of those two signatures, the wrapper does three things:
  - warns;
  - clears the cache variables for the rest of the job (through `$GITHUB_ENV`);
  - runs the same command once more on the local cache, where finished tasks replay instantly.
- A genuine task failure never matches those signatures, so its exit code is returned unchanged.
  Measured: GET 503, PUT 500 and an unreachable server all end green through the wrapper, and a
  real TypeScript error still fails.
- The server itself is honest: storage errors are real `5xx`, and no partial record is ever left.

A `403` on `PUT` (a read token) is **not** an error to Nx: it ignores it and exits 0. That is the
normal pull-request path. Nx still attempts the `PUT` for every miss.

## Hosting and sizes

Cloud Run caps an HTTP/1 request at 32 MiB. Measured with the real Nx client on a full build:

- artifacts are p50 0.06 MiB, p95 0.39 MiB, and max 22.13 MiB (`apps/web/.next`, minus
  `.next/cache`);
- a full build stores 23.35 MiB in total.

The service is deployed with `--use-http2` and serves h2c (`NX_CACHE_HTTP2=1`), so there is no size
limit as the app grows. The bucket deletes objects after 30 days. The server streams in both
directions, so memory stays flat at any artifact size; its test suite proves this at 256 MiB.

## Credentials and rotation

- **CI** holds no long-lived cache credential: minted tokens last 3 hours.
- **Secret Manager** (project `<project>`) holds `aw-nx-cache-signing-key`, which signs the
  minted tokens, and `aw-nx-cache-read-tokens`, a static read token for a consumer that cannot use
  OIDC. Neither is in GitHub.
- **Rotate** by adding a secret version and redeploying (`infra/nx-cache/deploy-gcp.sh`). The steps
  are in the RUNBOOK, section D.
- **Separate instance.** This repository's instance shares nothing with `indx-app`'s
  `indx-nx-cache`: not the bucket, the service account, the signing key or the audience. Tokens of
  one are worthless at the other.

## Debugging hits and misses

- Each Nx job logs a notice from the connect step. `connected as 'read' (event=pull_request …)`
  means the cache is on. `off`, or a warning saying why it is local-only, means it is off.
- `--output-style=static` prints one line per task with `[remote cache]`, `[local cache]` or
  nothing (a miss). The summary line `Nx read the output from the cache instead of running the
command for N out of M tasks` counts both kinds of hit.
- **Why a miss?**
  - A task's hash covers its declared inputs plus `sharedGlobals`: root `package.json`, the
    lockfile, `tsconfig.json`, `nx.json`, and `node --version`.
  - Test hashes also cover `TEST_DATABASE_URL` and `TEST_S3_ENDPOINT`.
  - Changing any of these misses everything downstream. A pull request that touches the lockfile
    or `nx.json` is a full cold graph.
  - Compare two runs' hashes with
    `pnpm nx show project <name> --json` / `NX_VERBOSE_LOGGING=true`.
- **A hit that breaks a later task** means a declared output is incomplete. A replay restores the
  declared `outputs` and nothing else, so any file the build writes and a later task reads must be
  listed. Example: `apps/web/next-env.d.ts`, which `next build` writes and type-aware lint needs
  (ADR-0110, "Incident after the switch").
- **Server side**: Cloud Logging, service `aw-nx-cache`. Every request is one JSON line with
  `method`, `route`, `hash`, `role`, `principal` (`oidc:<repo>@<ref>#<run>` or
  `static:<digest8>`, never a token), `status`, `bytes` and `durationMs`.
- **Locally** you are on the local cache only, and that is the intended setup. To try the remote
  path, run the server with `NX_CACHE_STORAGE=fs` (infra/nx-cache/README.md). Give each attempt a
  fresh `NX_CACHE_DIRECTORY` **and** `NX_WORKSPACE_DATA_DIRECTORY`: Nx 23 keeps its cache index in
  workspace-data, and reusing it produces "local" hits that prove nothing.

## Why there are no Nx Agents

Nx Agents (Nx Cloud managed compute, `nx-cloud start-ci-run --distribute-on`) were never used here.
They would bring back per-CIPE billing for work the existing runners already do in parallel: the
gate jobs run side by side, and `heavy-checks` runs all ten Vitest projects at once on 16 cores. The
guard rejects `start-ci-run`, `--distribute-on` and `NX_CLOUD_DISTRIBUTED_EXECUTION`. If the
critical path grows, the order of remedies is:

1. `--parallel` and runner size;
2. splitting a job;
3. only then, distribution — on runners this repository already pays for.
