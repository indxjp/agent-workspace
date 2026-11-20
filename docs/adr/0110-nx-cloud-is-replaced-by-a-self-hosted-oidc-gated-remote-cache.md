# ADR-0110 — Nx Cloud is replaced by a self-hosted, OIDC-gated remote cache

Status: accepted (code and GCP deployment in this change; the Nx Cloud subscription steps are a
human's — the operator runbook, maintainers' copy)
Date: 2026-10-02
Decided by: the repository owner, reusing the design proven in `indx-app` (PR #1950, its
ADR-0006), with the measurements below taken on this repository
Scope: `nx.json`, `.github/workflows/ci.yml`, `.github/workflows/ci-nx-cache.yml`,
`.github/workflows/publish-packages.yml`, `.github/actions/nx-remote-cache`, `scripts/ci/`,
`scripts/check-workflows.mjs`, `infra/nx-cache/`, `docs/40-operate/operations/ci.md`; supersedes decision 3 of
[ADR-0053](0053-ci-runs-on-nx-and-blacksmith-never-on-a-self-hosted-runner.md) ("the cross-run
cache is Nx Cloud, and nothing else")

## Context

ADR-0053 made Nx Cloud the cross-run cache, and the workspace was connected on 2026-09-21
(`nxCloudId` in `nx.json`, `NX_CLOUD_ACCESS_TOKEN_READ` / `_WRITE` as repository secrets). Nx Cloud
bills per **CI Pipeline Execution** (CIPE, 500 credits), not per byte cached, plus active
contributors and concurrent connections. Every `ci.yml` run is one CIPE — its four Nx jobs share
one `GITHUB_RUN_ID` — so the bill scales with how often CI runs, and this repository runs CI a lot:

| `ci.yml` runs                  | pull_request | push | dispatch | total |
| ------------------------------ | -----------: | ---: | -------: | ----: |
| 2026-09 (whole month)          |        1,369 |  225 |        4 | 1,598 |
| 2026-09-21 → 09-30 (connected) |          430 |   79 |        0 |   509 |
| 2026-10-01 (one day)           |          164 |   36 |        0 |   200 |

(`gh api repos/<owner>/<repo>/actions/workflows/ci.yml/runs?event=…&created=…
--jq .total_count`; cancelled runs are included because a run cancelled after its Nx step started
has already opened a CIPE.)

The organisation's Nx Cloud invoice for 2026-08-31 → 09-30 was **$1,540.22**, and CI Pipeline
Executions were $913.28 of it for 1,660,500 credits: **$0.000550 per credit, $0.275 per CIPE**.
That invoice is organisation-wide and is attributed to `indx-app` in its ADR-0006; this
workspace's own usage page was not readable from the repository, so its share below is derived from
the run counts and that unit price, not read off an invoice (the RUNBOOK's step C.6 confirms it).

What Nx Cloud actually did here — measured from job logs (`Nx read the output from the cache …`):

| Job (tasks per run)                                            | `main` push, remote hits | pull request, remote hits |
| -------------------------------------------------------------- | ------------------------ | ------------------------- |
| fast-checks — build + typecheck + lint (50)                    | 8–48                     | 10–45                     |
| heavy-checks — build (16)                                      | 8–16                     | 10–17                     |
| heavy-checks — test (33, incl. the 16 builds replayed locally) | 19–32                    | 16–33                     |
| formal — build (16)                                            | 8–16                     | 10–17                     |
| generated-project-e2e — build (5)                              | 0–5                      | 0–5                       |

(Runs 36904594971 … 36936104005 on `main`, 36916699923 … 36935255663 on pull requests.) The remote
cache is real value: the four parallel jobs build the same packages, and a run replays what an
earlier `main` run or a sibling job already wrote. Nothing else was used: there are no Nx Agents
(`--distribute-on`), no atomized/`test-ci` lane, and no workflow consumed AI Fixes or the Resource
Usage add-on. So unlike `indx-app` there is no redundant lane to delete — the only duplicated work
is those parallel jobs building the same graph, which is exactly what the remote cache absorbs.

## Decision

1. **Keep Nx OSS** — the task graph, `nx affected`, hashing, declared inputs/outputs and the local
   cache are unchanged.
2. **Remove every Nx Cloud dependency** from active configuration: `nxCloudId` deleted and
   `"neverConnectToCloud": true` set in `nx.json`; `NX_CLOUD_ACCESS_TOKEN*` and `NX_NO_CLOUD`
   removed from `ci.yml` (four jobs) and `publish-packages.yml`. `indx-dev.yml` never passed an Nx
   token to the private shared-workflows repository's `dev.yml`, so that reusable-workflow contract is untouched.
3. **Replace the remote cache with this repository's own instance of the `indx-app` server**
   (`infra/nx-cache`, vendored unchanged apart from `deploy-gcp.sh`): the Nx self-hosted cache API
   (`GET`/`PUT /v1/cache/{hash}`) on Cloud Run with GCS storage, service `aw-nx-cache`, bucket
   `<project>-aw-nx-cache`. Never the deprecated `@nx/{s3,gcs,azure,shared-fs}-cache`
   packages (CREEP, CVE-2025-36852).
4. **A separate instance, not a shared one.** `deploy-gcp.sh` now derives the bucket, service
   account, both Secret Manager secrets and the OIDC audience from `SERVICE`. This was a real
   defect for a second instance, not tidiness: a minted cache token (`nxc1.<payload>.<hmac>`) names
   no service, so two services in one project that shared the hard-coded `nx-cache-signing-key`
   would accept each other's tokens — `indx-app`'s `main` could have written this repository's
   trusted cache. The OIDC policy is pinned to `<owner>/<repo>` **and** repository id
   `<repository-id>`, audience `aw-nx-cache`.
5. **Server-enforced trust via GitHub OIDC.** No write credential is stored in GitHub. A job
   exchanges its OIDC token for a 3-hour cache token, and the server grants `write` only to
   `ref=refs/heads/main` with `event_name` `push`/`schedule`, `read` to every other ref of the
   repository. A same-repository pull request that edits its own workflow still gets `read`.
   Workflow-side defences stay as well: one plan (`env.NX_REMOTE_CACHE_KIND`, `write|read|off`),
   an "Assert pull_request runs cannot select remote-cache write" step per job, and the action
   failing if the server grants more than planned.
6. **Immutable keys**: GCS `ifGenerationMatch=0`; the service account has `objectCreator` +
   `objectViewer` only, so even a server bug cannot overwrite or delete.
7. **The cache never decides CI's result.** Every task-running `nx` call goes through
   `scripts/ci/nx.sh`; the action degrades to local cache when the health check, OIDC or the token
   exchange fails.
8. **Kill switch**: repository variable `INDX_NX_REMOTE_CACHE_ENABLED` (`true` enables) plus
   `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`. Unset means local cache only.
9. **Guards**: `scripts/ci/check-nx-cache-config.mjs` (in `fast-checks`) fails any regression —
   an Nx Cloud id, token or kill switch, a write token in a workflow, cache env set outside the
   action, a missing assertion or plan, a raw `nx` call that bypasses the wrapper.
   `scripts/check-workflows.mjs` now requires the wrapper spellings of the build/test graph.

## Measurements (real Nx 23.2.1 client, this repository)

Against the same server code on its filesystem backend (`NX_CACHE_STORAGE=fs`), 2026-10-02, with a
fresh `NX_CACHE_DIRECTORY` **and** `NX_WORKSPACE_DATA_DIRECTORY` per phase (Nx 23 keeps its cache
index in workspace-data; reusing it fakes "local" hits):

| Phase                                                                               | Result                                                                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A — write token, cold, `nx run-many -t build` (16 projects)                         | 16 × `PUT 200`; 99 s                                                                          |
| Artifact sizes (server log)                                                         | p50 0.06 MiB, p95 0.39 MiB, **max 22.13 MiB** (`apps/web/.next`), 23.35 MiB per full build    |
| B — read token, cold, no `dist/` or `.next` on disk                                 | **16/16 remote hits in 18 s**; `package-exports:check:artifacts` passes for all 17 workspaces |
| C — read token, a hash nobody wrote                                                 | `PUT 403` (`role=read`, principal `static:afff5f1c`); Nx exits 0 and prints nothing           |
| D — server unreachable, raw `nx`                                                    | **exit 1** — `Failed to send request: … /v1/cache/<hash>`                                     |
| D — same, through `scripts/ci/nx.sh`                                                | exit 0, one warning, remote cache cleared via `$GITHUB_ENV`                                   |
| Chaos — GET 503 / PUT 500, through `nx.sh`                                          | exit 0 each, one warning each                                                                 |
| Chaos — a real TS2322 in `packages/contracts`, through `nx.sh`                      | **exit 1** (task failures are never masked)                                                   |
| Server suite (`node --expose-gc --test infra/nx-cache/test/*.test.mjs`, Node 24.19) | 53/53                                                                                         |

**Hosting.** Cloud Run caps HTTP/1 requests at 32 MiB. The largest artifact today is 22.13 MiB — it
fits, but it is the Next.js app's output and grows with every route, so the instance is deployed
with `--use-http2` and serves h2c (`NX_CACHE_HTTP2=1`), which removes the limit at no cost; `indx-app`
measured 168.5 MiB uploads through the same configuration.

Against the **deployed** instance (`https://<service>-<project-number>.us-central1.run.app`,
2026-10-02, real GCS, h2c through Cloud Run):

| Phase                                                           | Result                                                                                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Real-GCS integration test (`gcs.integration.test.mjs`)          | 3/3 — 10 concurrent writers → exactly one created, first bytes kept; a short body commits nothing                           |
| A — temporary break-glass write token, cold `run-many -t build` | 18 × `PUT 200` (principal `static:3b41278…`), the 22.13 MiB `.next` in 2.6 s; 262 s total; 0 `ERROR` log entries            |
| B — read token, cold, no outputs on disk                        | **18/18 remote hits in 29 s** (vs 262 s building); `.next` restored; `package-exports:check:artifacts` OK for 17 workspaces |
| C — read token, new hash                                        | `PUT 403 role=read principal=static:e83d483f`; Nx exits 0                                                                   |
| Cleanup                                                         | write token unmounted (`--remove-secrets`), its secret deleted, bucket purged to empty                                      |

The service runs with no static write token. The live OIDC trust check on the pull request is
recorded there.

## Cost

### Old (Nx Cloud, this workspace's share — estimated)

| Volume                        | CIPEs/month | × $0.275 |
| ----------------------------- | ----------: | -------: |
| September's rate (1,598 runs) |       1,598 |   ≈ $440 |
| 2026-10-01's rate (200/day)   |     ≈ 6,000 | ≈ $1,650 |

plus its active contributors ($19 each) and concurrent connections, which the shared invoice does
not split by workspace.

### New (GCP, list prices, us-central1, October 2026)

Per run: ≈ 120 cache `GET`s and up to ≈ 120 `PUT` attempts (Nx attempts the `PUT` of every miss even
on a pull request, which gets `403`), so ≈ 200 requests. Downloads: the 22 MiB `.next` is read by up
to three jobs (fast-checks, heavy-checks, formal build the full graph) plus ≈ 2 MiB of package `dist/`
and test reports per job — ≈ 70 MB per run when everything hits, less on misses.

| Component                                              | Formula (1,600 → 6,000 runs/month)                                                                 |             Estimate |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------: |
| Cloud Run requests                                     | 0.32 M → 1.2 M; free tier 2 M                                                                      |                   $0 |
| Cloud Run CPU/memory (request-based, 1 vCPU / 0.5 GiB) | ≈ 1.2 M × 0.05 s + 18 k large transfers × 0.5 s ≈ 69 k vCPU-s, 35 k GiB-s; free tier 180 k / 360 k |                   $0 |
| GCS Standard storage                                   | ≤ 225 trusted pushes × ≈ 25 MB written, 30-day lifecycle ≈ 6 GB × $0.020                           |              ≈ $0.12 |
| GCS Class A (uploads)                                  | 225 × ≈ 120 = 27 k × $0.005/1k                                                                     |              ≈ $0.14 |
| GCS Class B (reads, existence checks)                  | 0.2 M → 0.7 M × $0.0004/1k                                                                         |         ≈ $0.08–0.28 |
| GCS → Cloud Run, same region                           | free                                                                                               |                   $0 |
| **Internet egress** (cache → Blacksmith runners)       | 1,600 × 70 MB = 112 GB → 6,000 × 70 MB = 420 GB, × $0.12/GB                                        |         **≈ $13–50** |
| Secret Manager                                         | 2 secrets × $0.06 + accesses at deploy                                                             |              ≈ $0.12 |
| Artifact Registry / Cloud Build / Logging              | one < 100 MB image, a minute of build per deploy, < 1 GB logs                                      |                   $0 |
| **Total**                                              |                                                                                                    | **≈ $14–51 / month** |

Egress dominates, and almost all of it is `apps/web/.next`. If the bill ever matters, the first lever
is to stop caching that one output remotely (or to cache it only for the job that needs it); the
second is moving the service next to the runners. Nx Cloud after the RUNBOOK's section C: **$0**.

### Runner minutes

No lane is deleted here (there was none to delete), so the saving is the bill, not minutes. The
change adds a ≈ 2–3 s connect step to each of four Nx jobs, and `ci-nx-cache.yml` (≈ 1 small
runner-minute for the server suite and image, ≈ 0.3 for the live check) only on changes under
`infra/nx-cache/`, `scripts/ci/`, the action or `nx.json`.

## Consequences

- A pull request reads the cache `main` wrote; it can never write it. Its re-run does not hit its
  own earlier results — exactly as with the Nx Cloud read token.
- The first `main` push after the switch starts from an empty bucket (every job cold); from the
  second run the numbers above return.
- Fork pull requests get no OIDC token and run on local cache only, with a warning.
- Nx 23 may still print "connect to Nx Cloud" hints in its summary; they are cosmetic
  (`neverConnectToCloud`).
- `quality.yml` builds ten packages through Nx and never had a remote cache; it is left on local
  cache. Wiring it is one action step plus `id-token: write` if its build time ever matters.
- Rejected: keeping Nx Cloud on a smaller plan (per-CIPE pricing scales with run count, which is
  this repository's defining trait); `@nx/gcs-cache` (CREEP — one shared read/write credential lets
  any PR poison `main`); a long-lived write secret selected by workflow logic (a same-repository PR
  can edit the workflow and read every secret); widening `indx-app`'s instance to two repositories
  (needs per-repository key prefixes and write policy, and one signing key would span two trust
  boundaries); `actions/cache` on `.nx/cache` (ADR-0053: the Nx 20+ index is per machine); Turborepo
  (out of scope, and its remote cache has the same trust problem); Cloud Run over HTTP/1 (22 MiB
  today against a 32 MiB cap).

## Incident after the switch (2026-10-02)

The second `main` run after the switch (36943866830) was the first in which `web:build` was a remote
hit, and every Nx job failed in `web:lint` with 51 errors on the `RouteContext`-typed route handlers.
`next build` also writes the gitignored `apps/web/next-env.d.ts`, the file that brings
`.next/types/routes.d.ts` into the TypeScript program. Only `.next` was declared as an output, so a
replay restored `.next` but not that file. The defect predates this ADR (Nx Cloud replays
outputs the same way), but under Nx Cloud `web:build` was always rebuilt in practice, so it never
surfaced. Response:

- the kill switch went to `false` within minutes, and the bucket was purged;
- `{projectRoot}/next-env.d.ts` was declared as a `web:build` output — reproduced first: before the
  fix, a restore followed by lint failed with the same 51 problems, and after it lint passes;
- the cache was re-enabled once the fix was on `main`.

The rule this left: **every file a build writes that a later task reads must be a declared output.**
A replay restores declared outputs and nothing else.

## Amendment 2026-11-19: the merge queue and same-repository pull requests write

Decided by: the Owner, 2026-11-19, decisions D1 and D1b of the CI speed and cost programme. D1: a
merge-queue group may write the remote cache. D1b: a pull request from a branch of this repository
may write it too; the Owner chose this against the recommendation to keep pull requests read-only.
Forks stay read-only. The 409 no-overwrite rule stays.

Why. Under decision 5 only a push or the nightly on `main` wrote, and in practice nothing did: every
push to `main` was cancelled by a red `fast-checks` before its builds finished (ADR-0053, Amendments
2026-11-19 and 2026-11-19b), so pull requests and queue groups read an almost empty cache and
rebuilt everything. With writes from the pull request, its queue group (the same task inputs for
every project the rest of `main` did not change) replays instead of rebuilding, which is what
ADR-0053's plan A (Amendment 2026-11-19c) relies on.

What the server grants as `deploy-gcp.sh` deploys it (`infra/nx-cache/src/oidc.mjs`; the server's
own defaults in `src/main.mjs` grant only the first row `write`):

| Run                                                                              | Claims the server checks                                              | Role         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------ |
| push or nightly on `main`                                                        | `event_name` `push`/`schedule`, `ref=refs/heads/main`                 | `write`      |
| merge-queue group of `main`                                                      | `event_name=merge_group`, `ref=refs/heads/gh-readonly-queue/main/*`   | `write`      |
| pull request into `main`                                                         | `event_name=pull_request`, `ref=refs/pull/<n>/merge`, `base_ref=main` | `write`      |
| any other run of the repository (a dispatch, a pull request into another branch) |                                                                       | `read`       |
| any other repository                                                             | `repository` or `repository_id` differs                               | none (`403`) |

Every row first needs `repository=<owner>/<repo>` **and** `repository_id=<repository-id>`. A write
also needs the ref shape GitHub gives that event, so `NX_CACHE_OIDC_WRITE_EVENTS` and
`NX_CACHE_OIDC_WRITE_REFS` cannot combine into a pair GitHub never issues: a `push` to a branch named
`gh-readonly-queue/...` is not a queue group, and a `pull_request` token never carries
`refs/heads/main`. An event outside `push`, `schedule`, `merge_group` and `pull_request` in the write
list fails the server at startup.

**How forks are kept out, and which claim says so.** GitHub's OIDC token has no claim naming a pull
request's head repository. `repository` and `repository_id` name the repository the workflow runs
in, and a fork's `pull_request` run also runs in this one. So the server cannot tell a fork's run
from a branch's run by its claims. Forks are kept out one step earlier: GitHub issues a fork's run
no OIDC token unless the repository setting "Send write tokens to workflows from fork pull requests"
is on, and here forks cannot run workflows at all. Read on 2026-11-19
(`gh api repos/<owner>/<repo>/actions/permissions/fork-pr-workflows-private-repos`):
`run_workflows_from_fork_pull_requests: false`, `send_write_tokens_to_workflows: false`; the
repository is `internal` with `allow_forking: false`. Turning either setting on would hand a fork's
run a token the server grants `write`; both must stay off. `deploy-gcp.sh` reads both through that
API before it changes anything whenever its write events include `pull_request`, and stops unless
both are `false` (or when it cannot read them); `infra/nx-cache/test/oidc.test.mjs` holds that the
check is there and runs first. Between redeploys nothing reads them automatically: the endpoint
needs admin read on the repository, which no workflow token has, so a setting turned on later is
caught only at the next redeploy (step 2 below stays an owner check). The server's own defaults
(`DEFAULT_WRITE_REFS=refs/heads/main`, `DEFAULT_WRITE_EVENTS=push,schedule` in `src/main.mjs`)
stay main-only, so a deployment that does not opt in, such as the README's `docker run` example,
never grants a pull request `write`; only `deploy-gcp.sh` sets the D1/D1b policy. In the
workflows, the plan (`NX_REMOTE_CACHE_KIND`) requires
`github.event.pull_request.head.repo.full_name == github.repository`, each Nx job's "Assert fork
pull_request runs cannot select remote-cache write" step and `.github/actions/nx-remote-cache`
refuse a planned write for a fork, and `scripts/ci/check-nx-cache-config.mjs` (rule
`fork-read-only`) fails a workflow or action that drops either. These are advisory against a fork
that edits them; the setting is what enforces it.

**Residual risk (CREEP class, CVE-2025-36852).** Any collaborator who can push a branch can now
write cache entries. The PR's own workflow, which the PR may edit, can `PUT` arbitrary bytes under
any hash with its write token. The hash that matters is the one its own reviewed source will have
after merge: a pull request with harmless-looking source can upload altered build outputs for that
source's hash, and the queue and `main` would replay them, because they compute the same hash.
409 stops a later writer from replacing an entry; it does not stop the first writer. The Owner
accepted this. It needs write access to the repository, which already allows pushing code for
review. What limits it:

- **The diff shows it.** Uploading bytes other than Nx's own outputs needs a change to a workflow,
  the cache action, `scripts/ci/nx.sh` or a build script, all of which are in the pull request's
  diff. Nothing forces a reviewer to read it: the ruleset requires 0 approvals (ADR-0149), and
  CODEOWNERS is not blocking. This is the weakest point of D1b and the one to revisit first if the
  set of people who can push branches grows.
- **Traceable.** Every token exchange logs `repository`, `ref`, `event`, `baseRef` and `run`, and
  every `PUT` logs the minted principal `oidc:<repo>@refs/pull/<n>/merge#<run>`: a poisoned entry
  leads to the pull request and the run that wrote it (Cloud Logging, service `aw-nx-cache`).
- **Published packages never come from the cache.** `publish-packages.yml` builds what it publishes
  with `--skip-nx-cache` and never uses `.github/actions/nx-remote-cache`. The gates do replay
  cached results (the queue, the nightly and the release gate's `ci.yml` call read the cache), so a
  poisoned entry could make a check read as passed there, but not change a published byte.
- **Bounded life.** Objects expire after 30 days (bucket lifecycle). Response to a suspected
  poisoning: set `INDX_NX_REMOTE_CACHE_ENABLED` to `false` (the next job is on local cache), purge
  the bucket, redeploy with the main-only policy below, then re-enable.
- **Forks never** (above).

Rejected: a separate namespace for pull-request writes that only pull requests read (the queue and
`main` would rebuild everything again, losing the reason for D1b); verifying the head repository by
calling the GitHub API from the server on each exchange (a new long-lived GitHub credential in the
server, and the fork settings above already enforce it).

Rollout order (owner actions; the workflow side is in this change, the server side is not deployed
by it):

1. Merge this change. Workflows plan `write` for groups and same-repository pull requests; the
   deployed server still grants `read`, which the action accepts with a warning ("expected 'write',
   server granted 'read'"). Redeploying the server first would fail every pull request job, because
   the old workflows plan `read` and the action fails a run granted more than it planned.
2. Confirm the fork settings above are still off (`deploy-gcp.sh` also refuses to deploy the
   pull request write policy otherwise).
3. Redeploy: `PROJECT=<project> OIDC_REPOSITORY=<owner>/<repo> OIDC_REPOSITORY_ID=<repository-id>
REGION=us-central1 infra/nx-cache/deploy-gcp.sh` (it now sets
   `NX_CACHE_OIDC_WRITE_REFS=refs/heads/main,refs/heads/gh-readonly-queue/main/*,refs/pull/*/merge`,
   `NX_CACHE_OIDC_WRITE_EVENTS=push,schedule,merge_group,pull_request`,
   `NX_CACHE_OIDC_WRITE_PR_BASE_REFS=main`).
4. Verify: re-run `ci-nx-cache.yml` on a same-repository pull request; its live trust check must
   report a `write` grant, `PUT 200`, a duplicate `PUT 409` and a byte-exact read. A queue group's
   Nx jobs must log `connected as 'write' (event=merge_group …)`.

Rollback to main-only writes: `WRITE_REFS=refs/heads/main WRITE_EVENTS=push,schedule
infra/nx-cache/deploy-gcp.sh` (the server then grants `read` again; the workflows' `write` plan
degrades with a warning, nothing fails), then purge the bucket if a write is suspect.
