# CI budget and baseline

What CI costs and how long it takes, measured from the GitHub Actions API, and the ceilings the CI
speed / cost programme holds it to. The numbers come from one tool:

```sh
node scripts/ci/metrics/report.mjs --days 7 [--repo owner/name] [--json|--markdown] \
  [--check --budget docs/40-operate/operations/ci-budget.md] [--to <ISO time>] [--cache-dir <dir>]
```

It reads every workflow run created in the window, the jobs of every attempt of each run, the
repository's pull requests (to attach runs to them) and, for human pull requests, their changed
files (for the docs-only split). `--check` holds the report to the budget block below and exits 1,
printing the offending rows, when a ceiling is exceeded. Code: [`scripts/ci/metrics/`](../../../scripts/ci/metrics/report.mjs);
tests with recorded fixtures: [`tests/ci-metrics/`](../../../tests/ci-metrics/report.test.ts).
Decisions this measures against: [ADR-0053](../../adr/0053-ci-runs-on-nx-and-blacksmith-never-on-a-self-hosted-runner.md),
[CI operations](ci.md).

## Definitions

- **Billed minutes**: each job's `completed_at − started_at`, rounded up to a whole minute, summed
  over every attempt (`filter=all`). Skipped jobs count 0. Queue time is not billed and not counted.
- **Estimated USD**: billed minutes × the rate of the job's runner class, from one constant
  (`PRICE_TABLE` in `scripts/ci/metrics/aggregate.mjs`): Blacksmith x64 $0.004/min at 2 vCPU,
  doubling per size; Blacksmith ARM 37 % cheaper; Blacksmith Windows assumed at twice Linux;
  GitHub-hosted at the 2026-01 list price (Linux 2-core $0.006/min) with no plan allowance
  subtracted; self-hosted and Blacksmith macOS $0 (minutes reported, cost not estimated).
- **Runner class**: from the job's `runs-on` labels — `blacksmith-<n>vcpu[-windows|-macos][-arm]`,
  `github-hosted[-arm|-windows|-macos]`, `self-hosted`. Runner _group_ is the prefix
  (`blacksmith`, `github-hosted`, `self-hosted`); the budget may name a group or a class.
- **Wall clock** (per workflow × event): the latest attempt's `run_started_at` to the run's last
  update, over runs that finished `success` or `failure` (a cancelled run stopped early).
- **PR wall clock**: `ci.yml` (the workflow that carries `CI success`) on human pull requests, one
  sample per pushed head: the longest finished run for that PR and SHA. **Docs-only** means every
  changed path is under `docs/` or `changes/`, ends in `.md`, or is `llms.txt`.
- **Merge-queue duplicate minutes**: merge-queue job minutes whose workflow × job had already run
  (not skipped) on a `pull_request` run of the same PR.
- **Same-SHA repeats**: pull request runs of a workflow beyond the first for one head SHA; minutes are
  every run's but the costliest one's.
- **Origin**: the pull request's author (`dependabot[bot]` → dependabot, another bot → bot, else
  human); a merge-queue run inherits it from `gh-readonly-queue/<base>/pr-<n>-<sha>`.

## Baseline (2026-11-04 → 2026-11-18)

Measured 2026-11-18 on the internal repository, windows ending
2026-11-18T18:00Z. "Now" is what the programme brief stated before measuring.

