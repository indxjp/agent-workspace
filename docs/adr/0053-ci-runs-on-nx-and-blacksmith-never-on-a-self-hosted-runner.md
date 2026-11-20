# ADR-0053 — CI runs on Nx and Blacksmith, never on a self-hosted runner

Status: accepted
Date: 2026-09-21
Decided by: the repository owner, with the measurements below
Scope: the gate workflows, `nx.json`, every workspace `package.json`'s `nx` block, `scripts/check-workflows.mjs`

## Context

Every gate in this repository ran on GitHub's 4-vCPU `ubuntu-latest` runner, as two jobs queued
one behind the other. Measured on the last green pull-request run before this change
(`ci.yml` run 35518274099, `quality.yml` run 35518274117, 2026-09-20):

| Job                                  | Wall clock     | Where the time went                                           |
| ------------------------------------ | -------------- | ------------------------------------------------------------- |
| `fast-checks`                        | 2 min 43 s     | lint 64 s, typecheck 22 s, formatting 16 s, architecture 11 s |
| `heavy-checks` (after `fast-checks`) | 9 min 10 s     | `pnpm test` 6 min 45 s, `pnpm build` 61 s                     |
| `ci.yml` critical path               | **12 min 0 s** | the two jobs in series                                        |
| `quality.yml` › coverage             | 9 min 53 s     | three coverage configs run one after another                  |

Inside the 6 min 45 s test step, Vitest's own accounting was 395 s of wall clock for 209 s of
summed file time: 40 % of the run was module import on four cores, and the root `tests` project
— which is serial by design (`tests/vitest.config.ts`) — contributed 92 s of that floor on its
own.

The sibling repository `indx-app` runs its frontend CI through an Nx task graph and, for
its image builds, on Blacksmith runners; it also keeps two self-hosted DGX runner pools whose
persistence has cost it a per-job process reaper, docker-resource cleanup, `PNPM_HOME` isolation
and a shared-`/tmp` Nx marker incident. Those pools are an operational commitment this repository
does not want to inherit.

## Decision

1. **Every CI job runs on a Blacksmith VM**, `blacksmith-<n>vcpu-ubuntu-2404`, sized per job (2 vCPU
   for the `jq`-only `ci-success`, 4 for `pnpm audit`, 8 for lint/typecheck, browser and coverage,
   16 for the service-backed test job). A Blacksmith runner is GitHub's own image booted for one job
   and discarded, with Docker and passwordless sudo, and it serves `actions/cache` and
   `actions/setup-node`'s `cache: pnpm` from a colocated cache with no workflow change. The only
   other label a gate workflow may use is `ubuntu-latest`. **This repository owns no self-hosted
   runner and a gate workflow must not schedule onto one**; `scripts/check-workflows.mjs` fails
   any other `runs-on` in `ci.yml`, `quality.yml` and `security.yml`. `indx-dev.yml` is the agent
   tooling's workflow, not a gate, and is deliberately outside that rule.
2. **Nx owns the task graph.** `nx.json` plus an `nx` block in every workspace `package.json`
   declare `build`, `typecheck`, `lint` and `test` per project as plain commands (no plugin, no
   `project.json`). `pnpm build`, `pnpm typecheck` and `pnpm lint` are now `nx run-many`, so the
   commands AGENTS.md names are unchanged. A pull request runs `nx affected` against its merge
   base with `main`; a push to `main` runs the complete graph so a gap in affected-detection cannot
   hide. The root `tests` project depends on every package (`implicitDependencies: ["*"]`) because
   its suites are cross-cutting.
3. **The cross-run cache is Nx Cloud, and nothing else.** Both gate jobs read
   `NX_CLOUD_ACCESS_TOKEN` (the read-only token for a pull request, the read-write one for a push
   to `main`, same rule as `indx-app`) and honour `vars.NX_NO_CLOUD` as the kill switch; with no
   `nxCloudId` in `nx.json` the variables are inert and each run starts cold, which is correct,
   only slower. Carrying `.nx/cache` between runs with `actions/cache` was the first draft of this
   decision and was rejected by measurement, not preference: since Nx 20 the cache index is a
   SQLite database named after the machine (`<machine id>-v3.db`), and on 23.2.1 a task whose
   output directory is present under the cache but absent from a fresh database is a miss
   (`nx run @agent-workspace/runtime:build` with `NX_WORKSPACE_DATA_DIRECTORY` pointed at an
   empty directory: `Cache: 0/1 hit`). A restored directory on a new VM is therefore never
   consulted. `TEST_DATABASE_URL` and `TEST_S3_ENDPOINT` are inputs of every test task, so a
   result computed without the services (where the database and object-store suites skip) is
   never replayed for a run that has them.
4. **`fast-checks` and `heavy-checks` run in parallel** behind a single `ci-success` job, which is
   the check to require. The cheap deterministic gates still run before anything is installed
   inside `fast-checks`, so a malformed PR body still fails in seconds; what changed is that the
   test job no longer waits for them.
