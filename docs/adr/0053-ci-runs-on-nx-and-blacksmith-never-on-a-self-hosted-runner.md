# ADR-0053 — CI runs on Nx and Blacksmith, never on a self-hosted runner

Status: accepted
Date: 2026-09-21
Decided by: the repository owner, with the measurements below
Scope: the gate workflows, `nx.json`, every workspace `package.json`'s `nx` block, `scripts/check-workflows.mjs`

## Context

Every gate in this repository ran on GitHub's 4-vCPU `ubuntu-latest` runner, as two jobs queued
one behind the other. Measured on the last green pull-request run before this change
(`ci.yml` run 35518274099, `quality.yml` run 35518274117, 2026-09-20):

| Job | Wall clock | Where the time went |
| --- | --- | --- |
| `fast-checks` | 2 min 43 s | lint 64 s, typecheck 22 s, formatting 16 s, architecture 11 s |
| `heavy-checks` (after `fast-checks`) | 9 min 10 s | `pnpm test` 6 min 45 s, `pnpm build` 61 s |
| `ci.yml` critical path | **12 min 0 s** | the two jobs in series |
| `quality.yml` › coverage | 9 min 53 s | three coverage configs run one after another |

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