| metric                                          | now (brief)    | measured, 7 days           | measured, 14 days          | target                            | after (2026-11-19)                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------- | -------------------------- | -------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs-only PR CI wall p50 / p90                  | 8–10 min       | 8m08s / 8m49s (2 heads)    | 8m08s / 8m49s (2 heads)    | ≤ 2 min                           | `nx affected --explain`: a document no test reads selects no Nx task, so the run is `fast checks` and `plan` only; one a test reads selects that project (`runbook.md` → `tests-docs`). Wall not yet measured in CI (needs a docs-only PR; a `workflow_dispatch` takes the full tier and is not equivalent) |
| code PR CI wall p50 / p90                       | 9–12 min       | 9m44s / 12m32s (166 heads) | 9m12s / 13m14s (344 heads) | p50 ≤ 3 min                       | one CI run (#2366, run 44444973991, 2026-11-19): 7m28s wall with every project affected and a cold cache (worst case, not a typical PR); critical path `plan` 53 s → `build` 58 s → `tests · web-core` 5m16s. Typical-PR p50 not yet measured                                                               |
| `tests · tests` on PRs p50 / p90                | 7–12 min       | 8m23s / 10m54s             | 8m19s / 11m57s             | ≤ 3 min                           | CI (#2366, run 44444973991): `tests · tests` 3m27s with all `tests*` projects affected. Local: Vitest over the `tests*` projects at 4 workers 492 s against 1270 s serial, same shared host; `no-route-answers-503` 134 s → 34 s; `tests-conformance` 7.3 s → 0.9 s (ADR-0053 Amendment 2026-11-19f)        |
| merge_group CI wall p50 / p90                   | 8–19 min       | 9m00s / 12m05s             | 8m39s / 12m21s             | ≤ 3 min                           | not measured: replay needs the cache server redeployed (ADR-0110 Amendment 2026-11-19)                                                                                                                                                                                                                      |
| Blacksmith minutes / week (est. USD)            | measure        | 4179 ($55.78)              | 5321 ($71.08)              | −90 % → ≤ 532                     | not measured per week; one #2366 run billed 10 Blacksmith minutes (build 1, build-embedded 4, typecheck-lint 5); projections in ADR-0053 Amendment 2026-11-19e                                                                                                                                              |
| GitHub-hosted minutes / week (est. USD at list) | measure        | 3855 ($23.13)              | 3679 ($22.08)              | −70 % → ≤ 1104                    | not measured                                                                                                                                                                                                                                                                                                |
| self-hosted minutes / week (not priced)         | –              | 7444                       | 10333                      | no target (runners unchanged, D4) | not measured                                                                                                                                                                                                                                                                                                |
| `ci.yml` on push to `main`                      | red every time | 73 success, 40 cancelled   | 172 success, 45 cancelled  | green                             | F1 cause removed: Next.js 16.4.6, `osv-scanner` reports no unbaselined advisory; `cancel-on-fast-failure` no longer cancels a push                                                                                                                                                                          |
| `ci.yml` nightly (schedule)                     | red every time | 5 cancelled, 2 failure     | 9 failure, 5 cancelled     | green                             | as for the push to `main`                                                                                                                                                                                                                                                                                   |

Where the minutes go:

| item                                                    | 7 days              | 14 days             |
| ------------------------------------------------------- | ------------------- | ------------------- |
| all billed minutes / week (est. USD / week)             | 15478 ($78.91)      | 19333 ($93.16)      |
| merge-queue minutes, of which duplicate of the PR's     | 4211, 3499 ($18.71) | 8924, 7266 ($44.41) |
| cancelled job minutes                                   | 431 (1334 jobs)     | 1040 (2176 jobs)    |
| same-SHA PR repeats: extra runs, minutes                | 166, 665            | 343, 1413           |
| … of which later runs triggered by `blacksmith-sh[bot]` | 115 runs            | 217 runs            |
| human PRs: runs, PRs, minutes                           | 1301, 115, 7841     | 2827, 225, 16950    |
| Dependabot PRs: runs, PRs, minutes                      | 52, 5, 207          | 101, 9, 385         |

## The brief's facts, re-measured from run data

Only what run and job data can show; F3, F4 (per-file Vitest times), F6 (step timing inside a job),
F7's versions and F8/F9 (configuration) are not in the API's run data and are not re-measured here.
Durations are job p50 / p90 over finished jobs, 14 days, pull request runs unless noted; where a job
moved runner class inside the window the larger sample is quoted.

| fact                                    | brief                                                                            | measured                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1 push to `main`                       | red every time; `fast checks` fails, `build` cancelled                           | 14 days: 172 success, 45 cancelled. The 45 are `fast checks` failing (44) and the builds cancelled after it (42). Red pushes per day: 0–3 until 11-15, then 18 of 32 on 11-16, 11 of 11 on 11-17, 4 of 4 on 11-18 — red every time now                                                                                                                             |
| F1 nightly `ci.yml`                     | red every time                                                                   | 14 of 14 scheduled runs red (9 failure, 5 cancelled); `CI success` failed in 15 of 15 attempts                                                                                                                                                                                                                                                                     |
| F2 docs-only PR wall                    | 8–10 min                                                                         | p50 8m08s, p90 8m49s — but only 2 docs-only human PRs in 14 days                                                                                                                                                                                                                                                                                                   |
| F2 `tests · tests`                      | 402 s Vitest, 7–12 min job                                                       | PR 8m19s / 11m57s (308 runs, `self-hosted`); merge queue 7m23s / 10m55s                                                                                                                                                                                                                                                                                            |
| F6 `build · embedded and its tests`     | 142–174 s, runs on docs PRs                                                      | 2m17s / 3m10s (378 runs) — runs on every PR, including both docs-only ones                                                                                                                                                                                                                                                                                         |
| F7 `typecheck and lint · Nx task graph` | ~160 s                                                                           | 2m17s / 3m29s                                                                                                                                                                                                                                                                                                                                                      |
| F9 merge queue                          | full inner loop again, no cache write                                            | `ci.yml` merge-queue wall p50 8m39s, p90 12m21s; 81 % of merge-queue minutes (7266 of 8924) re-ran a job that had already run on the same PR                                                                                                                                                                                                                       |
| merge-queue trivy                       | 11–19 min when image scope                                                       | per-run max shard: 17 of 256 queue runs above 5 min, longest 19m24s; otherwise p50 13–14 s                                                                                                                                                                                                                                                                         |
| F10 per-PR workflows                    | isolation, quality, security, internal checks, OSS export, journey-live, windows | p50 6 workflows per pushed PR head, max 10                                                                                                                                                                                                                                                                                                                         |
| F10 Dependabot storm                    | 11 PRs/h                                                                         | 9 Dependabot branches in 14 days, at most 6 opened in one hour (2026-11-11 10:00 UTC); 2.1 % of PR minutes (385 of 17,927)                                                                                                                                                                                                                                         |
| F11 `fast checks`                       | 187–224 s                                                                        | 3m14s / 3m40s (667 runs, `github-hosted`)                                                                                                                                                                                                                                                                                                                          |
| (new) same-SHA repeats                  | –                                                                                | 343 extra PR runs (14 days) on a head SHA that already had a run of the same workflow; in the last 7 days 115 of 166 later runs were triggered by `blacksmith-sh[bot]`. Those runs take `ci.yml`'s body-edit path (`pull_request: edited`, `fast checks` only — checked on both docs-only PRs), so the bot appears to edit PR bodies: 665 billed minutes in 7 days |

The "after (local)" column holds only what was measured on a development host while the programme
was integrated (ADR-0053 Amendments 2026-11-19 to 2026-11-19f); everything CI-wide waits for the
first week of runs, which `ci-budget.yml` reports.

## Budget

The ceilings `--check` enforces, set at the programme targets: Blacksmith minutes −90 % and
GitHub-hosted −70 % of the 14-day weekly baseline; `CI` wall p50 ≤ 3 min on pull requests and in the
merge queue; docs-only PR wall p50 ≤ 2 min; each critical-path `CI` job p90 ≤ 3 min (fast checks
≤ 2 min, since a docs-only PR runs only those). The baseline exceeds the minute budgets, both wall-clock budgets
and most job ceilings today, so the check fails until the programme lands; that is the point of the
block. A budgeted job with no runs in
the window (renamed, or skipped because not affected) is listed as missing and does not fail.

| critical-path job                             | runner class     | PR p50 / p90   | merge queue p50 / p90 | p90 ceiling | after (2026-11-19)                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------- | -------------- | --------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fast checks · PR contract · workflow policy` | github-hosted    | 3m14s / 3m40s  | 3m26s / 3m45s         | 120 s       | gates after the install 173.5 s → 69.6 s pinned to 2 CPUs (109.9 s with a cold Prettier cache); `docs:check` 86.5 s → 53.8 s; the new `policy:check` (3.4 s) and `test-inputs:check` (1.1 s) run beside `docs:check` |
| `typecheck and lint · Nx task graph`          | blacksmith-8vcpu | 2m17s / 3m29s  | 2m19s / 3m32s         | 180 s       | unchanged: typecheck already runs TypeScript 7, lint stays on TypeScript 6, oxlint not adopted (ts7-typecheck-evaluation.md, oxlint-evaluation.md); skipped when no typecheck or lint task is reached                |
| `build · embedded and its tests`              | blacksmith-8vcpu | 2m17s / 3m10s  | 2m18s / 3m14s         | 180 s       | skipped unless an embedded task is reached                                                                                                                                                                           |
| `build · every workspace but embedded`        | blacksmith-8vcpu | 51s / 1m16s    | 53s / 1m14s           | 180 s       | skipped when no task needs it                                                                                                                                                                                        |
| `tests · tests`                               | self-hosted      | 8m19s / 11m57s | 7m23s / 10m55s        | 180 s       | see the baseline table; the shard runs only the affected `tests*` projects                                                                                                                                           |
| `tests · web-core`                            | self-hosted      | 4m06s / 6m10s  | 3m43s / 6m08s         | 180 s       | web: 188 fewer test files load drizzle/pg (452 → 264), summed import time 280 s → 224 s; no wall gain measurable on the shared host                                                                                  |
| `tests · aw-cli`                              | self-hosted      | 1m00s / 2m55s  | 58s / 3m03s           | 180 s       | not measured                                                                                                                                                                                                         |
| `tests · rest`                                | self-hosted      | 1m01s / 2m10s  | 58s / 2m22s           | 180 s       | not measured                                                                                                                                                                                                         |

<!-- ci-budget:begin -->

```json
{
  "minutesPerWeek": {
    "blacksmith": 532,
    "github-hosted": 1104
  },
  "jobP90Seconds": [
    {
      "workflow": "CI",
      "job": "fast checks · PR contract · workflow policy",
      "event": "pull_request",
      "p90Seconds": 120
    },
    {
      "workflow": "CI",
      "job": "fast checks · PR contract · workflow policy",
      "event": "merge_group",
      "p90Seconds": 120
    },
    {
      "workflow": "CI",
      "job": "typecheck and lint · Nx task graph",
      "event": "pull_request",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "typecheck and lint · Nx task graph",
      "event": "merge_group",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "build · embedded and its tests",
      "event": "pull_request",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "build · embedded and its tests",
      "event": "merge_group",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "build · every workspace but embedded",
      "event": "pull_request",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "build · every workspace but embedded",
      "event": "merge_group",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "tests · tests",
      "event": "pull_request",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "tests · tests",
      "event": "merge_group",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "tests · web-core",
      "event": "pull_request",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "tests · web-core",
      "event": "merge_group",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "tests · aw-cli",
      "event": "pull_request",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "tests · aw-cli",
      "event": "merge_group",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "tests · rest",
      "event": "pull_request",
      "p90Seconds": 180
    },
    {
      "workflow": "CI",
      "job": "tests · rest",
      "event": "merge_group",
      "p90Seconds": 180
    }
  ],
  "wallSeconds": [
    {
      "workflow": "CI",
      "event": "pull_request",
      "stat": "p50",
      "maxSeconds": 180
    },
    {
      "workflow": "CI",
      "event": "merge_group",
      "stat": "p50",
      "maxSeconds": 180
    }
  ],
  "prWallP50Seconds": {
    "docsOnly": 120,
    "code": 180
  }
}
```

<!-- ci-budget:end -->

## Breakdown (14 days)

The tool's own Markdown output for the 14-day window (`--markdown`), unedited except for the heading
level.

### CI metrics — internal repository, 2026-11-04 → 2026-11-18 (14 days)

7743 completed runs, 16670 jobs that ran, 38666 billed minutes (19333/week), estimated $186.32 ($93.16/week).

#### By runner group

| runner group  | minutes | minutes/week | est. USD | est. USD/week |
| ------------- | ------- | ------------ | -------- | ------------- |
| blacksmith    | 10642   | 5321         | $142.17  | $71.08        |
| github-hosted | 7358    | 3679         | $44.15   | $22.08        |
| self-hosted   | 20666   | 10333        | $0.00    | $0.00         |
| other         | 0       | 0            | $0.00    | $0.00         |

#### By runner class

| runner class             | USD/min | jobs | minutes | minutes/week | est. USD |
| ------------------------ | ------- | ---- | ------- | ------------ | -------- |
| self-hosted              | 0.0000  | 6422 | 20666   | 10333        | $0.00    |
| blacksmith-8vcpu         | 0.0160  | 4014 | 7482    | 3741         | $119.71  |
| github-hosted            | 0.0060  | 4819 | 7358    | 3679         | $44.15   |
| blacksmith-4vcpu         | 0.0080  | 194  | 1457    | 728.5        | $11.66   |
| blacksmith-2vcpu         | 0.0040  | 1037 | 1365    | 682.5        | $5.46    |
| blacksmith-4vcpu-windows | 0.0160  | 182  | 334     | 167          | $5.34    |
| blacksmith-6vcpu-macos   | 0.0000  | 2    | 4       | 2            | $0.00    |

#### Pull request wall clock (CI workflow, human PRs, longest finished run per pushed head)

| PR kind   | heads | PRs | p50   | p90    |
| --------- | ----- | --- | ----- | ------ |
| docs-only | 2     | 2   | 8m08s | 8m49s  |
| code      | 344   | 223 | 9m12s | 13m14s |

#### By workflow × event

| workflow                                                     | event             | runs | cancelled runs | minutes | cancelled min | est. USD | wall p50 | wall p90 |
| ------------------------------------------------------------ | ----------------- | ---- | -------------- | ------- | ------------- | -------- | -------- | -------- |
| CI                                                           | pull_request      | 750  | 164            | 12395   | 583           | $73.74   | 7m28s    | 12m04s   |
| CI                                                           | merge_group       | 258  | 4              | 8628    | 12            | $50.05   | 8m39s    | 12m21s   |
| GCP Cloud Run preview                                        | workflow_dispatch | 38   | 1              | 5201    | 0             | $0.00    | 137m42s  | 301m01s  |
| CI                                                           | push              | 218  | 45             | 2070    | 165           | $19.53   | 3m36s    | 4m20s    |
| Isolation                                                    | pull_request      | 95   | 22             | 1646    | 159           | $11.40   | 9m00s    | 13m13s   |
| CI                                                           | schedule          | 14   | 5              | 1307    | 40            | $6.27    | 21m48s   | 27m19s   |
| Developer journey against the real model                     | pull_request      | 402  | 3              | 1096    | 0             | $0.00    | 20s      | 5m07s    |
| Security analysis                                            | pull_request      | 418  | 2              | 834     | 0             | $4.46    | 43s      | 53s      |
| Agent Store deploy                                           | push              | 41   | 4              | 600     | 2             | $0.00    | 13m54s   | 30m32s   |
| OSS export                                                   | push              | 218  | 0              | 509     | 0             | $0.97    | 1m49s    | 2m50s    |
| OSS export                                                   | pull_request      | 418  | 25             | 489     | 25            | $1.96    | 46s      | 1m05s    |
| Security analysis                                            | push              | 218  | 0              | 438     | 0             | $2.32    | 43s      | 50s      |
| Internal checks                                              | pull_request      | 418  | 2              | 416     | 0             | $2.23    | 20s      | 25s      |
| Quality extensions                                           | pull_request      | 418  | 16             | 415     | 13            | $2.22    | 16s      | 20s      |
| CI Windows unit                                              | pull_request      | 89   | 4              | 322     | 8             | $5.15    | 1m34s    | 2m30s    |
| OSS export                                                   | merge_group       | 258  | 1              | 296     | 0             | $1.18    | 46s      | 1m03s    |
| Terraform                                                    | pull_request      | 35   | 3              | 249     | 17            | $0.00    | 1m34s    | 7m25s    |
| Internal checks                                              | push              | 218  | 0              | 218     | 0             | $1.15    | 19s      | 25s      |
| Quality extensions                                           | push              | 218  | 0              | 218     | 0             | $1.15    | 16s      | 19s      |
| OSS export                                                   | schedule          | 14   | 0              | 203     | 0             | $0.81    | 13m58s   | 20m59s   |
| Lightweight journey                                          | schedule          | 2    | 0              | 170     | 0             | $0.00    | 53m53s   | 55m52s   |
| Builder evals                                                | schedule          | 14   | 0              | 162     | 0             | $0.00    | 10m45s   | 12m40s   |
| CI                                                           | workflow_dispatch | 3    | 2              | 151     | 16            | $0.53    | 26m33s   | 26m33s   |
| Providers live                                               | schedule          | 14   | 0              | 125     | 0             | $0.00    | 3m09s    | 4m42s    |
| Terraform                                                    | push              | 13   | 0              | 102     | 0             | $0.00    | 1m38s    | 2m34s    |
| Isolation                                                    | push              | 33   | 0              | 73      | 0             | $0.00    | 1m16s    | 2m32s    |
| Developer journey against the real model                     | schedule          | 2    | 0              | 64      | 0             | $0.00    | 13m49s   | 17m22s   |
| Azure Container Apps preview                                 | pull_request      | 39   | 0              | 59      | 0             | $0.00    | 1m10s    | 2m29s    |
| Nightly CI alarm                                             | workflow_run      | 2829 | 0              | 39      | 0             | $0.22    | 9s       | 12s      |
| Install live                                                 | schedule          | 2    | 0              | 36      | 0             | $0.19    | 4m00s    | 5m51s    |
| Isolation                                                    | schedule          | 2    | 0              | 36      | 0             | $0.26    | 8m10s    | 11m28s   |
| Security analysis                                            | schedule          | 14   | 0              | 28      | 0             | $0.17    | 42s      | 51s      |
| npm_and_yarn in /. - Update #1695588535                      | dynamic           | 1    | 0              | 15      | 0             | $0.09    | 14m43s   | 14m43s   |
| npm_and_yarn in / for @aws-sdk/client-s3, @opentelemetry/ex… | dynamic           | 1    | 0              | 11      | 0             | $0.07    | 10m06s   | 10m06s   |
| npm_and_yarn in / for @aws-sdk/client-s3, @opentelemetry/ex… | dynamic           | 1    | 0              | 10      | 0             | $0.06    | 9m24s    | 9m24s    |
| Agent Store real-model verification                          | workflow_dispatch | 2    | 0              | 9       | 0             | $0.00    | 30s      | 7m05s    |
| CI Nx remote cache                                           | pull_request      | 3    | 0              | 6       | 0             | $0.04    | 33s      | 36s      |
| npm_and_yarn in / for @microsoft/api-extractor, @playwright… | dynamic           | 1    | 0              | 6       | 0             | $0.04    | 5m37s    | 5m37s    |
| CI Nx remote cache                                           | push              | 2    | 0              | 4       | 0             | $0.02    | 30s      | 34s      |
| github_actions in /. - Update #1695588538                    | dynamic           | 1    | 0              | 2       | 0             | $0.01    | 1m20s    | 1m20s    |
| github_actions in / for pnpm/action-setup - Update #1708023… | dynamic           | 1    | 0              | 2       | 0             | $0.01    | 1m16s    | 1m16s    |
| github_actions in /. - Update #1714100457                    | dynamic           | 1    | 0              | 2       | 0             | $0.01    | 1m25s    | 1m25s    |
| npm_and_yarn in /. - Update #1714100458                      | dynamic           | 1    | 0              | 2       | 0             | $0.01    | 1m16s    | 1m16s    |
| Model providers live                                         | workflow_dispatch | 1    | 0              | 1       | 0             | $0.00    | 28s      | 28s      |
| Model providers live                                         | schedule          | 1    | 0              | 1       | 0             | $0.00    | 26s      | 26s      |
| Agent Store daily jobs                                       | schedule          | 3    | 0              | 0       | 0             | $0.00    | –        | –        |

#### By job (top 40 by minutes)

| workflow                                 | event             | job                                                                                 | runner class     | count | minutes | est. USD | p50     | p90     |
| ---------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- | ---------------- | ----- | ------- | -------- | ------- | ------- |
| GCP Cloud Run preview                    | workflow_dispatch | preview                                                                             | self-hosted      | 37    | 3483    | $0.00    | 120m27s | 160m06s |
| CI                                       | pull_request      | tests · tests                                                                       | self-hosted      | 308   | 2657    | $0.00    | 8m19s   | 11m57s  |
| CI                                       | pull_request      | fast checks · PR contract · workflow policy                                         | github-hosted    | 667   | 2225    | $13.35   | 3m14s   | 3m40s   |
| GCP Cloud Run preview                    | workflow_dispatch | sandbox-internet                                                                    | self-hosted      | 15    | 1718    | $0.00    | 134m14s | 163m47s |
| CI                                       | merge_group       | tests · tests                                                                       | self-hosted      | 211   | 1717    | $0.00    | 7m23s   | 10m55s  |
| CI                                       | pull_request      | tests · web-core                                                                    | self-hosted      | 308   | 1324    | $0.00    | 4m06s   | 6m10s   |
| CI                                       | pull_request      | build · embedded and its tests                                                      | blacksmith-8vcpu | 378   | 987     | $15.79   | 2m17s   | 3m10s   |
| CI                                       | merge_group       | fast checks · PR contract · workflow policy                                         | github-hosted    | 224   | 863     | $5.18    | 3m26s   | 3m45s   |
| CI                                       | merge_group       | tests · web-core                                                                    | self-hosted      | 211   | 837     | $0.00    | 3m43s   | 6m08s   |
| Isolation                                | pull_request      | kind-deploy lane                                                                    | blacksmith-4vcpu | 95    | 722     | $5.78    | 7m57s   | 10m12s  |
| Isolation                                | pull_request      | kind lane                                                                           | blacksmith-4vcpu | 95    | 703     | $5.62    | 7m44s   | 9m09s   |
| CI                                       | pull_request      | CI success                                                                          | github-hosted    | 665   | 665     | $3.99    | 3s      | 4s      |
| CI                                       | merge_group       | build · embedded and its tests                                                      | blacksmith-8vcpu | 224   | 654     | $10.46   | 2m18s   | 3m14s   |
| CI                                       | push              | fast checks · PR contract · workflow policy                                         | github-hosted    | 192   | 608     | $3.65    | 3m07s   | 3m37s   |
| Agent Store deploy                       | push              | deploy staging                                                                      | self-hosted      | 40    | 600     | $0.00    | 13m29s  | 22m17s  |
| Developer journey against the real model | pull_request      | build-to-deploy journey · create, eval, deploy, push, tool turn, promote            | self-hosted      | 400   | 579     | $0.00    | 14s     | 20s     |
| CI                                       | pull_request      | tests · aw-cli                                                                      | self-hosted      | 308   | 571     | $0.00    | 1m00s   | 2m55s   |
| CI                                       | pull_request      | typecheck and lint · Nx task graph                                                  | blacksmith-8vcpu | 228   | 567     | $9.07    | 2m17s   | 3m29s   |
| Developer journey against the real model | pull_request      | platforms journey · create, export to every platform, goldens, refusals, round trip | self-hosted      | 400   | 517     | $0.00    | 14s     | 24s     |
| CI                                       | pull_request      | tests · rest                                                                        | self-hosted      | 308   | 504     | $0.00    | 1m01s   | 2m10s   |
| OSS export                               | pull_request      | OSS export · dry run                                                                | blacksmith-2vcpu | 416   | 489     | $1.96    | 38s     | 52s     |
| CI                                       | push              | build · embedded and its tests                                                      | blacksmith-8vcpu | 192   | 476     | $7.62    | 2m23s   | 3m21s   |
| CI                                       | pull_request      | build · every workspace but embedded                                                | blacksmith-8vcpu | 378   | 463     | $7.41    | 51s     | 1m16s   |
| CI                                       | merge_group       | release images · trivy gate · 3/3                                                   | self-hosted      | 258   | 437     | $0.00    | 14s     | 1m05s   |
| CI                                       | merge_group       | formal · Lean specification                                                         | blacksmith-8vcpu | 256   | 432     | $6.91    | 56s     | 2m51s   |
| CI                                       | merge_group       | release images · trivy gate · 1/3                                                   | self-hosted      | 258   | 413     | $0.00    | 13s     | 45s     |
| CI                                       | merge_group       | typecheck and lint · Nx task graph                                                  | blacksmith-8vcpu | 138   | 407     | $6.51    | 2m19s   | 3m32s   |
| CI                                       | pull_request      | tests · tests                                                                       | blacksmith-8vcpu | 62    | 401     | $6.42    | 5m39s   | 7m55s   |
| CI                                       | merge_group       | tests · aw-cli                                                                      | self-hosted      | 211   | 398     | $0.00    | 58s     | 3m03s   |
| Security analysis                        | pull_request      | dependency-audit                                                                    | github-hosted    | 371   | 373     | $2.24    | 39s     | 45s     |
| Internal checks                          | pull_request      | internal checks                                                                     | github-hosted    | 371   | 371     | $2.23    | 15s     | 20s     |
| Security analysis                        | pull_request      | ghas-skipped-notice                                                                 | github-hosted    | 371   | 371     | $2.23    | 3s      | 4s      |
| Quality extensions                       | pull_request      | Helm lint and render                                                                | github-hosted    | 371   | 370     | $2.22    | 11s     | 13s     |
| CI                                       | merge_group       | release images · trivy gate · 2/3                                                   | self-hosted      | 258   | 357     | $0.00    | 14s     | 59s     |
| CI                                       | pull_request      | lint · Nx task graph                                                                | blacksmith-8vcpu | 176   | 354     | $5.66    | 1m24s   | 2m06s   |
| CI                                       | merge_group       | tests · rest                                                                        | self-hosted      | 211   | 350     | $0.00    | 58s     | 2m22s   |
| OSS export                               | merge_group       | OSS export · dry run                                                                | blacksmith-2vcpu | 257   | 296     | $1.18    | 38s     | 51s     |
| CI                                       | merge_group       | build · every workspace but embedded                                                | blacksmith-8vcpu | 224   | 282     | $4.51    | 53s     | 1m14s   |
| CI                                       | merge_group       | tests · tests                                                                       | blacksmith-8vcpu | 45    | 281     | $4.50    | 5m40s   | 6m15s   |
| OSS export                               | push              | OSS export · publish                                                                | self-hosted      | 217   | 266     | $0.00    | 55s     | 1m12s   |

#### Pull request vs merge queue, and who opened the PR

| event        | origin     | runs | PRs | minutes | est. USD |
| ------------ | ---------- | ---- | --- | ------- | -------- |
| pull_request | human      | 2827 | 225 | 16950   | $95.22   |
| merge_group  | human      | 506  | 219 | 8762    | $50.46   |
| pull_request | bot        | 157  | 4   | 592     | $3.38    |
| pull_request | dependabot | 101  | 9   | 385     | $2.59    |
| merge_group  | bot        | 10   | 1   | 162     | $0.78    |

Merge queue: 8924 minutes, of which 7266 ($44.41) re-ran a workflow × job that had already run on the same PR.

| workflow   | duplicate minutes | est. USD |
| ---------- | ----------------- | -------- |
| CI         | 6975              | $43.25   |
| OSS export | 291               | $1.16    |

Same-SHA repeats: 343 pull request runs re-tested a head SHA that already had a run of the same workflow (308 SHAs), 1413 minutes ($7.97). Later runs by trigger:

| triggered by       | runs | minutes |
| ------------------ | ---- | ------- |
| blacksmith-sh[bot] | 217  | 960     |
| human              | 117  | 550     |
| dependabot[bot]    | 9    | 31      |

Cancelled jobs: 2176 jobs, 1040 minutes ($7.57).