5. **Tests run one Nx task per Vitest project, all at once**, each writing
   `<project>/.vitest-report.json` (declared as the task's output so a replay restores it). The
   no-skip gate reads every report present and still requires at least one. MinIO is started once
   per job for the object-store contract suite, with the same image digest
   `scripts/test-with-services.mjs` uses.

## Consequences

- Expected critical path for a full run: `heavy-checks` ≈ install + build + ~100 s of tests (the
  serial `tests` project is the floor; everything else runs beside it on 16 cores), with
  `fast-checks` finishing earlier beside it. A pull request that touches one package runs that
  package's tasks and the root project's suites, and replays the rest from cache. The first run
  on this branch is the measurement that replaces this estimate; ADR-0016 applies — record the
  number in the PR, not here.
- Connecting Nx Cloud is the owner's follow-up: `pnpm nx connect` prints a one-shot claim URL
  that only a browser session in the Nx Cloud organisation can complete. Connect the
  workspace, add the `nxCloudId` to `nx.json`, and add `NX_CLOUD_ACCESS_TOKEN_READ` (read-only)
  and `NX_CLOUD_ACCESS_TOKEN_WRITE` (read-write) as repository secrets. Until then the graph's
  parallelism and `nx affected` are the whole gain; the remote cache is the second half.
- The Blacksmith GitHub App must be installed for this repository; a job whose label no runner
  claims queues rather than fails. The `indx-app` deploy workflows already run on
  `blacksmith-16vcpu-ubuntu-2404`, which is the evidence the organisation has the app.
- `nx`'s postinstall is denied in `pnpm-workspace.yaml` (it only warms the project graph), for
  the same reason `esbuild`'s is.

## Amendment (2026-10-16): off Blacksmith; build once, split the long jobs

Decision 1's Blacksmith runners are withdrawn. Every CI job runs on GitHub's own `ubuntu-latest`,
and `scripts/check-workflows.mjs` now accepts no other `runs-on` in `ci.yml`, `quality.yml`,
`security.yml` and `ci-nx-cache.yml`. Two things forced it. Blacksmith cost about $2.3K in the first
half of October, almost all of it this repository's jobs on 16 and 8 vCPU. Then, from about
15:50 UTC on 2026-10-15, Blacksmith put the account on hold ("requires additional
verification"). No job was picked up after that, and paying the overdue invoices did not lift the
hold. One vendor's account state had stopped every pull request in two repositories.

A 2-vCPU `ubuntu-latest` failed when `ci.yml` was simply moved onto it (PR #1147). The 10-minute
package build timed out, and the Docker builds ran out of disk. So `ci.yml` is reshaped to stop doing
work twice and to run in parallel what used to run in one long job:

- **Build once.** A `build` job runs `nx run-many -t build` and uploads every build output as one
  artifact. Each other job that needs built packages restores it (`.github/actions/workspace-build`)
  instead of building again: the test shards, typecheck and lint, the release checks, `formal`,
  `generated-project-e2e`, `journey-e2e`, `docs-claims` and `tool-sandbox-e2e`. Nx targets in those
  jobs run with `--excludeTaskDependencies`. Before this, six jobs each built the packages, and a
  pull request that missed the remote cache for `@indx-workspace/embedded` paid for it six times.
- **Split the long jobs.** `heavy-checks` becomes four test shards, balanced on measured times. The
  serial root `tests` project gets one shard; aw with cli, and web with core, get one each; and
  `rest` takes every other project, so a new package needs no edit. The release and image steps that
  used to follow the tests move to `release-checks`. Typecheck and lint run on separate runners
  (`typecheck-lint`), and the image scan is split three ways (`scan-images.sh --shard`).
  `fast-checks` keeps only the static gates, so a bad PR body still fails in seconds.
- **Free disk.** The jobs that build Docker images first delete the SDKs the runner image ships
  but this repository never uses (`.github/actions/free-disk`, about 30 GB).

- **Embedded beside the build** (follow-up PR). On 2 vCPU, `@indx-workspace/embedded`'s webpack
  build is about 9 of the `build` job's 13 minutes, and no project depends on it. `build` now
  builds every other workspace; `build-embedded` builds embedded beside it and runs embedded's
  tests. Keeping webpack's cache between runs was measured and not adopted (1.4 GB for 11%). Only the four jobs that pack the published set
  wait for it, and they no longer wait through `needs`: they start after `build`, do their own
  build-independent work (the Docker images), and `.github/actions/workspace-build` waits for the
  artifact in the run. The journey's first-hour stopwatch and the docs claims' pages run on
  parallel runners. The SDKs are deleted in the background while a job installs.

The self-hosted-runner ban, the Nx task graph and the self-hosted remote cache are unchanged.
GitHub's larger hosted runners would be the next lever if the critical path is still too long.
They are GitHub's own ephemeral VMs, but an organisation owner has to create them, and they are
billed separately.

## Amendment (2026-10-16, second): Blacksmith for the bottleneck jobs only, behind a variable

Blacksmith is available to this repository again. Most of the reshaped `ci.yml` does not need it:
once the tests that fork a real process or race PostgreSQL were given their own timeouts, every job
passed on `ubuntu-latest`. What `ubuntu-latest` still costs is time. A run takes 15 to 22 minutes,
and four jobs set that length: `formal` (up to 18 minutes), `generated-project-e2e` (12 to 14),
`journey-e2e` (12) and `tool-sandbox-e2e` (15). Every other job is done 2 to 3 minutes sooner, so
moving it would buy nothing. On Blacksmith's 4 vCPU the four took 6 to 7 minutes.

So only those four go back to Blacksmith, under three conditions:

- **Only the bottleneck jobs.** `scripts/check-workflows.mjs` holds every other job to
  `ubuntu-latest`, and refuses the variable on any job outside its `BOTTLENECK_JOBS` list. A job
  joins the list in a pull request that shows it now sets the run's length.
- **The label is not written into the workflow.** The four read
  `runs-on: ${{ vars.CI_BOTTLENECK_RUNNER || 'ubuntu-latest' }}`, with `CI_BOTTLENECK_RUNNER` set
  to `blacksmith-4vcpu-ubuntu-2404`. If the vendor stops picking jobs up again, deleting the
  variable moves them to `ubuntu-latest` with no pull request. A hard-coded vendor label or a
  self-hosted label is still refused. The variable must name an ephemeral VM; a self-hosted label
  in it breaks the same rule as one in a file.
- **4 vCPU, not 8 or 16.** The cost was mostly the 8 and 16 vCPU jobs.

`quality.yml`, `security.yml` and `ci-nx-cache.yml` stay on `ubuntu-latest`.

## Amendment (2026-10-19): all CI back on Blacksmith, temporarily

GitHub-hosted jobs stopped starting ("recent account payments have failed or your spending limit
needs to be increased"), so every job in `.github/workflows/` except the agent
tooling in `indx-dev.yml` (out of scope) moved back to a hard-coded Blacksmith label, sized as before the first
2026-10-16 amendment: 16 vCPU for `heavy-checks`, the image and e2e jobs, 8 for build, test and
`formal`, 4 for Docker and live-lane jobs, 2 for gates and summaries. Windows jobs run on
`blacksmith-4vcpu-windows-2025` and the macOS install lane on `blacksmith-6vcpu-macos-latest`.
`scripts/check-workflows.mjs` now requires a `blacksmith-<n>vcpu-ubuntu-2404` label instead of
`ubuntu-latest`, and the `CI_BOTTLENECK_RUNNER` indirection is gone. This is temporary: once
GitHub-hosted billing is fixed, the 2026-10-16 layout comes back in one pull request.

## Outcome (2026-10-02)

Decision 3 and the "Connecting Nx Cloud" consequence are superseded by
[ADR-0110](0110-nx-cloud-is-replaced-by-a-self-hosted-oidc-gated-remote-cache.md). Nx Cloud was
connected on 2026-09-21 and did serve remote hits (8–48 of fast-checks' 50 tasks per run), but it
billed per CI Pipeline Execution, so its cost tracked this repository's run count. The cross-run cache is
now this repository's own Nx self-hosted cache server (`infra/nx-cache`), written only by `main`
through GitHub OIDC; `nxCloudId`, the two `NX_CLOUD_ACCESS_TOKEN_*` secrets and `vars.NX_NO_CLOUD`
are gone, and `nx.json` sets `neverConnectToCloud`. The rest of this ADR — the runners (until the 2026-10-16 amendment), the
Nx task graph, the parallel gate jobs, and the measurement that rules out `actions/cache` on
`.nx/cache` — stands.

## Amendment 2026-10-19: one full run per change, not three

Measured over the last 300 runs, a change was tested in full three times (pull request, merge
queue, push to `main`: about 65, 170 and 140 job-minutes), `OSS export` cold-built the filtered tree
each time (about 11 minutes, 23 pull-request runs), the coverage floors re-ran the tests the shards
had just run, and three nightly workflows failed every night (`journey-live` 15 of 15,
`install-live` 10 of 10 at 35 minutes each).

1. **Pull request** runs the inner loop only: fast checks, build, typecheck and lint, test
   shards, release checks, browser smoke. **Merge queue** runs everything, including the Docker and
   end-to-end tier (`formal`, `release-images`, `image-scan`, `generated-project-e2e`,
   `journey-e2e`, `docs-claims`, `tool-sandbox-e2e`, `coverage`). A pull request opts in early with
   the label `ci:full`. `ci-success` accepts a skipped job on a pull request and a push, never in
   the queue or on a dispatch, so the queue stays the full gate.
2. **Push to `main`** only builds (`build`, `build-embedded`): the queue already tested that tree,
   and the push is the one writer of the remote cache.
3. A **body or title edit** re-runs the fast checks only (the ownership gate reads the body).
4. `OSS export` skips the cold build on a pull request; the queue and the push keep it.
5. `CI Windows unit` drops its push trigger (a Windows minute costs twice a Linux one).
6. `journey-live`, `install-live` and `isolation` run weekly, not nightly. `install-live` still runs
   after every `Publish packages`.

7. The file-ownership gate (`Owns globs:`) is removed: the changed files are visible in the diff, and
   it failed pull requests on bookkeeping (ADR-0018 is superseded in this respect).

`scripts/check-workflows.mjs` allows exactly one job-level `if` on the path-scoped jobs: the
queue-tier condition above.

## Amendment 2026-10-19 (second): cost from the failure data

Measured over 167 CI runs (about 12,400 job-minutes): Docker image jobs 27 %, coverage floors 19 %,
tests 15 %, docs claims 11.5 %; 21 of the 146 pull-request runs failed in `fast-checks`, and the
other jobs ran on regardless; the browser smoke ran 156 times and never failed; the 16-vCPU
`image-scan` ran on every change although a Trivy verdict depends on the Dockerfiles, the
dependencies and the base image, not on application source.

1. `cancel-on-fast-failure` and `cancel-on-build-failure` end the run at the first failed gate
   (`fast-checks`, `build`, `build-embedded`). They are separate jobs so the failed job stays red.
   `CI success` then reads cancelled, which also blocks the merge.
2. `image-scan` runs only for a diff that reaches an image input (Dockerfiles, any `package.json`,
   the lockfile, `infra/release`, `infra/images`, the Trivy and OSV allowlists); `release-images` only
   for a diff that reaches the runtime, gateway or egress-proxy build. New CVEs are caught by the
   weekly run below.
3. `ci.yml` gains a weekly `schedule` (Monday 02:37 UTC): a full run of `main` with every job and no
   path scope. It replaces the full push-to-`main` run removed above.
4. `browser` and `release-checks` move to the queue tier (never failing, respectively 2 of 156).

## Amendment 2026-10-19 (third): Docker layer cache

Every image build in CI started on a fresh VM with no layer cache, and the same dependency install
(`pnpm install` per engine, per image) ran again in `release-images`, each `image-scan` shard,
`generated-project-e2e` and `tool-sandbox-e2e`. These four jobs start Blacksmith's BuildKit builder
(`useblacksmith/setup-docker-builder`, pinned and allowlisted again) before their first build; its layer cache
lives on a sticky disk per `cache-key`, so the manifest-only dependency layers of the Dockerfiles are
reused and only the layers after a source change rebuild. If the builder cannot start the action
falls back to the default builder, so a cache outage only costs time. On `ubuntu-latest` (after the
temporary Blacksmith period) the action must be removed with the other Blacksmith labels.

## Amendment (2026-10-23): Linux CI on the self-hosted MS-A2 pool, off Blacksmith

Blacksmith was a stopgap while GitHub-hosted billing was blocked. Every Linux job now runs on the
organisation's own MS-A2 (32 threads, 28 GB, 1.6 TB NVMe), which is dedicated to CI and registered to
INDXDev as eight runners (`ito-MS-A2`, `ito-MS-A2-2` … `-8`, label `ms-a2`). This reverses Decision 1's
"never on a self-hosted runner" for Linux. Only the Windows jobs and the macOS install lane, which the
host cannot run, stay on Blacksmith.

1. **One label.** In the workflows `scripts/check-workflows.mjs` holds to a runner policy, every job
   reads `runs-on: [self-hosted, ms-a2]`; any other label, a vendor label or a variable is refused.
2. **A shared host, not a fresh VM.** Up to eight jobs share one Docker daemon and nothing is thrown
   away between jobs, so: PostgreSQL services publish a random host port (read from
   `job.services.postgres.ports` into `$GITHUB_ENV`); the S3, Azurite and GCS emulators are named per
   runner, take free ports and are removed when the job ends; each kind lane uses its own
   `KUBECONFIG` and deletes its cluster when it ends. The e2e harnesses name their Verdaccio and
   registry containers after `$RUNNER_NAME`, and each runner's `.env` gives it its own block of
   harness ports (`20000 + 100 × runner number`, e.g. `BD_NPM_PORT`, `BD_REGISTRY_PORT`,
   `GP_REGISTRY_PORT`, `JOURNEY_REGISTRY_PORT`), so two journeys never share a port, a container or
   (through the registry host in the tag) an image tag. On the host's kernel (7.0) a kind pod's
   memory limit is hit in the pod cgroup, so the isolation `memory-enforced` case also accepts the pod
   cgroup's `oom_kill` count as evidence.
3. **Nx cache key.** The service URLs now carry a per-job port, so `nx.json`'s `vitestConfig` hashes
   whether each service variable is set, not its value; a result computed without services is still
   never replayed for a run that has them.
4. **No VM housekeeping.** `.github/actions/free-disk`, the isolation and journey "Free disk" steps,
   the isolation `docker system prune` and `formal`'s swap file are skipped on `runner.environment ==
'self-hosted'`: the host has the room and its own swap, and the images belong to other jobs too.
5. **No Blacksmith builder.** `useblacksmith/setup-docker-builder` is gone (the third 2026-10-19
   amendment): the host daemon's own layer cache survives between jobs.

Security: the repository is internal and `pull_request_target` stays prohibited, so only branches
of organisation members run on the host. Host upkeep is the operator's, not a workflow's: each
runner has its own `HOME` (`HOME=<runner dir>/_home` in the runner's `.env`), because
`pnpm/action-setup` installs into `~/setup-pnpm` and concurrent jobs sharing one home broke each
other (`ETXTBSY`); the host carries the tools the hosted images ship (`build-essential`, `kubectl`,
`helm`, `az`, `pwsh`, Node 24 in `/usr/local` for `hashicorp/setup-terraform`'s wrapper, passwordless
`sudo` for the runner user) and a daily `docker system prune` timer.

Speed: the host keeps what a fresh VM throws away, so CI uses it. All runners share one pnpm store
(`pnpm_config_store_dir=~/ci-cache/pnpm-store`, content-addressed and safe for concurrent installs)
and one Playwright browser cache (`PLAYWRIGHT_BROWSERS_PATH`). The Linux jobs therefore drop
`actions/setup-node`'s `cache: pnpm`, which downloaded and re-uploaded a store tarball through the
GitHub cache on every job; the Windows jobs and the hosted `install-live` lanes keep it. Docker
layers persist in the host daemon, and each runner's checkout persists, so a fetch is incremental.

Build handoff: `build` and `build-embedded` copy their archives into `$AW_CI_HANDOFF_DIR/<run id>`
(`~/ci-cache/handoff`, set in each runner's `.env`) and still upload the GitHub artifact.
`.github/actions/workspace-build` unpacks the copy when it finds one, so the jobs behind `build` on
the host download nothing; a job without the variable (the Blacksmith jobs of the second amendment
below, or any other runner) downloads the artifact as before.
A cron job deletes handoff directories older than 12 hours.

Not done, on purpose: a persistent Nx local cache. ADR-0110 lets only `main` write the Nx cache,
and a pull request only read it. A local cache that outlives a job would let a pull request's
results be replayed by a later merge-queue or `main` run on the same runner.

Trust: a job on the host runs as the runner user with passwordless `sudo` and keeps nothing apart
from other jobs, so a job can tamper with what later jobs use (the pnpm store, the Docker
daemon, the handoff directory). That is accepted because only organisation members' branches run
here (internal repository, `pull_request_target` prohibited). The host must never take jobs from
forks or public repositories; the runners' group is the organisation's Default group, which
refuses public repositories.

## Amendment (2026-10-23, second): a few long jobs back on Blacksmith

Measured over 2026-10-21..23 (1,695 runs, 13,486 jobs): with every Linux job on the eight MS-A2
runners, a queue group's `CI` took 47 min at p50 (9 min on Blacksmith), a job waited up to 25-43 min
(p90) for a runner, and the shared host ran jobs 1.3-1.8x slower. All-Blacksmith cost about
$4,300 a month at that load. So the pool stays the default and only the jobs that hold a slot
longest per Blacksmith dollar leave it:

| Job                                     | Runner                         | MS-A2 / Blacksmith p50 | Blacksmith a month |
| --------------------------------------- | ------------------------------ | ---------------------- | ------------------ |
| `oss-export.yml` `OSS export · dry run` | `blacksmith-2vcpu-ubuntu-2404` | 7.1 / 1.2 min          | about $120         |
| `ci.yml` `formal`                       | `blacksmith-8vcpu-ubuntu-2404` | 10.1 / 5.5 min         | about $140         |
| `isolation.yml` `kind`, `kind-deploy`   | `blacksmith-4vcpu-ubuntu-2404` | 8-10 min either        | about $120         |

They free about 2,300 runner-minutes a day of the pool's 11,520.

The Docker E2Es move too, to `blacksmith-8vcpu-ubuntu-2404` (16 vCPU before 2026-10-23; about $490
a month at 8): `journey-e2e`, `docs-claims` and `tool-sandbox-e2e`. On the shared daemon they
failed the queue for reasons outside the change under test: the journey's Verdaccio port was taken
by another job between being picked and bound (`port is already allocated`, which `docs-claims`
hits through the same journey), and `tool-sandbox-e2e` uses one fixed Compose project and removes
every runtime and tool-host container on its daemon, so it needs a daemon of its own. The
`browser` smoke moves for the same reason (about $60 a month): Chromium aborted a navigation with
`net::ERR_NETWORK_CHANGED` when another job on the host added or removed a Docker network.

`scripts/check-workflows.mjs` allows the Blacksmith label on those five `ci.yml` jobs (`formal`,
the three E2Es and `browser`) only and still refuses it on any other job of the policy workflows.
Blacksmith runners also report `runner.environment == 'self-hosted'`, so the VM housekeeping of
point 4 above (free-disk, the Lean swap file, the isolation prune and free-disk steps) now keys on
the runner name (`!startsWith(runner.name, 'ito-MS-A2')`) and runs again on these jobs. These jobs
restore the workspace build from the `workspace-build` (and `embedded-build`) artifacts, so the
build handoff above keeps uploading them.

## Amendment 2026-10-24: Blacksmith minutes paid for nothing

Measured on the merge-queue and push runs of 2026-10-23, these Blacksmith minutes bought no
signal. Each is fixed here:

1. **The Lean cache never reached the queue.** `formal` saved `formal/.lake` from a merge-queue
   run, onto a `gh-readonly-queue/*` ref no later run can read, so every group restored the same
   week-old entry from `main` and rebuilt the same ~220 of 463 Lake jobs (about 5 of `formal`'s
   minutes), leaving 1 GiB per group behind (9 GiB, the whole repository cache). `formal` now
   only restores; a new `formal-cache` job on the push to `main` (Blacksmith, not required by
   `ci-success`) looks the commit's key up and, on a miss, builds incrementally and saves it where
   every group reads it. The Playwright cache of `browser` missed on every run for the same reason
   plus a lockfile-hash key; it is keyed by the `@playwright/test` version.
2. **Paid runners waited for `build-embedded`.** `journey-e2e` and `docs-claims` needed only
   `build`, so their four runners started ~3 min before the embedded artifact existed and spent
   ~100 s each polling for it. They now need `[build, build-embedded]`; `formal` still ends
   last, so the run is no longer.
3. **The OSS cold build ran twice per change.** `OSS export · dry run` built the filtered tree cold
   (11-15 min) in the merge queue and again on the push to `main`, whose tree is the group's. The
   push now runs the string, link and secret gates only; a release tag and a dispatch still build.
4. **The kind lanes ran twice per change.** `isolation.yml` ran `kind` and `kind-deploy` (~10 min
   each, `blacksmith-4vcpu`) on the pull request and again on the push. The push runs the docker
   lane only; the weekly schedule still runs every lane on `main`.

Considered and not done: `useblacksmith/setup-docker-builder` again for `tool-sandbox-e2e` (it
saved ~30 s of a 163 s image build on 2026-10-19..22, not worth a sticky disk), and the Windows
unit job (about 1.6 min a run).

## Amendment 2026-10-24 (second): the heavy tier leaves the merge queue

The merge queue ran every job of `ci.yml`, the Docker and end-to-end tier included, on every
queued change. The run data of 2026-10-10..24 says that bought little:

- 184 queue runs in 14 days (about 13 a day); 51 failed (28%) and 11 were cancelled.
- Of the 33 most recent failed runs, 21 (64%) passed when the same pull request was queued again
  with no new commit: a flake or the fault of another entry in the `ALLGREEN` group. Most of the
  other 12 were CI-infrastructure changes or a CVE published after the change (the trivy gate on
  #1811), not a defect the change introduced.
- A queue run took 11.0 min (median of the green runs) against 7.0 min for a pull request, and
  cost about $0.44 of Blacksmith minutes, about $170 a month, plus about 45 MS-A2 runner-minutes.

Decision. Four tiers (the COST note at the top of `ci.yml`):

1. **Pull request**: the inner loop, unchanged (fast checks, build, typecheck and lint, tests).
2. **Merge queue**: the same inner loop on the merged commit, plus `formal` and `image-scan` when
   the diff reaches what they read (their `scope` steps), so a Lean model that no longer matches the
   code, or an image input with a new finding, is still stopped before `main`.
3. **Nightly** (`schedule`, 02:37 JST, on `main`): the heavy tier — release checks and images,
   `generated-project-e2e`, `journey-e2e`, `docs-claims`, `tool-sandbox-e2e`, `coverage`,
   `browser`, and `formal` and `image-scan` unscoped. The OSS export's cold build and the security
   analysis also run nightly. A failed nightly opens or updates one issue per workflow
   (`nightly-alarm.yml`) with the run and the commit range since the last green nightly; the next
   green nightly closes it.
4. **Release**: `publish-packages.yml` and `images.yml` call `ci.yml` with `full: true` on the
   tagged commit and publish only after every tier passed. At about 1.2 tags a day this costs about
   $16 a month.

Estimated Blacksmith cost: about $30 a month (nightly about $14, release gate about $16) against
about $170, and about 10 MS-A2 runner-hours a day freed for pull requests.

Risks and their mitigations:

- **A break the heavy tier finds is already merged**, for up to 24 hours, among about 13 merges.
  The nightly issue names the commit range; a risky pull request still takes the label `ci:full`
  before its next push to run the heavy tier first.
- **The Lean model is tied to the code** (a change of the compiled environment needs a proof
  update), so `formal` stays in the queue whenever its scope applies.
- **A red nightly blocks releases**: the release gate runs the same jobs, so a release cannot
  ship a break the nightly found and nobody fixed.
- `ci-success` now accepts a skipped job in the queue as on a pull request and a push; the
  nightly, a dispatch and the release gate still need every job to succeed.
  `scripts/check-workflows.mjs` holds the two job-level gates (heavy tier, queue tier) to their text.

## Amendment 2026-10-25: typecheck, lint and the test shards leave the pool

With the heavy tier out of the queue, the pool's load is the inner loop itself, and it waits for
runners rather than running. Measured on 29 merge-queue groups of 2026-10-25: a group took 25-41 min
of wall clock while no job ran longer than 9 min; `build` waited about 6 min for a slot, the four
`tests · <shard>` jobs 8.4 min on average and `typecheck` and `lint` about 9 min, and those two jobs
start only after `build`, so the waits add up along the critical path. The test shards held 441 of
the about 880 MS-A2 runner-minutes those groups used (15 min a group), typecheck and lint another
122 (4 min a group).

Decision. `typecheck-lint` (two jobs) and `heavy-checks` (four shards) run on
`blacksmith-8vcpu-ubuntu-2404` for every event, and `scripts/check-workflows.mjs` adds them to
`OFFLOADED_JOBS`. They are the cheapest change that takes the largest share of pool demand off the
critical path: they need only `build`'s artifact and the Nx remote cache (both reachable from
Blacksmith, as `journey-e2e` already shows), and the per-runner container names and random ports
they use on the pool work unchanged on a VM of their own. `build`, `build-embedded` and the fast
checks stay on the pool, which now serves them and the other workflows' short jobs with about 64%
less inner-loop demand.

Cost: about 19 runner-minutes a run at MS-A2 speed, fewer on Blacksmith's unshared vCPUs; at
$0.016 a minute for 8 vCPU that is about $0.2-0.3 a pull-request or queue run. Over 2026-10-22..25
(274 pull-request and 183 queue runs in 3.5 days) the two jobs ran about 2,180 MS-A2 minutes a day,
which is about $700-1,050 a month on Blacksmith (the low end if they run 1.5x faster unshared).
Their queue wait was 13.6-15.2 min at p90 in the merge queue. Revert by setting
both `runs-on` back to `[self-hosted, ms-a2]` and removing the two ids from `OFFLOADED_JOBS`.

## Amendment 2026-10-26: the public export runs on GitHub-hosted runners only

The OSS export copies the workflow files byte for byte, so since the Amendment of 2026-10-23 the
public snapshot asked for `[self-hosted, ms-a2]` and Blacksmith labels: in a public repository a
self-hosted runner lets a fork's pull request run code on the Owner's host, and Blacksmith and the
live lanes (cloud providers, a real model, deployments) bill the Owner. A standard GitHub-hosted
runner is free on a public repository. Owner decision, 2026-10-26: nothing the public repository or a
fork can start may use a self-hosted runner, Blacksmith or anything else that costs money; this
repository stays on the MS-A2 pool.

Decision.

1. **One file, two runners.** A shared job's `runs-on` is
   `${{ github.repository_owner == 'INDXDev' && <internal runner> || '<hosted label>' }}`: the
   MS-A2 pool (or the job's Blacksmith label) here, `ubuntu-latest` or `windows-latest` anywhere
   else. `scripts/check-workflows.mjs` holds `ci.yml`, `quality.yml`, `security.yml`,
   `internal-checks.yml` and `ci-nx-cache.yml` to exactly that text, with `ubuntu-latest` as the
   fallback.
2. **Internal-only workflows never start elsewhere.** Every job of the workflows that spend money or
   reach the Owner's accounts (`azure-preview`, `ci-nx-cache`, `e2b-template`,
   `gcp-small-acceptance`, `install-live`, `journey-live`, `lightweight-journey`, `live-e2e`,
   `nightly-alarm`, `providers-live`, `terraform`) and `ci.yml`'s real-model `full-e2e` begin with
   `if: github.repository_owner == 'INDXDev'`, alone or `&&` one parenthesised condition, which
   `scripts/check-workflows.mjs` requires (`INTERNAL_ONLY_WORKFLOWS`). They stay in the export
   because its tests read them. This replaces disabling them by hand in the public repository.
3. **The export gate refuses a paid runner.** `scripts/oss/check-public-tree.mjs` reports
   `paid-runner` for any job of the public tree that is not behind that guard and whose runner, or the
   fallback of the expression above, is not a standard hosted label (`ubuntu-`, `windows-` or
   `macos-` with `latest` or a version, optionally `-arm`). Larger runners, self-hosted labels,
   Blacksmith, a matrix or a variable are refused. The check is shared with
   `scripts/check-workflows.mjs` in `scripts/ci/workflow-jobs.mjs`.

Consequence: a public pull request runs the inner loop on GitHub's 4-vCPU runners without the Nx
remote cache (its OIDC exchange accepts INDXDev only), so it is slower than here and costs nothing.

## Amendment 2026-11-05: the light jobs on GitHub-hosted runners, the builds on Blacksmith

The pool now serves mostly short jobs, and they wait for it. Over the last 30 `CI` runs on
2026-11-05, an MS-A2 job waited 4.6 min for a runner at p50, 12.8 min at p90 and 18 min at worst,
while it then ran about 1.5 min; a Blacksmith job waited 6-8 s. `fast checks`, `build` and
`build-embedded` sit at the head of every pull-request and queue run, so that wait is on the
critical path of every change. The Owner asked for the light jobs to go back to GitHub-hosted
runners and the heavy ones to stay on Blacksmith, as indx-everything#394 and indx-dev/.github#18
did on 2026-11-04.

Decision.

1. **Light jobs on plain `ubuntu-latest`.** `fast-checks`, `cancel-on-fast-failure`,
   `cancel-on-build-failure` and `ci-success` in `ci.yml`, and every job of `quality.yml`,
   `security.yml`, `internal-checks.yml`, `ci-nx-cache.yml` and `nightly-alarm.yml`. They check,
   call an API or summarise: 7 s to about 2 min, and they download their own pinned tools. The label
   is plain, with no override variable, as in #394, and it is also the public export's free label.
   `scripts/check-workflows.mjs` holds them to exactly that label (`HOSTED_JOBS`), and refuses
   `ubuntu-latest` on any other job of the policy workflows.
2. **The builds on Blacksmith.** `build` and `build-embedded` build the whole workspace; on a 2-vCPU
   hosted runner `build-embedded`'s webpack build alone took about 9 minutes (Amendment
   2026-10-16). They join `OFFLOADED_JOBS` on `blacksmith-8vcpu-ubuntu-2404`. The host handoff
   directory is not set there, so the jobs behind them download the `workspace-build` artifact.
3. **`ubuntu-latest` is Ubuntu 26.04 now.** It broke `actions/setup-python` for Python 3.12.8 in
   another repository. The light jobs here use Node and pinned downloads only; a job that needs a
   tool missing on 26.04 moves to a pinned label in its own pull request.
4. **Unchanged:** the nightly and `ci:full` heavy tier and the live lanes stay on the pool. With
   the light jobs and the builds off it, the Owner confirmed on 2026-11-06 that the pool is fine for
   them.

Revert: set the `runs-on` back to the pool expression and empty `HOSTED_JOBS`, and drop `build` and
`build-embedded` from `OFFLOADED_JOBS`.

## Amendment 2026-11-08: the test shards on the org runner group heavy-ci

By the Blacksmith bill, the four `tests · <shard>` jobs (`heavy-checks`) cost $18.22, the most of
any job of this repository. The Owner asked for the heaviest job to leave Blacksmith for the
organisation's own machines, as another repository of the organisation did the same day.

Decision. `heavy-checks` runs on the organisation's runner group `heavy-ci` with the labels
`[self-hosted, docker]`. The group holds the eight MS-A2 runners (x86_64) and the GX10's eight CI
runners (arm64); only the runners with a Docker daemon carry `docker` (the MS-A2 runners and the
GX10's `dgx-ci-docker`), because the job runs PostgreSQL and the object-store emulators. GitHub
hands each shard to whichever of them is idle. The job already published its services on random
host ports and named its containers per runner from its MS-A2 days (Amendment 2026-10-23), so it
needs one change for the GX10: pnpm is installed with setup-node's npm into the runner's own temp
directory, not by pnpm/action-setup, whose self-installer runs the runner's bundled npm (broken on the
GX10's runners) into `~/setup-pnpm`, one directory for runners that share one home. `scripts/check-workflows.mjs` moves the job from `OFFLOADED_JOBS` to
`HEAVY_CI_JOBS`, which holds it to exactly the group's expression (still `ubuntu-latest` outside
INDXDev). Only this job goes to the group: the hosts' cores, not money, limit how many jobs run at
once, so they take the one that costs most.

Revert: set `heavy-checks`' `runs-on` back to the Blacksmith expression and move it back from
`HEAVY_CI_JOBS` to `OFFLOADED_JOBS`.

## Amendment 2026-11-10: fewer short Blacksmith jobs

The Owner asked to trim CI cost (about $50 on busy days). The Blacksmith bill for 1–9 November was
$253 for the whole organisation; this repository was $102 of it. Read from every job of that
period: 74% of the organisation's jobs finished in under two minutes, and whole-minute rounding
alone was about a fifth of the bill. Since Amendment 2026-11-08, the test shards no longer cost
Blacksmith money, so what is left here is mostly short jobs whose minutes are setup: checkout,
install and restoring the build. On 8–9 November, `typecheck · Nx task graph` and
`lint · Nx task graph` took a median 53 s and 80 s, each on its own 8-vCPU runner, and
`formal · warm the Lean cache on main` took a median 8 s on 8 vCPU, because most pushes find their
cache entry and stop.

Decision.

1. **`typecheck-lint` is one job, not a matrix of two.** Typecheck and lint run one after the other
   on one 8-vCPU runner with `--parallel=4` (each had `--parallel=2` on its own runner), so the
   setup is paid once and rounded up once. Every check in the job runs when the build was restored
   and the run was not cancelled, whatever an earlier check answered, so a red typecheck still
   reports lint and the job fails if any check failed. `ci-success` needs the same job id.
2. **The Lean cache lookup on main runs on the smallest Blacksmith runner.** `formal-cache-lookup`
   (`blacksmith-2vcpu-ubuntu-2404`) looks up the commit's entry; `formal-cache` (8 vCPU, unchanged
   build) starts only on a miss. Both stay on Blacksmith, whose runners read Blacksmith's cache.
   Neither is required by `ci-success`.

Estimate from the same data: about $1.5 a day off this repository on a busy day, most of it from
item 1. Not changed, and why:

- **The `aw-cli` and `rest` test shards stay separate.** They run on `heavy-ci` (Amendment
  2026-11-08), which costs no Blacksmith money; merging them would only lengthen the run.
- **`formal` in the merge queue keeps its 8-vCPU runner even when its scope step skips the
  build.** A required job may not be skipped at job level, and choosing the runner before the job
  starts needs the diff in another job first. That is a larger change than this one, for about
  $0.45 a day.

Revert: restore the `target: [typecheck, lint]` matrix and its `${{ matrix.target }}` commands,
and fold `formal-cache-lookup` back into `formal-cache` as its first step.

## Amendment 2026-11-19: task-based affected, `production` inputs, and a cancel that spares main

Measured on 2026-11-19. `main` push and the nightly were red on every run: `fast-checks`' strict
osv-scanner gate reported two Next.js advisories (GHSA-mfr8-8qww-v76h, GHSA-vc7v-qv4w-wrv8, fixed
in 16.4.5) and a picomatch advisory since withdrawn (GHSA-fc5q-39xc-vjpf), and
`cancel-on-fast-failure` then cancelled `build`, so `main` never wrote the remote cache and the
nightly heavy tier never ran. Separately, `nx.json` set `affected.legacy: true` and every target read
`default` and `^default`, so a test-only or README-only change re-ran every target of every
dependent project.

Decision.

1. **Next.js is 16.4.6** in every workspace, example app and the app kit's generated pin; the
   osv baseline stays empty (osv-scanner 2.7.0 on the new lockfile: nothing blocking).
2. **`cancel-on-fast-failure` runs only for `pull_request` and `merge_group`.** Elsewhere the run
   finishes and `CI success` still fails on the red `fast-checks`; no gate is weakened, only the
   cancel is narrowed. `scripts/check-workflows` holds the condition.
3. **Task-based affected.** `affected.legacy` is gone. `nx.json` adds two named inputs:
   `production` (a project's files minus its root Markdown, `docs/`, test and test-support files,
   snapshots and Vitest configs; Markdown below the root stays, because the SDK ships its
   templates' README files) and `code` (everything but Markdown and `docs/`). `build` reads
   `production` and `^production`; `typecheck` and `lint` read `code` and `^production`; `test`
   reads `default` and `^production`. Two projects keep a wider set on purpose: the root project's
   `test` reads `default` and `^default` (its docs-truth, architecture and inventory tests read
   Markdown and other projects' test files), and embedded's `build` keeps its own `default` (its
   `publish/` copies README.md and CHANGELOG.md).
4. **`node --test scripts/ci/nx-affected.test.mjs`** runs in `fast-checks` and asserts, through
   `nx affected --explain` (which runs nothing), the selection for a docs-only, a README, a
   test-only, a root-test, a shipped-Markdown, a source and an `nx.json` change.

Measured selection (`nx affected -t build typecheck lint test --explain`, 94 tasks in the graph;
before = the old inputs, which select the same projects legacy affected did):

| change                                       | before                         | after         |
| -------------------------------------------- | ------------------------------ | ------------- |
| `docs/40-operate/operations/ci.md`           | 3 (root typecheck, lint, test) | 1 (root test) |
| `packages/sdk/README.md`                     | 39                             | 2             |
| `packages/contracts/src/a2a.test.ts`         | 86                             | 4             |
| `packages/sdk/src/project/templates.test.ts` | 39                             | 4             |
| `packages/contracts/src/index.ts`            | 86                             | 86            |

The `heavy-checks` shard list (`nx show projects --affected --with-target test`) follows: 22
projects before and 2 after for the contracts test-file change, 10 and 2 for the SDK README.

Not changed: a docs-only change still runs the root project's tests, because they read `docs/`;
it stops doing so only when the docs-reading tests leave the root Vitest project.

Revert: put `"affected": { "legacy": true }` back in `nx.json`, set every target's inputs back to
`default` and `^default`, and drop the `if:` event condition from `cancel-on-fast-failure`.

## Amendment 2026-11-19b: a `plan` job skips the Nx jobs a change does not reach

Measured on 2026-11-19 (GitHub API job and step timings of the last 17 successful pull-request and
queue runs of `ci.yml`, p50). Every code run started all eight Nx job runners whatever the diff
reached: `build` (62 s, Blacksmith), `build-embedded` (143 s, Blacksmith), `typecheck-lint` (131 s,
Blacksmith) and four test shards (tests 479 s, web-core 96 s, aw-cli 66 s, rest 65 s, heavy-ci). A
shard with no affected project still started a runner, its PostgreSQL service and its install
(43-56 s of setup and restore) to print "no test project". `build-embedded` built webpack on every
docs-only pull request (run 44221023023: 82 s, a remote-cache miss).

Why embedded missed the cache on a docs-only change: not its inputs. Its build hash is identical
before and after a docs-only commit (`@indx-workspace/embedded:build` 9027422779502410240 at both
a6483e245 and 094cec10e, computed with Nx's own task hasher on `origin/main`'s inputs; the
`production` inputs above remove docs/ and test files from it further). The entry was never written:
every push to `main` was cancelled about 40 s in (the amendment above), before webpack finished (push run
44223305848: `build-embedded` replayed its 20 dependencies by 02:27:17 and was cancelled at
02:27:33, 15 s into a 73-106 s webpack build), and a pull request or queue group may only read. The cancel fix in the amendment above is what lets `main`
write it. Separately, the heavy-checks shards never restored embedded's build (`embedded` defaults to
`'false'`; their restore now says so and `scripts/check-workflows` requires it): the 69-72 s their
restore takes on the heavy-ci runners is the download of the 30 MB `workspace-build` artifact
(run 44223711131, `tests · tests`: 02:32:01 to 02:33:10).

Decision.

1. **A `plan` job runs first** (GitHub-hosted, in `HOSTED_JOBS`; it needs no other job). It installs
   only the root workspace (`pnpm install --filter . --ignore-scripts`: 484 MB of `node_modules`
   against 1.8 GB, 15.7 s against 40.8 s from a cold store on the development host, with the same
   `nx affected` selection on five sample changes) and runs `scripts/ci/ci-plan.mjs`: one
   `nx affected -t build typecheck lint test --explain` (2.7-3.0 s locally, no task runs) for a pull
   request or a queue group. It outputs `build`, `build-embedded`, `typecheck-lint` and
   `heavy-checks` (`true`/`false`) and the `heavy-checks` matrix.
2. **The four Nx jobs run only when the plan says so.** `typecheck-lint` when a typecheck or lint
   task is reached (its repository-wide checks read only Nx `code` inputs); `build-embedded` when one
   of embedded's tasks is; `build` when any other task is, and whenever `typecheck-lint` or
   `heavy-checks` is planned, because both have `needs: [plan, build]` and a skipped need would skip
   them (embedded's own typecheck or lint alone would otherwise plan `typecheck-lint` without
   `build`, and `CI success` would fail the skipped job the plan named).
   `scripts/ci/ci-plan.test.mjs` reads the `needs:` of the planned jobs from `ci.yml` and checks
   that every planned job's planned needs are planned too. `formal` is no input of the plan: it
   left the queue for the full tier (Amendment 2026-11-19c), which always builds. The test shards are
   `TEST_SHARDS` in that script, with `rest` as "every other test project"; a shard with no affected
   project gets no matrix leg. A push to `main` builds both and runs nothing else (as before); the
   nightly, a dispatch, a `ci:full` pull request and the release gate run everything.
3. **`CI success` accepts a skipped `build`, `build-embedded`, `typecheck-lint` or `heavy-checks`
   only where the plan's output for that job is `false`**, or on a body/title edit (which skips the
   plan as it already skipped the builds). `plan` is a need of `CI success` and must succeed. No
   other skip rule changes. `scripts/ci/ci-success.test.mjs` runs the gate script from `ci.yml`
   against fixed `needs` contexts (a planned job skipped while its plan said `true` fails on a pull
   request, a push and in the queue alike); `scripts/check-workflows` requires each job's `if:`, the
   plan's outputs and the skip rule.

Replayed over the last 30 commits on `main` (each commit's files through the plan, this branch's
inputs): `build` 30 of 30, `typecheck-lint` 30 of 30, `build-embedded` 18 of 30 (before: 30), test
shard runners 60 (before: 120). That replay predates the `tests/` split (Amendment 2026-11-19f).
With it, `scripts/ci/ci-plan.test.mjs` asks Nx for two docs-only shapes: a document a test reads
(`docs/40-operate/operations/runbook.md`) plans `build` and one shard leg (`tests-docs`), no
`build-embedded` and no `typecheck-lint`, so it still starts one Blacksmith job and one test runner;
a document no test reads plans no Nx job, leaving `fast-checks`, `plan` and `CI success`.

The cost: `build` now starts after the plan. Not measured in CI (this change has not run there); its
parts measured on hosted runners in `fast-checks` are checkout with full history 9-11 s, pnpm and
Node setup 6 s and the full install 23-26 s, which the root-only install shortens.

**The programme's wall-clock targets are not shown to be met.** None of them has an after-number
measured in CI, because this change has not run there: a docs-only pull request in at most 2 min
(the first shape above still runs `build` and a `tests-docs` leg, and `fast-checks` alone is
estimated at about 110 s from local runs, Amendment 2026-11-19d), a code pull request's p50 in at
most 3 min, and a merge-queue group in at most 3 min (Amendment 2026-11-19c gives only the
before-numbers). The numbers in these amendments are local measurements and projections from them,
labelled as such. `.github/workflows/ci-budget.yml` checks the real numbers weekly against the
targets in `docs/40-operate/operations/ci-budget.md` and opens "CI over budget" until they are met;
re-measure from the first week of runs and record the after-numbers there.

Not adopted: **merging `build` and `typecheck-lint` into one job.** Measured p50: `build` 62 s with
14 s of setup; `typecheck-lint` 131 s, of which 19 s setup and restore and 111 s the checks; 7 s from
`build`'s end to `typecheck-lint`'s start. Merged, the typecheck and lint result would arrive about
26 s sooner and save one runner's setup, but every job that needs `build` (the test shards, `formal`,
the heavy tier) would wait the further 111 s, or poll for the artifact, and a lint failure would make
`build` red and cancel the run (`cancel-on-build-failure`) before the tests report. Not faster where
it matters, so the two stay separate.

Revert: delete the `plan` job and `scripts/ci/ci-plan.mjs`, give `build` and `build-embedded` back
`if: github.event.action != 'edited'`, `typecheck-lint` and `heavy-checks` back
`(github.event_name != 'push' || inputs.full) && github.event.action != 'edited'` with
`needs: build`, restore the static shard matrix with its in-step project selection, and restore
`CI success`'s single tier rule.

## Amendment 2026-11-19c: the merge queue runs the pull request's set; `formal` and `image-scan` join the heavy tier

Decided by: the Owner (decision D2, plan A, of the CI speed and cost programme, 2026-11-19): a pull
request runs the static checks and the affected typecheck, lint and tests; a merge-queue group runs
the same set, mostly as a replay of the remote cache the queued pull request wrote (ADR-0110,
Amendment 2026-11-19, decisions D1 and D1b); the nightly runs the heavy tier.

Measured on the last 30 `merge_group` runs of `ci.yml` (GitHub API job timings, 2026-11-05 to
2026-11-18): run wall mean 647 s, p50 about 569 s. `formal` and `image-scan` were the only jobs a
group ran that a pull request does not; every group started their four runners (one Blacksmith
8-vCPU `formal`, three MS-A2 trivy shards) whatever its diff reached, 276 runner-seconds per group on
average. In 3 of the 30 groups the image scope applied, and the longest trivy shard took 365, 413
and 1164 s, the critical path of those groups.

Decision.

1. `formal` and `image-scan` take the heavy tier's job-level gate (the nightly, a dispatch, a
   `ci:full` pull request, the release gate `full: true`). Within that tier both still scope by path
   against a diff base, which only a `ci:full` pull request has, and run in full otherwise.
2. `CI success` is unchanged in code: it already accepts a tier skip on a pull request, a push and in
   the queue, never on the nightly, a dispatch or the release gate. Its comment now names these two
   jobs. `scripts/check-workflows` holds both to the heavy-tier gate alone, so neither can be gated
   back into the queue (`tests/tooling/workflow-scoped-jobs.test.ts`).
3. The `plan` job no longer builds for `formal` (Amendment 2026-11-19b, point 2): only a full run
   reaches `formal`, and a full run always builds. `scripts/ci/ci-plan.mjs` drops that input.

Where each guarantee now holds:

| Guarantee                                                                     | Before                                            | Now                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| No published image carries a finding `infra/release/trivy-gate.sh` stops      | the queue (scoped), the nightly, the release gate | the release gate (`images.yml` calls `ci.yml` with `full: true` before it publishes), the nightly                          |
| A dependency or Dockerfile change that adds such a finding is seen            | before merge, in the queue                        | at the next nightly (02:37 JST), which opens or updates the alarm issue (`nightly-alarm.yml`); before merge with `ci:full` |
| The Lean model, its generated artefacts and vectors agree with the TypeScript | the queue (scoped), the nightly, the release gate | the nightly, the release gate (`publish-packages.yml` and `images.yml`), `ci:full`                                         |

The accepted cost is detection time: a change that breaks either check lands, and the next nightly
finds it within a day and before any release. Both release paths still require the two jobs. The
nightly must be green, and get past `fast-checks`, for this to hold: on 2026-11-19 osv-scanner's
strict push/schedule run failed it every night (`next` 16.4.3, fixed by the bump to 16.4.6 in this
change; `picomatch` 4.0.7, GHSA-fc5q-39xc-vjpf, still open at this amendment), and since the
2026-11-19 amendment above a red `fast-checks` no longer cancels the nightly's heavy tier.

Revert: put `github.event_name == 'merge_group' || ` back in front of the two jobs' gates, restore
`QUEUE_TIER_CONDITION` for `formal` in `scripts/check-workflows/scoped-jobs.mjs` and the `formal`
input of `scripts/ci/ci-plan.mjs`.

## Amendment 2026-11-19d: `fast-checks` runs `docs:check` beside its other gates and caches what it can prove

Context. `fast-checks` was the floor of every pull request's wall clock, docs-only ones included: 201.8 s
on average over the last 31 successful jobs (GitHub API step timings, 2026-11-18/19), of which
`pnpm docs:check` took 80.1 s, `pnpm format:check` 64.5 s and the install 23.1 s, one after another on a
2-vCPU GitHub-hosted runner. The gitleaks and osv-scanner downloads took 0.9 and 2.2 s (their 504
bursts, not their size, are the reason to cache them).

Decision.

1. `scripts/docs/generate-api-reports.mjs` builds one TypeScript program per package (an API
   Extractor `CompilerState` shared by every entry point) instead of one per `exports` subpath: 66
   programs became 5. The 66 reports are byte-identical. Measured locally pinned to two CPUs
   (`taskset -c 2,3`): `pnpm docs:check` 86.5 s before, 53.8 s after.
2. `docs:check` starts in the background as soon as the install is done; the step "Generated SDK
   reference and llms.txt are current" waits for it, prints its log and exits with its status.
   `scripts/check-workflows` refuses a `fast-checks` that starts it without that wait
   (`tests/tooling/workflow-job-graph.test.ts`). A step that fails earlier still ends the job red.
3. `pnpm format:check` runs with Prettier's own cache (`--cache --cache-strategy content`), restored
   from the entry the last push to `main` saved (key: lockfile and `.prettierrc.json` hashes, then the
   commit). Prettier records only a file that passed, keyed by its content, and a new Prettier
   version or option invalidates every entry; both were checked by hand (a misformatted file fails
   with a warm cache, twice; `--print-width 40` against a warm cache fails 124 files). Only a push to
   `main` saves, so a pull request or a queue group never hands an entry to another run.
4. The gitleaks and osv-scanner release files are kept in `actions/cache` under a key naming both
   versions and SHA-256 prefixes, and are checked against the pinned SHA-256 after every restore,
   as after a download. A download lands under a temporary name, a file that fails its checksum is
   deleted, and the cache is saved only when both files are present.

Measured, pinned to two CPUs, the gates after the install (dedupe, the plan and gate tests, format,
migrations, docs, stories, licence): 173.5 s and 168.5 s before, 69.6 s and 69.9 s after with a warm
Prettier cache, 109.9 s with a cold one. The job's estimate on CI is therefore about 110 s (41 s of
check-out, pre-install gates, Node and install, then about 70 s), against 201.8 s before; the 90 s
target is not reached, because the install and `docs:check` itself remain. Re-measure from the first
week of runs.

No gate moved, was removed or was made conditional: every step of `fast-checks` runs on the same
events as before, and `CI success`'s conditions are unchanged.

Revert: run `pnpm docs:check` as an ordinary step again and drop the start step and the new
`scripts/check-workflows/ci-jobs.mjs` rule; drop the cache flags from the Formatting step and the
four cache steps.

## Amendment 2026-11-19e: the peripheral workflows leave the pull request or narrow to their paths; Dependabot weekly and grouped; a weekly budget check

Decided by: the Owner (decisions D3, point 2, and D6 of the CI speed and cost programme,
2026-11-19): the Isolation kind lanes and the journey workflow leave the pull request (to the merge
queue, the nightly or narrower paths); `quality.yml`, `security.yml` and `internal-checks.yml` are
folded into `fast-checks` or narrowed; the required `OSS export · dry run` keeps reporting;
Dependabot runs weekly, grouped, without bursts; the workflow-YAML assertions move from Vitest into
`pnpm workflows:check`.

Measured, GitHub API job timings, runs created 2026-11-12 to 2026-11-19 (seven days, 105 squash
merges on `main`):

| Workflow · job                               | Event               | Runs      | Mean                 | Runner minutes          | Starts after this amendment                                              |
| -------------------------------------------- | ------------------- | --------- | -------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `isolation.yml` · kind lane                  | pull request        | 31        | 463 s                | 239 (Blacksmith 4-vCPU) | never; on the push to `main` instead (11 isolation pushes in the window) |
| `isolation.yml` · kind-deploy lane           | pull request        | 31        | 500 s                | 258 (Blacksmith 4-vCPU) | never; on the push to `main` instead                                     |
| `journey-live.yml` · build-to-deploy journey | pull request        | 169       | 46 s                 | 131 (MS-A2)             | only on a pull request under its paths                                   |
| `journey-live.yml` · platforms journey       | pull request        | 169       | 33 s                 | 94 (MS-A2)              | only on a pull request under its paths                                   |
| `security.yml` · dependency-audit            | pull request        | 184       | 40 s                 | 123 (hosted)            | never (push and nightly keep it: 107 + 7 runs, 76 min)                   |
| `quality.yml` · Helm lint and render         | pull request + push | 183 + 108 | 12 s                 | 56 (hosted)             | only under `infra/helm/**`                                               |
| `internal-checks.yml` · internal checks      | pull request + push | 184 + 107 | 15 s (16-run sample) | about 73 (hosted)       | only under the internal wave plans and its checker                       |

Of the 105 merges, 8 touched `isolation.yml`'s paths, 4 `journey-live.yml`'s new filter, 0
`infra/helm/**`, 0 the wave plans and 1 `pnpm-lock.yaml` (`git log --name-only`; over 14 days: 33,
12, 1, 1 and 3 of 225). The 31 pull-request kind runs came from fewer pull requests than that,
each push to one restarting both lanes; the 11 push runs of the window would have cost
11 × (463 + 500) s, about 177 Blacksmith minutes, against the 497 the pull requests spent. That
projection, and the others in this table, are to be re-measured from the first week of runs
(`ci-budget.yml`, decision 8).

Decision.

1. **Isolation.** The `kind` and `kind-deploy` lanes run `if: github.event_name != 'pull_request'`:
   on the push to `main` that merges a change under `isolation.yml`'s paths (the push trigger
   already carries them), on the weekly schedule and on a dispatch, which can name any ref. A pull
   request still runs the `docker` lane (one minute on the pool). The merge queue was considered and
   not taken: `Isolation` is not a required check, so a red group run would block nothing and only
   repeat what the push does a few minutes later. `nightly-alarm.yml` now watches `Isolation` and
   acts on its push and schedule runs on `main`: a red one opens or updates the issue "Isolation on
   main failed" with the commit range since the last green run, a green one closes it.
   `scripts/check-workflows/peripheral.mjs` holds both lanes to that condition and the alarm to
   watching them.
2. **journey-live.yml.** Its `pull_request` trigger carries `paths`: the union of the scope patterns
   of `build-deploy-journey` and `platforms-journey`, the only jobs that run on a pull request. Each
   job keeps its own scope step. An unrelated pull request no longer starts two MS-A2 jobs that
   check out the full history and free disk before they skip. `scripts/check-workflows` refuses the
   workflow when an alternative of either scope pattern is missing from the path filter, so the two
   lists cannot drift.
3. **quality.yml** (the Helm lint and renders) runs on a pull request and a push only when
   `infra/helm/**` or the workflow changes; **internal-checks.yml** (the wave-plan ownership gate)
   only when the internal wave plans, `scripts/check-wave-ownership.mjs` or the workflow changes. Each
   job reads nothing else. Neither was folded into `fast-checks`: a path filter starts no runner at
   all, where a step in `fast-checks` would add the Helm setup or a second Node set-up to every
   required run.
4. **security.yml.** `dependency-audit` (`pnpm audit --audit-level high` and the licence inventory)
   no longer runs on a pull request. On a pull request it audited the whole lockfile against that
   day's advisories, so it answered for `main`, not for the change, and it was never required. A pull
   request that changes `pnpm-lock.yaml` (or `.osv-baseline.json`) gets the strict osv-scanner step of
   `fast-checks`, which is required; the push to `main` and the nightly run the audit as before.
   `ghas-skipped-notice`, `dependency-review` and `codeql` keep their triggers. `security.yml` and
   `internal-checks.yml` gain the concurrency group the other pull-request workflows have, cancelling
   only a pull request's superseded run.
5. **The required checks.** `OSS export · dry run` (`oss-export.yml`) and `CI success` (`ci.yml`) are
   unchanged and run on every pull request, queue group and push. A new rule in
   `scripts/check-workflows/workflow-rules.mjs` refuses `paths`, `paths-ignore` or `branches-ignore`
   in the triggers of any workflow that produces a required check. `windows-unit.yml` keeps its path
   filter (it is not required).
6. **Dependabot.** Weekly on Monday 06:00 JST for both ecosystems; npm keeps its production and
   development groups and gains a `security-updates` group, GitHub Actions gets one group;
   `rebase-strategy: disabled`. On 2026-11-11 the unscheduled run opened six pull requests within
   14 minutes (two npm groups and four single action bumps), and every automatic rebase of an
   open one is a force-push that starts a full CI run and, through the pull request's concurrency
   group, cancels the run before it; the merge queue tests the merged commit, so a Dependabot branch need not be current. A GitHub Actions
   bump still needs its new SHA in `approvedActions`, as before.
7. **The workflow-YAML tests** (D3, point 2). The tests that asserted the real workflow files move
   into `pnpm workflows:check`, which `fast-checks` already runs first (`scripts/check-workflows/tree-rules.mjs`);
   the checker's own unit tests stay, and a new `tests/tooling/workflow-tree-rules.test.ts` holds each
   moved rule and each new rule of this amendment to a fixture it accepts and one it refuses:

   | Removed test                                                                                                                                       | Where the guarantee now holds                                                                                                          |
   | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
   | `tests/actionlint-config.test.ts` "lists every self-hosted and vendor label the workflows use"                                                     | `checkActionlintLabels` in `tree-rules.mjs`, run by `pnpm workflows:check` against `.github/actionlint.yaml`                           |
   | `tests/actionlint-config.test.ts` "reads labels from every runs-on form" (a unit test of the parser)                                               | kept, as `workflow-tree-rules.test.ts` "reads labels from every runs-on form" against `customRunnerLabels`, plus the runner-group form |
   | `tests/tooling/workflow-aw-build.test.ts` "build @indx-workspace/platforms alongside aw"                                                           | `checkAwBuildsPlatforms` in `tree-rules.mjs`                                                                                           |
   | `tests/tooling/workflow-cloud-run-env.test.ts` "never passes a --set-env-vars list"                                                                | `checkCloudRunEnv` in `tree-rules.mjs`                                                                                                 |
   | `tests/tooling/workflow-cloud-run-env.test.ts` "keeps --update-env-vars to one NAME=value pair without a delimiter"                                | `checkCloudRunEnv` in `tree-rules.mjs`                                                                                                 |
   | `tests/tooling/workflow-cloud-run-env.test.ts` "deploys the IAM probe from an env-vars file and claims PERMISSION_DENIED only when gcloud said it" | `checkPreviewIamProbe` in `tree-rules.mjs` (also refuses the step going missing)                                                       |

   The mutation tests of `ci.yml` in `tests/tooling/workflow-{entrypoints,job-graph,neutralisation,runners,scoped-jobs}.test.ts`
   are unit tests of the checker (each refuses a mutated copy) and stay. `tests/tooling/workflow-cloud-run-preview.test.ts`
   stays too: most of its 41 cases run the preview workflow's shell steps or `tests/apps/app-image.mjs`,
   which is behaviour, not YAML.

8. **The weekly budget check.** `ci-budget.yml` runs every Monday (09:23 JST) and on a dispatch, on
   GitHub's `ubuntu-latest`, INDXDev only (`INTERNAL_ONLY_WORKFLOWS`):
   `node scripts/ci/metrics/report.mjs --days 7 --check --budget docs/40-operate/operations/ci-budget.md`. Exit 1
   (a ceiling exceeded) opens or updates the issue "CI over budget" with the offending rows, as
   `nightly-alarm.yml` does; exit 0 closes it; exit 2 (the report could not be produced) fails the
   run and leaves the issue alone.

Where each guarantee now holds:

| Guarantee                                                                                                      | Before                                                              | Now                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A change under `isolation.yml`'s paths keeps kind-cluster isolation and the chart under default-deny           | every pull request push touching those paths (kind, kind-deploy)    | the push to `main` that merges it, the weekly schedule and a dispatch; a red run opens "Isolation on main failed". The docker lane still runs on the pull request |
| The build-to-deploy and platforms journeys pass for a release or platforms change                              | the pull request (each job's scope step), the weekly schedule       | unchanged: the path filter is the union of the scope patterns, which `scripts/check-workflows` enforces                                                           |
| The Helm chart lints and renders its four shapes                                                               | every pull request and push                                         | every pull request and push that changes `infra/helm/**` or the workflow, which is every change that can alter the render                                         |
| The wave plans declare disjoint ownership                                                                      | every pull request and push                                         | every pull request and push that changes the internal wave plans, the checker or the workflow                                                                     |
| No high advisory in the dependency tree                                                                        | `pnpm audit` on every pull request (not required), push and nightly | push and nightly (`pnpm audit`); a lockfile change on a pull request: the strict osv-scanner step of `fast-checks` (required)                                     |
| A required check always reports                                                                                | convention                                                          | `scripts/check-workflows` refuses a path or branch filter on its workflow                                                                                         |
| Runner labels are known to actionlint; aw builds with platforms; Cloud Run environment avoids delimiter splits | Vitest (`tests/`)                                                   | `pnpm workflows:check` in `fast-checks` and `pnpm check:fast`                                                                                                     |

`CI success`'s conditions are unchanged: no `ci.yml` job moved, and none of these workflows is one of
its needs. The accepted cost is detection time for the kind lanes: a change that breaks them merges
and the push run finds it minutes later, before any release that the weekly run or a dispatch has
not covered.

Revert: put `if: github.event_name != 'push'` back on the two kind lanes and drop `Isolation` from
`nightly-alarm.yml`; drop the `paths` lists from `journey-live.yml`, `quality.yml` and
`internal-checks.yml` and the `if` from `dependency-audit`; restore `.github/dependabot.yml`; delete
`ci-budget.yml`; restore the three test files and drop `tree-rules.mjs`, `peripheral.mjs` and the
required-check filter rule.

## Amendment 2026-11-19f: the root `tests/` tree is Nx projects with declared inputs; slow suites, duplicates and static checks

Decided by: the Owner (decisions D2 and D3, points 1, 3 and 4, of the CI speed and cost programme,
2026-11-19). Four parts: the split of `tests/` into Nx projects (part 1, programme items A2 and B1),
the slow suites and the real waits (part 2, items B2 and B3), the duplicates deleted and the
committed-tree assertions moved into static checks (part 3, item B4), and what integrating the
units into one change added (part 4).

### Part 1: `tests/` is split into Nx projects with declared inputs

#### Context

The root `package.json` gave the root project `agent-workspace` `implicitDependencies: ["*"]`, and
that project owned the whole `tests/` tree through a `test` target running
`vitest run --project tests`. So:

- every change reached `agent-workspace:test` — a typo in a document, a changes fragment, a
  workflow edit — and the task ran all 261 files of the `tests` project;
- those 261 files ran one at a time (`fileParallelism: false`), because two of them start
  `next dev` against `apps/web` and Next 16 refuses a second dev server for one directory.

Measured before the change (`nx show projects --affected --files=<f> --with-target test`, Nx
24.0.3, on `origin/main` 9b2bdb23e): for each of `docs/40-operate/operations/runbook.md`, an ADR,
`changes/README.md`, `.github/workflows/ci.yml`, `scripts/check-workflows.mjs`, a file under
`tests/docs/`, `tests/gallery/` or `tests/formal/`, and the root `README.md`, the selection was
`agent-workspace` — all 261 files.

#### Decision

1. **`tests/` is eight Nx / Vitest projects**, listed once in `tests/projects.mjs`:
   `tests-docs`, `tests-tooling`, `tests-store`, `tests-gallery`, `tests-conformance`,
   `tests-formal` (one directory each), `tests-next` (`tests/auth.test.ts` and
   `tests/no-route-answers-503.test.ts`, the two `next dev` suites, configured from `tests/next/`)
   and the remainder, which keeps the name `tests` so `vitest run --project tests <file>` still
   selects every file left in it. Each has a `project.json` whose `test` target runs
   `vitest run --project <name>` with the JSON report at `<project root>/.vitest-report.json`.
2. **The root project has no `implicitDependencies` and no `test` target.** Each `tests` project
   lists `!agent-workspace` in its `implicitDependencies` (and `!tests` where it imports a helper the
   remainder owns), so a relative import of a root-owned script does not make every root file an
   input; the files it really reads are declared one by one as `{workspaceRoot}/…` inputs.
3. **`pnpm test-inputs:check` proves the inputs** (`scripts/policy-check-test-inputs.mjs`, in
   `check:fast`): a static scan of every file a project's tests import (transitively, through
   `tests/`, `scripts/`, `examples/` and other non-package files) and of every path literal they
   name — `new URL(…, import.meta.url)`, the literal segments of `join(…)`, strings and template
   heads whose first segment is a top-level entry, and a bare top-level directory name passed
   straight to a call (`tracked('apps')`) — must be covered by the project's inputs, by Nx's own
   import edge to a package (`^default`), or by an explicit implicit dependency. It also fails when a
   test file under `tests/` is collected by no project or by two. Its header states its limits: a
   path built from a non-literal at the call site, a read made by a child process (`next dev`,
   `tsc`, a spawned script), and build output are not seen; a path in a temporary directory the test
   made (`mkdtemp` / `tmpdir()` and anything joined from it) is deliberately ignored. Over-reporting
   is resolved by declaring the input, never by an exception list.
4. **Every project but `tests-next` runs its files in parallel.** `tests-next` keeps
   `fileParallelism: false`, its Nx target sets `VITEST_MAX_WORKERS=1` (the variable overrides
   `fileParallelism`, nx.json `//workers`) and `parallelism: false` (Nx runs no other task beside
   it), and its Vitest `sequence.groupOrder` is 1, so in `pnpm test` — one Vitest process over every
   project — it starts only after every other project has finished: its route fixtures under
   `apps/web/app` would otherwise be seen by the inventories that walk that tree.

   **The two suites keep a server each; one shared server is not safe.** The programme proposed
   a Vitest `globalSetup` that starts one `next` server for both. They test two different
   deployments. `tests/auth.test.ts` starts a server with neither a database nor OIDC, and asserts
   what that deployment answers (`POST /api/auth/token-exchange` → 503
   `token_exchange_not_configured`, `tests/auth-server-signin.ts`). The no-route probe needs a
   complete deployment: a migrated and seeded PostgreSQL, object storage, a master key and OIDC
   settings, and it asserts that no declared route answers 503. One server cannot be both without
   changing what one of the suites proves. `next build` + `next start` is also ruled out:
   `tests/auth-server-unregistered.ts` plants route files under `apps/web/app` while it runs and
   relies on the dev server picking them up, which a production build does not do. Running the
   two dev servers at the same time would need a separate `distDir` per server in
   `apps/web/next.config.ts`, which belongs to the web app, not to this unit.

5. **Pool and isolation stay Vitest's defaults (`forks`, `isolate: true`) in every project**, on
   the evidence of `vitest doctor` (Vitest 5.0.5) and a back-to-back A/B, all on a shared host at
   load average 50–110 on 20 cores:

   | project           | baseline | `pool: 'threads'` | `isolate: false` | doctor's recommendation |
   | ----------------- | -------- | ----------------- | ---------------- | ----------------------- |
   | tests-formal      | 4.64 s   | +20 %             | +5 %             | keep                    |
   | tests-conformance | 7.51 s   | ±0 %              | +1 %             | keep                    |
   | tests-store       | 10.28 s  | +53 %             | +15 %            | maxWorkers 4 (−19 %)    |
   | tests-gallery     | 14.59 s  | +35 %             | −7 %             | maxWorkers 4 (−57 %)    |
   | tests-tooling     | 12.00 s  | failed (timeout)  | −16 %            | isolate: false          |

   `tests-tooling` with `isolate: false` was then measured three times each way, shuffled, at four
   workers: 13.6 s against 12.3 s on average (−9.5 %, 1.3 s), under the 10 % doctor itself
   requires, for shared module state in a project another lane owns — not taken. The Nx targets
   cap Vitest at four workers (`VITEST_MAX_WORKERS=4`, as every package does), which is what doctor
   recommends for the two projects where it found a gain. `tests-docs` and `tests` were not run
   under doctor: one test of `tests-docs` is 119 s of its 167 s, and doctor's three runs of four
   configurations of `tests` would take over an hour on this host.

6. **Two whole-tree scans carry an explicit timeout**, as `tests/catalog-fakes.test.ts` already
   did: `tests/duplicate-vocabulary.test.ts` (60 s) and `tests/storage-limits.test.ts` (30 s).
   Alone they took 4.1 s and 2.9 s of Vitest's 5 s default; with the remainder's files in parallel
   they measured 8.5 s and 5.8 s and timed out. No assertion changed.

#### Where every guarantee remains

No test was removed, skipped, path-gated or moved out of the `test` target. Every test file the
`tests` project collected before is collected by exactly one of the eight projects after (262 files:
the 261, and the checker's own test, `tests/policy-check-test-inputs.test.ts`):

| item                                                                            | where the same guarantee remains                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all 261 files of the old `tests` project                                        | the eight projects; `vitest list` over `tests*` gives the identical 261-file set (diffed against the baseline run's JSON report), and `pnpm test-inputs:check` fails if a file is collected by none or two                            |
| "the root suites run whenever anything changes" (`implicitDependencies: ["*"]`) | each project runs whenever a file it reads changes — its declared inputs, proved by `pnpm test-inputs:check`; a push to `main` and the nightly run still run every project (no diff base)                                             |
| the two `next dev` suites never overlap                                         | `tests-next`: `fileParallelism: false`, `VITEST_MAX_WORKERS=1`, Nx `parallelism: false`, `sequence.groupOrder: 1`                                                                                                                     |
| the no-skip gate reads every test report                                        | each project writes `<project root>/.vitest-report.json` (declared as the target's output by `targetDefaults.test`); `scripts/ci/vitest-no-skip.mjs` reads `tests/.vitest-report.json` and `tests/<dir>/.vitest-report.json` (part 4) |

#### Order independence

Each project ran three times with `--sequence.shuffle` (files and tests, a fresh seed each round)
at four workers, under the test services: tests-formal, tests-conformance, tests-store,
tests-tooling and tests-docs passed every round; `tests` passed every round once the checker's own
dynamic import was made static (the no-SDK-import gate refuses one); tests-gallery passed two of
three. Its one failure is inside a file, not between files:
`tests/gallery/quotation/quotation.test.ts` asserts the first quote the shared fake ERP books is
`QT-0001`, which another test in the same file books first when the tests are shuffled
(`--sequence.seed=21780`, three times out of three; with only the files shuffled it passes). File
parallelism does not reorder the tests inside a file, so the split does not expose it; it is
recorded here for the gallery's owner rather than changed in this unit.

`tests-next` passed twice with `--sequence.shuffle` (seeds 28057 and 18127, 286 tests each, 148 s
and 209 s), once the host problem described under Measured was worked around.

#### `ci-success` and the test shards

Unchanged in kind: a test shard that the diff reaches with no test project still reports
`ran=false` and its no-skip step is skipped, exactly as a shard with no affected package did before.
What changes is how often that happens: a diff that touches only paths no test project reads (a
`changes/` fragment, for one) now selects no `tests*` task at all.

#### Measured

Before / after on the same host (shared, load average 50–145 on 20 cores, so read the ratios, not
the absolute numbers), `pnpm test -- --project <selection>` with the native PostgreSQL and
SeaweedFS services, i.e. one Vitest process over the selection:

| run                                                 | wall    | Vitest duration | summed file time |
| --------------------------------------------------- | ------- | --------------- | ---------------- |
| before: `--project tests` (serial, 261 files)       | 1 270 s | 1 247 s         | 573 s            |
| after: `--project 'tests*'`, default workers (19)   | 581 s   | 561 s           | —                |
| after: `--project 'tests*'`, `VITEST_MAX_WORKERS=4` | 492 s   | 466 s           | —                |

In every run above both `next dev` suites failed before and after alike on this host; they account
for about 360 s of start-up timeouts in each serial run. The cause was the host, not the suites:
Next 16.4.3 stops `next dev` with an upgrade notice when it detects a coding-agent environment
(the `CLAUDECODE` / `AI_AGENT` variables), and `next dev` then needs every workspace package
apps/web imports built (`pnpm --filter '@agent-workspace/web^...' build`), which `pnpm test` does
not do and CI's test shards do (they restore the build). With those two variables unset and the
packages built, `tests-next` passes on its own:

| run (`tests-next` only, native services)                    | wall  | Vitest duration |
| ----------------------------------------------------------- | ----- | --------------- |
| `tests/auth.test.ts` alone (280 tests)                      | 40 s  | 38.7 s          |
| `pnpm test -- --project tests-next` (both files, 286 tests) | 150 s | 142 s           |

CI runs no agent, so the notice does not apply there.

Affected selection after the change (`nx show projects --affected --files=<f> --with-target test`):

| changed file                            | before                | after                                                              |
| --------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| `docs/40-operate/operations/runbook.md` | agent-workspace (261) | tests-docs (11)                                                    |
| an ADR                                  | agent-workspace (261) | tests-docs, tests-tooling (29)                                     |
| `changes/README.md`                     | agent-workspace (261) | none                                                               |
| `.github/workflows/ci.yml`              | agent-workspace (261) | tests, tests-store, tests-tooling (196)                            |
| `scripts/check-workflows.mjs`           | agent-workspace (261) | tests, tests-tooling (169)                                         |
| `tests/docs/llms-txt.test.ts`           | agent-workspace (261) | tests-docs (11)                                                    |
| `tests/formal/cli-runs.test.ts`         | agent-workspace (261) | tests-formal, tests-tooling (48)                                   |
| root `README.md`                        | agent-workspace (261) | tests, tests-docs, tests-gallery, tests-store, tests-tooling (223) |

The remainder `tests` still reads much of the tree (architecture rules, lint baselines, inventory
and docs-truth tests); the docs-truth and inventory tests that duplicate `docs:check` are the
next unit's (D3), and moving them out is what takes `tests` off documentation-only changes.

#### Revert

Delete `tests/projects.mjs`, `tests/vitest.shared.ts`, every `tests/**/project.json` and
`tests/<dir>/vitest.config.ts`, restore `tests/vitest.config.ts`, the root `vitest.config.ts`
`projects` entry `'tests'`, and the root `package.json` `test` target (part 4 restored
`nx.implicitDependencies: ["*"]`; drop the `{workspaceRoot}/tests/**/*` input of the root
`typecheck` and `lint` with it); remove `test-inputs:check` and its `fast-checks` step.

### Part 2: the slow root suites and the real waits

#### Decision

1. **The no-route probe compiles route modules side by side.** `tests/no-route-probe.ts` drove the
   210 declared routes one request after another, and `next dev` compiles a module on its first
   request. Routes of one path (one module) keep their declared order; distinct paths are probed
   eight at a time. Every assertion is unchanged; the 210 statuses are identical, byte for byte, to
   the serial run's (diffed over two runs). Running the probe against a production build instead
   was rejected for the reason part 1 gives (`tests/auth-server-unregistered.ts` relies on the dev
   server seeing planted routes); path-gating it further was not needed.
2. **The API-report tamper test is a unit test of the comparison.** It rendered all five packages'
   reports (declaration emit plus API Extractor) to prove `--check` names an altered file. The
   comparison is now `scripts/docs/lib/api-reports-compare.mjs`, tested on small trees
   (altered, added, removed, normalised, missing directory); the `--reports=` test seam is gone.
   The real tree is compared by `pnpm docs:check` on every change, as before.
3. **The dependency-cruiser baseline is decided by `pnpm architecture:check` alone.**
   `scripts/policy-check-architecture.mjs` makes the one `--ignore-known` run it always made, reads
   its JSON report (an ignored violation stays in it with the severity `ignore`), and fails on an
   unlisted violation — printed in dependency-cruiser's `err` format, as before — and, newly, on a
   baseline entry the tree no longer has. The test that cruised the whole tree a second time for
   those two questions is gone from `tests/architecture-rules.test.ts`; the planted-rule cases, the
   file-only ceiling check and unit tests of the comparison stay. Verified by mutation: removing a
   baseline entry, and adding a stale one, each make `architecture:check` exit 1.
4. **The domain-core clock check compares resolved configuration.** "lets no core file read the
   clock" linted `Date.now()` planted at every core file with the type-aware config. The planted
   cases still lint each clock read at one core path; every core file must now resolve
   (`ESLint#calculateConfigForFile`) to the same configuration of the three `no-restricted-*`
   rules as that path.
5. **Two slow suites are Nx projects with narrow inputs** (tests/projects.mjs, `NARROW_SUITES`):
   `tests-eject-typecheck` (`tests/platforms/eject-typecheck.test.ts`; implicit dependencies on
   contracts, platforms, sdk and the three ejected engine adapters) and `tests-sdk-reference`
   (`tests/docs/generate-sdk-reference.test.ts`; contracts, sdk, aw, the generator and
   `docs/sdk/site/reference`). Their roots hold only their config, like `tests-next`.
6. **The 1 GiB storage load test is collected only with `AW_LOAD_TESTS=1`**
   (`LOAD_TEST_SUITES`). ci.yml's "Storage load test — 1 GiB on four backends" step sets it, on
   every diff that reaches `packages/core/src/storage/`, `tests/load/`, `packages/core/package.json`
   or `pnpm-lock.yaml` (`scripts/ci/load-scope.mjs`; the last two carry the backend SDKs it streams
   through, `@aws-sdk/client-s3`, `@azure/storage-blob` and `@google-cloud/storage`, so a grouped
   Dependabot bump that starts buffering a whole body meets the flat-memory check before it merges)
   and on every run with no diff base (the nightly `schedule`, a dispatch, the release gate). A lock
   change that bumps an unrelated package also runs it; that is the price of not parsing the lock.
   Without it the file ran a
   256 MiB copy of that step on every change the `tests` project saw. The `tests` target hashes
   `AW_LOAD_TESTS`; `pnpm test-inputs:check` checks the file as collected.
7. **The A.12 fixture runs and the store's hanging-platform case wait on injected clocks.**
   `tests/conformance/timers.ts`: the `enforce-resource-limits` scenario and the fixture drivers
   share one injected timer clock — real time for a real driver (the harness default), real Node
   timers with every delay ten times shorter for the fixtures — so the order the driver's limit
   timer and the scenario's budget fire in (issue #562) is unchanged, the no-enforcement case still
   fails after its whole budget, and the stall case still stalls past it.
   `tests/store/card-state.test.ts` rebuilds `AbortSignal.timeout` on the faked `setTimeout`
   (Node's own is not faked) and now also asserts the request is still pending one millisecond
   before its timeout.
8. **`pnpm test-inputs:check` counts a package import as an Nx edge only from a file under the
   project's root.** Nx gives the edge to the project owning the importing file; the checker
   accepted any import, so `tests-next` (imports `@indx-workspace/contracts`) and `tests-store`
   (reaches `@agent-workspace/web` through a `tests/gallery` helper) had a package nothing hashed.
   Both now name it as a positive implicit dependency (`nx graph` shows the edges were absent).

#### Where every guarantee remains

| item                                                                                       | where the same guarantee remains                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api-reports: "--check fails, naming the file, when a committed report is altered"          | `pnpm docs:check` (`generate-api-reports.mjs --check`, every change, fast-checks) on the real tree; the comparison it runs is unit-tested in `tests/docs/api-reports.test.ts`; verified once by hand (tampered `docs/10-product/sdk/api/sdk/define.api.md` → exit 1, file named) |
| architecture-rules: "no stale entries: every known violation still exists" (real tree)     | `pnpm architecture:check` (check:fast, CI typecheck-lint) — new stale-entry failure in `scripts/policy-check-architecture.mjs`                                                                                                                                                   |
| architecture-rules: "lists every violation of the baseline rules: no new ones" (real tree) | `pnpm architecture:check`, unchanged semantics (`--ignore-known`, error count)                                                                                                                                                                                                   |
| architecture-rules: "holds only the baseline rules, within their committed ceilings"       | unchanged, still in `tests/architecture-rules.test.ts` (reads the baseline file only)                                                                                                                                                                                            |
| lint-baseline: "lets no core file read the clock"                                          | same test; per-file lint replaced by resolved-config equality with the core path the planted cases lint                                                                                                                                                                          |
| load/object-store-round-trip at 256 MiB on every `tests` run                               | ci.yml storage load step at 1 GiB on four backends: storage, tests/load, core package.json and lockfile diffs (backend SDK bumps), nightly, dispatch, release gate                                                                                                               |
| eject-typecheck, generate-sdk-reference on every change `tests` / `tests-docs` saw         | their own projects, run whenever a package or file they read changes (inputs proved by `pnpm test-inputs:check`; child-process reads declared by hand: the engine adapters' SDKs through the lockfile in `sharedGlobals`), and on every run with no diff base                    |
| conformance a12-* real 1–2 s waits                                                         | same scenarios, same assertions, on the fixtures' compressed real-timer clock; real drivers (packages/runtime docker conformance) still on real time                                                                                                                             |
| store card-state "is empty when the platform hangs"                                        | same assertion, plus the timeout value and "still pending before it"                                                                                                                                                                                                             |

No test was skipped, deleted without a replacement row above, or moved out of the `test` target
(the load test runs in its own ci.yml step, as its 1 GiB form always did).

#### Measured (this host, 20 cores; Vitest duration unless stated)

| what                                                                                             | before                       | after                                                                      |
| ------------------------------------------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------- |
| `tests/no-route-answers-503.test.ts` (native services)                                           | 134.0 s                      | 34.1 s, 34.9 s                                                             |
| `tests-next` (both files)                                                                        | 150 s (part 1)               | 75.0 s                                                                     |
| `tests/docs/api-reports.test.ts`                                                                 | 32.2 s                       | 0.12 s                                                                     |
| `tests/architecture-rules.test.ts`                                                               | 22.2 s                       | 0.6 s                                                                      |
| `tests/lint-baseline.test.ts` (back to back)                                                     | 20.4 s                       | 12.2 s ("core file" case 8.3 s → 20 ms)                                    |
| `tests-conformance`                                                                              | 7.28 s (summed files 14.7 s) | 0.94 s (summed 1.6 s); 6 shuffled runs and 3 under 16 busy-loop CPUs green |
| store "platform hangs" case                                                                      | 3.0 s                        | 5 ms                                                                       |
| `tests/load/object-store-round-trip.test.ts` in a default run (2 backends here, 4 in CI: 12.9 s) | 8.2 s                        | not collected                                                              |
| `pnpm architecture:check` (depcruise part)                                                       | 21.3 s                       | 22.0 s (one run, as before)                                                |

Affected selection after (`nx show projects --affected --files=<f> --with-target test`); before,
eject-typecheck ran with `tests` (all but the runbook below) and the SDK reference with `tests-docs`:

| changed file                                                                | tests-eject-typecheck | tests-sdk-reference |
| --------------------------------------------------------------------------- | --------------------- | ------------------- |
| `apps/web/server/runs/service.ts`, `apps/web/app/page.tsx`                  | no                    | no                  |
| `packages/core/src/storage/open.ts`, `packages/engine-pi/src/index.ts`      | no                    | no                  |
| `packages/sdk/src/index.ts`, `packages/platforms/src/index.ts`              | yes                   | yes                 |
| `packages/cli/src/index.ts`                                                 | no                    | yes                 |
| `scripts/check-workflows.mjs`, `README.md`, `dependency-cruiser.config.mjs` | no                    | no                  |

#### Not done here

`tests/no-sdk-import/declarations.test.ts` (4.9 s) stays in `tests`: it imports helpers
(`boundaries.ts`, `classify.ts`) that name `packages/*`, the root dot-files and
`docs/research/fixtures`, so honest inputs for a project of its own are nearly `tests`' own.

### Part 3: duplicates deleted, docs truth in `docs:check`, inventories in `pnpm policy:check`

#### Decision

1. **A test that re-runs a gate CI already runs is deleted.** `tests/sdk-surface.test.ts` ran
   Prettier over every file under `tests/`, written when `format:check` did not glob `tests/`; it
   now does (`tests/**/*.{ts,tsx,mts,mjs,json}`; no `.cts` file and no `.prettierignore` entry
   under `tests/`). The two "matches the ceiling on the real tree" cases of
   `tests/lint-baseline.test.ts` counted what `pnpm clock:check` and `pnpm durations:check` count
   (check:fast; ci.yml `typecheck-lint`, on every pull request, queue group, schedule and
   dispatch). The planted-code cases of both ratchets stay.
2. **Assertions about the committed tree are static checks, not tests.** They stay Vitest files —
   they read the repository's TypeScript, and Vitest is its TypeScript runner — but are named
   `*.docs-check.ts` / `*.policy-check.ts`, which no `tests*` project collects, and run through one
   config, `tests/static-checks/vitest.config.ts`, with two lanes:
   - `docs-check`, run by `pnpm docs:check` (fast-checks, every change): the platform matrix and
     the settings table (moved from `tests/platform-matrix.test.ts` and
     `tests/settings-table.test.ts`, which `docs:check` already ran through their `run.mjs`; the
     `tests` project ran them a second time), `tests/docs-truth/{internal,public,packaging}`
     (from `tests/{internal,public}-docs-truth.test.ts` and `tests/w7-packaging-docs.test.ts`),
     `tests/docs/{llms-txt,adr-index}.docs-check.ts` (the real-tree cases of those files) and the
     matrix page's "a guide for every platform". `docs:check` now makes one Vitest run for all of
     them instead of two.
   - `policy-check`, run by the new `pnpm policy:check` (`scripts/policy-check.mjs`, in check:fast
     and ci.yml `fast-checks`): the route inventory
     (`tests/route-inventory{,-files,-handlers}`), the screen inventory
     (`tests/screen-inventory{,-read-only}` plus "reads the real plan" from the schedules file),
     and the real-tree halves of the RF-001 register, the catalog-fake and the duplicate-vocabulary
     rules. Their scanners moved to `tests/fitness/` so the fixture halves, which stay in the
     `tests` project, share them.

   Both lanes resolve every package from `src` (verified with every `packages/*/dist` moved away:
   8 and 7 files pass), so neither needs a build. Both fail when a check neither passed nor failed
   or none ran (`notRun` in `tests/static-checks/run.mjs`), because
   `scripts/ci/vitest-no-skip.mjs` reads only the Nx test reports; verified by planting an
   `it.skip` (exit 1, the case named). `tests/static-checks/static-checks.test.ts` fails when a lane
   file is collected by a test project or not by its lane, or when `docs:check` / `check:fast`
   stops running a lane.

3. **The policy lane runs its files in parallel, without isolation.** The programme proposed one
   process with the scanners loaded once. Measured on this host (20 cores), one worker took
   6.65 / 7.25 / 6.80 s and files in parallel 3.19 / 3.24 / 3.12 s (isolated) and
   3.23 / 3.19 / 3.09 s (no isolation): three whole-tree scans dominate and parallelise. At two
   workers (a small runner) no isolation measured 4.19 / 3.94 s against 4.45 / 4.41 s isolated, so
   the lane keeps `isolate: false` and Vitest's default file parallelism.
4. **A real-tree duplicate of a `docs:check` step is deleted, not moved:** "carries the table of
   platform-matrix.md" (`sync-platform-matrix.mjs --check`), "is current with the committed
   llms.txt" (`generate-llms-txt.mjs --check`), the front door's "passes on this repository"
   (`check-front-door.mjs`). The D-06 case of public-docs-truth is deleted because
   `apps/web/server/shares/runnable/feature.test.ts` asserts the identical value.
5. `tests/coverage-ratchet.test.ts` and `tests/metrics-baseline.test.ts` were listed with the
   inventories but are fixture-only unit tests of `scripts/check-coverage-ratchet.mjs` and
   `scripts/metrics/baseline.mjs` (their real runs are ci.yml `coverage` and release.yml):
   unchanged.
6. `tests/store/recordings.test.ts` keeps Prettier: it is not a formatting gate but the generator's
   last step (it formats the module it renders, `examples/store/catalog/recordings.generated.ts`,
   before comparing), and `format:check` does not glob `examples/`.

#### Where every guarantee remains

| removed or moved                                                                                                      | where the same guarantee remains                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| sdk-surface "finds sources under tests/ to check", "is Prettier-clean under the repository config"                    | `pnpm format:check` (check:fast; ci.yml fast-checks "Formatting", every event), whose globs include `tests/**/*.{ts,tsx,mts,mjs,json}`                |
| lint-baseline clock "matches the ceiling on the real tree"                                                            | `pnpm clock:check` (check:fast; ci.yml typecheck-lint "Clock ceiling equals the direct calls counted")                                                |
| lint-baseline duration "matches the ceiling on the real tree"                                                         | `pnpm durations:check` (check:fast; ci.yml typecheck-lint "Duration ceiling equals the bare durations counted")                                       |
| `tests/platform-matrix.test.ts` (3 cases)                                                                             | same cases, `tests/platform-matrix/platform-matrix.docs-check.ts`, `pnpm docs:check`                                                                  |
| `tests/settings-table.test.ts` (16 cases)                                                                             | same cases, `tests/settings-table/settings-table.docs-check.ts`, `pnpm docs:check`                                                                    |
| `tests/internal-docs-truth.test.ts`, `tests/public-docs-truth.test.ts` (less D-06), `tests/w7-packaging-docs.test.ts` | same cases, `tests/docs-truth/{internal,public,packaging}.docs-check.ts`, `pnpm docs:check`; oss-export.json drops the internal one as it did the old |
| public-docs-truth "keeps runnable public execution compiled fail-closed for D-06"                                     | `apps/web/server/shares/runnable/feature.test.ts` "cannot be enabled by the legacy environment switch" (same input, same expectation)                 |
| docs-platform-matrix "carries the table … and nothing else between its markers"                                       | `node scripts/docs/sync-platform-matrix.mjs --check` in `pnpm docs:check`; the `matrixTable` / `withMatrixRegion` unit cases stay                     |
| docs-platform-matrix "has a guide for every platform in the matrix header"                                            | same case, `tests/platform-matrix/platform-matrix.docs-check.ts`                                                                                      |
| llms-txt "is current with the committed llms.txt"                                                                     | `node scripts/docs/generate-llms-txt.mjs --check` in `pnpm docs:check`                                                                                |
| llms-txt "renderLlmsTxt against this repository" (navigation once, OpenAPI under Optional, order, second render)      | same cases, `tests/docs/llms-txt.docs-check.ts`; the fixture cases stay in `tests/docs/llms-txt.test.ts`                                              |
| adr-index "indexes every record in docs/adr", "is not committed into docs/adr/README.md"                              | same cases, `tests/docs/adr-index.docs-check.ts`; the renderer's fixture case stays                                                                   |
| check-front-door "passes on this repository"                                                                          | `node scripts/docs/check-front-door.mjs` in `pnpm docs:check`; the rule cases stay                                                                    |
| `tests/route-inventory.test.ts`, `-files`, `-handlers` (every case)                                                   | same cases, `tests/route-inventory{,-files,-handlers}.policy-check.ts`, `pnpm policy:check`; the readers / partition / shape fixture cases stay       |
| `tests/screen-inventory.test.ts`, `-read-only`; schedules "reads the real plan and finds it schedules something"      | same cases, `tests/screen-inventory{,-read-only}.policy-check.ts`, `pnpm policy:check`; the classification and schedules fixture cases stay           |
| refactoring-characterization-register "matches every tracked fails-call owner to the register expiry ids"             | same case, `tests/refactoring-characterization-register.policy-check.ts`; the reader's two fixture cases stay                                         |
| catalog-fakes "every hand-written fake is on the allowlist, and the list only shrinks"                                | same case, `tests/catalog-fakes.policy-check.ts`; the nine planted-fake cases stay                                                                    |
| duplicate-vocabulary "has exactly the allowlisted re-declarations, so the list can only shrink"                       | same case, `tests/duplicate-vocabulary.policy-check.ts` (verified: a stale allowlist entry fails `policy:check`); the three fixture cases stay        |

Nothing is skipped. Every moved case kept its title and its assertions; only relative paths and
the two `gateModules('tests/…')` arguments changed with the file names. Part 1's item 6 (the 60 s
timeout of `tests/duplicate-vocabulary.test.ts`) now applies to the policy file, which holds the
whole-tree scan.

#### `ci-success` and fast-checks

No job is added or skipped by this unit, so `ci-success` needs no new condition. The `policy-check`
cases are out of the `tests` lane from this unit on, and CI keeps them through the `fast-checks`
step "Inventories and registers match the tracked tree" (`pnpm policy:check`, part 4).

#### Measured (this host, 20 cores)

| what                                                                       | before                       | after                                  |
| -------------------------------------------------------------------------- | ---------------------------- | -------------------------------------- |
| the 26 files in scope as the test lanes ran them (summed Vitest file time) | 21.22 s, 21.43 s (294 tests) | 8.28 s (the 17 files left, 209 tests)  |
| the same, wall clock of one `vitest run` over them                         | 12.49 s, 12.48 s             | 9.22 s, 9.28 s                         |
| sdk-surface "is Prettier-clean"                                            | 2.54 s                       | removed (format:check)                 |
| lint-baseline "matches the ceiling" ×2                                     | 1.65 s + 1.42 s              | removed (clock:check, durations:check) |
| `tests` project test files (`pnpm test-inputs:check`)                      | 150                          | 141                                    |
| `pnpm docs:check`                                                          | 38.24 s, 37.56 s             | 36.62 s, 36.25 s (7 files, 52 checks)  |
| `pnpm policy:check`                                                        | —                            | 3.11 s, 3.10 s (8 files, 34 checks)    |

### Part 4: integration

#### Decision

1. **The `tests` shard is the tests/ tree's projects.** `scripts/ci/ci-plan.mjs`'s `TEST_SHARDS`
   reads the `tests` shard's projects from `tests/projects.mjs` (`testsProjects()`, Node built-ins
   only, so the plan job's root-only install still suffices), so a project split out of `tests`
   later is never left to `rest`, which starts no Azure or GCS emulator and has no storage load
   step. `tests-eject-typecheck` and `tests-sdk-reference` land there too.
2. **The no-skip gate reads the tests/ projects' reports.** `scripts/ci/vitest-no-skip.mjs`
   discovers `tests/.vitest-report.json` and `tests/<dir>/.vitest-report.json` beside
   `apps/*` and `packages/*`; the repository root has no test target any more, so it no longer
   reads `./.vitest-report.json`. `tests/tooling/vitest-no-skip.test.ts` has the regression case.
3. **`pnpm policy:check` and `pnpm test-inputs:check` run in `fast-checks`**, after the install
   and beside the background `docs:check` (3.4 s and 1.1 s on this host). Part 3's inventories are
   kept by the first; the second is what makes part 1's per-project inputs trustworthy, so it is a
   CI gate and not only a `check:fast` step. Integrating the units found nine undeclared reads
   (the new `scripts/check-workflows/{peripheral,tree-rules}.mjs`, `.github/actionlint.yaml` and
   `scripts/ci/ci-{plan,success}.test.mjs` in tests-tooling; `docs/40-operate/operations/ci-budget.md`
   in `tests`); they are declared.
4. **The root typecheck and lint keep every input they had.** Part 1 removed the root project's
   `implicitDependencies: ["*"]` with its `test` target. But the root `typecheck`
   (`tsconfig.root.json`) and `lint` still cover `tests/` and `scripts/`, and once `tests/` became
   its own projects its files were no longer the root project's: a change to
   `tests/tooling/adr-check.test.ts` selected only `tests-tooling:test`, not the root typecheck or
   lint, and a package source change reached the root typecheck only if `scripts/` imported that
   package. The root project now has `implicitDependencies: ["*"]` again and both targets take
   `code`, `^production`, `lintConfig` and `{workspaceRoot}/tests/**/*` (package.json `nx` block).
   Since the root has no `test` target any more, that implicit dependency no longer runs any test:
   a docs-only change still selects no root task (`production` and `code` exclude Markdown and
   docs/), and `scripts/ci/nx-affected.test.mjs` pins each case.
5. **A static-check lane file is a suite for the database escape rule.**
   `tests/settings-table/settings-table.docs-check.ts` (part 3's move of
   `tests/settings-table.test.ts`) imports `@agent-workspace/core/db/unscoped`, which
   `database-reachability.test.ts` admitted only from a `*.test.ts` / `*.test-support.ts` file.
   The lanes are Vitest suites run by `docs:check` and `policy:check`, so the rule's filename shape
   now also accepts `*.docs-check.ts` and `*.policy-check.ts`; the escape's own refusal to load
   outside a test process is unchanged.
6. **Every reader points at the moved files.** The comments and records in `apps/`, `packages/`
   and `docs/` (the ADRs but this one, the SDK and design documents) that named
   `tests/route-inventory*.test.ts`, `tests/screen-inventory*.test.ts` or
   `tests/settings-table.test.ts` name the `.policy-check.ts` / `.docs-check.ts` files
   (`apps/web/server/sessions/references.test.ts` fails on a dangling path). `internal/` keeps
   its history as written.

#### Where every guarantee remains

| item                                                                         | where the same guarantee remains                                                                                                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the root typecheck and lint re-run when a `tests/` file changes              | root `typecheck` / `lint` inputs `{workspaceRoot}/tests/**/*`; nx-affected case "a tests/ file re-runs its own project's tests and the root typecheck and lint" |
| the root typecheck and lint re-run when a package source they import changes | root `implicitDependencies: ["*"]` with `^production`; nx-affected case "a source change reaches every target of the project and of its dependents"             |
| every tests/ project's report is read by the no-skip gate                    | `scripts/ci/vitest-no-skip.mjs` discovery, `tests/tooling/vitest-no-skip.test.ts`                                                                               |
| the storage load step and the emulators run where the `tests` project runs   | the `tests` shard holds every tests/ project (`TEST_SHARDS` from `tests/projects.mjs`); the nightly has no diff base and runs the step                          |

#### Measured (this host, after integration)

`nx affected --explain` (no task run), `scripts/ci/nx-affected.test.mjs` and `ci-plan.test.mjs`:

| changed file                                            | before the programme                  | after                                                |
| ------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------- |
| `docs/40-operate/operations/runbook.md`                 | agent-workspace:test                  | tests-docs:test                                      |
| `docs/40-operate/operations/durable-execution-state.md` | agent-workspace:test                  | nothing; the plan skips every Nx job                 |
| `tests/tooling/adr-check.test.ts`                       | agent-workspace:{lint,test,typecheck} | agent-workspace:{lint,typecheck}, tests-tooling:test |

Revert of part 4: take the `tests` shard back to a literal list in `TEST_SHARDS`, remove the two
`fast-checks` steps (only after reverting parts 1 and 3, whose guarantees they carry), and drop
`tests` from `vitest-no-skip.mjs`'s roots. The root `typecheck` / `lint` inputs go with part 1.
