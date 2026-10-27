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
