# W1-INF-02 — CI runs against a real PostgreSQL, and proves the tests it enabled actually ran

Status: accepted
Date: 2026-09-03
Decided by: W1-INF-02 (Infra)
Scope: `.github/workflows/ci.yml`; binding on every task whose acceptance depends on a database

## Context

Three Wave 1a tasks reported, independently, that CI could not exercise what they had built, and
each declined to fix it because `.github/**` was not theirs to edit. They were right to decline.
The gap is this task's to close.

`packages/core/src/db/seed.test.ts` gates its two database-backed suites on `TEST_DATABASE_URL`
with `describe.skipIf`. That variable was not set anywhere in CI, so on every run before this one:

```
 Test Files  12 passed (12)
      Tests  150 passed | 14 skipped (164)
```

Fourteen skipped tests, a green tick, and no signal that anything was missing unless a human
scrolled the log. What those fourteen cover is not incidental — it is W1-DB-01's entire acceptance
argument: the migration, the seed, the "exactly one General agent" assertion of spec §19.5, and
every §25 cross-tenant foreign key, including the three statements a review of that schema
demonstrated the database used to accept. All of it had been exercised exactly once, in a container
on one contributor's machine, with the transcript pasted into a pull-request body. CI had verified
none of it.

The skip was loud rather than hidden — the test file prints a warning naming what did not run, and
W1-DB-01's own record lists the CI gap as honest downside 5. That is why this is a gap and not a
lie. But [ADR-0015](0015-gates-decide-on-positive-assertions.md) is about exactly this shape: a
green run that proves less than it appears to, because a gate decided on the absence of a failure
rather than on the presence of a result.

Separately, `apps/web` declares `@agent-workspace/core` at `workspace:*`, and that package is
consumed as a *package* whose `dist/` is gitignored. On the commit this branch started from
(`3a49175`), `exports["."].types` pointed at `./dist/index.d.ts`, so a one-line `apps/web` file
importing `@agent-workspace/core` failed `pnpm typecheck` with
`error TS2307: Cannot find module '@agent-workspace/core'` — a message that reads as "the dependency
is missing" and sends the next author to edit a manifest that is already correct.

**That specific route was closed while this task was in flight, by W1-DEP-01, and this record says
so rather than keeping a defeated example.** W1-DEP-01 repointed `exports[*].types` at `./src/*.ts`
and added a `pnpm --filter @agent-workspace/core build &&` prefix to `apps/web`'s own `dev` and
`build` scripts. Re-measured against the merged tree, the probe now type-checks with `dist/` absent.
What did **not** change is that `main`, top-level `types`, and both `exports[*].default` still name
`./dist/*`, and nothing in CI asserts those files are ever produced — `pnpm typecheck` and
`pnpm test` both pass on a tree with no `dist/` at all, while `node` in `apps/web` importing the
package fails with `ERR_MODULE_NOT_FOUND … /dist/index.js`. The task brief anticipated exactly this
("W1-DEP-01 is fixing the resolution itself in parallel; your job is that CI enforces the ordering
regardless"), and that is what the two steps below do.

## Decision

**1. A PostgreSQL 17 service container, for the whole job, with a health check.**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    env: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres, POSTGRES_DB: agent_workspace_test }
    ports: ['5432:5432']
    options: >-
      --health-cmd "pg_isready -U postgres -d agent_workspace_test"
      --health-interval 5s --health-timeout 5s --health-retries 30 --health-start-period 10s
```

and `TEST_DATABASE_URL` at job level so the assertion step and the test step read one string
rather than two spellings of it.

Four details are load-bearing:

- **A health check, not a sleep.** GitHub holds every step until the container reports healthy, so
  a slow start delays the job instead of failing it in a way that looks like a test failure.
- **The health check is a liveness signal, not a gate, and this record says so because the first
  draft of it got this wrong.** That draft claimed `-d agent_workspace_test` closed the window in
  which the server is up but `POSTGRES_DB` does not yet exist. It does not. Against a live
  PostgreSQL 17.11, `pg_isready -U postgres -d database_that_does_not_exist` exits 0, exactly as
  `pg_isready -U postgres` does: the tool reports whether the server accepts connections and says
  nothing about the database named. The `-d` is documentation of intent. What actually asserts the
  database is the step described in point 3 below, which opens a connection to it and runs a
  query; pointed at a database that does not exist, it fails with
  `Could not reach TEST_DATABASE_URL: database "…" does not exist`. This is ADR-0015 in one line:
  a probe that answers "is something listening" must not be read as "is the thing I need there".
- **`ports: 5432:5432`, and `localhost` in the URL.** The job's steps run on the runner host, not
  inside a container, so the service is reached through a published port and not by its service
  name. That is a GitHub-runner property, and it was the one claim in this record that local
  verification could not test — this machine cannot publish container ports at all, which is why
  the local run used a Docker network and a service name instead. Run 33719459254 settled it:
  `5432/tcp -> 0.0.0.0:5432` in *Initialize containers*, then
  `PostgreSQL 17.11 … database=agent_workspace_test server_version=17.11` from a step reaching
  `localhost`.
- **The credentials are not secrets and must not be written as any.** The container lives for one
  job and is reachable only from that job's runner. GitHub withholds secrets from a `pull_request`
  build raised on a fork, so a `secrets.` reference would leave the service unreachable precisely
  where CI matters most.

**2. `packages/core` is built before anything else runs**, as a step of its own — the root
`typecheck` script is not this task's file to change, and the ordering has to hold regardless of how
that script, or the package's `exports` map, happens to be written this week. After W1-DEP-01 the
ordering no longer rescues `tsc`; it is now the only thing in CI that asserts the package emits the
`dist/` files its manifest promises to every consumer that is not `tsc`. Only `packages/core` is
built: `pnpm build` would also run `next build`, measured at 7.3 s on this app today and growing
with every route, for output nothing in this job checks.

**3. Three new gates, each deciding on a positive assertion (ADR-0015).** Two read artefacts the job
produced; the third, described last, is the precondition check that runs before the tests.

- *`packages/core`'s declared entry points exist.* A green `tsc` is not evidence that anything was
  written, and the concrete case was measured rather than assumed:
  `packages/core/tsconfig.json` sets `noEmit: true` and `tsconfig.build.json` overrides it to
  `false`; delete that one override and `tsc -p tsconfig.build.json` exits 0, prints nothing and
  creates no `dist/`. (An `include` that matches no file is *not* this case — that is TS18003 and
  exit 2. An earlier draft of both this record and the workflow comment said it was, and was
  wrong.) So this step reads the `exports`, `main` and `types` fields out of
  `packages/core/package.json` and requires every target they name to exist as a file. It follows
  the manifest rather than a list copied into the workflow, and it fails if the manifest declares
  no entry points at all — a gate that would assert nothing must not report success.
- *No test in the run was skipped.* `pnpm test` exiting 0 does not say the database suites ran:
  vitest counts a skipped test as neither passed nor failed, which is how fourteen acceptance tests
  sat behind a green tick. The Test step now writes a JSON report and this step reads it, requiring
  the report to exist, to contain tests at all, and to contain no test whose status is anything
  other than `passed` or `failed`. Every test that did not run is printed by full name.
- *PostgreSQL service is a real PostgreSQL 17*, the third, running before the tests. It connects
  through `TEST_DATABASE_URL`, runs a query, and requires the integer
  before the first `.` of `current_setting('server_version')` to be 17. It uses `pg`, resolved from
  `packages/core`, which already depends on it (pinned at 8.23.0 by R-15) — no dependency was added
  to make a gate work. Because it *connects*, it is also the step that catches an absent database,
  which the health check above does not.

**4. The report path is exported through `$GITHUB_ENV`, not set in `jobs.<id>.env`.** It has to be
`$RUNNER_TEMP`-relative — the report is this workflow's own scratch, and two later steps inspect the
checkout with git (the file-ownership gate, and the generated-block gate through
`regenerate-index.sh`), so dropping it into the tree invites a gate to trip over it. But the
`runner` context is **not available** in a job-level `env:` block, and the failure mode is
instructive: GitHub rejects the whole workflow, runs **zero jobs**, and reports a **0-second
failure** whose only detail is "This run likely failed because of a workflow file issue." The first
push of this branch did exactly that. `actionlint` names it precisely —

```
.github/workflows/ci.yml:94:31: context "runner" is not allowed here. available contexts are
"github", "inputs", "matrix", "needs", "secrets", "strategy", "vars".
```

— so a step now reads `$RUNNER_TEMP` (which the runner sets as an ordinary variable) and appends
`VITEST_JSON_REPORT=…` to `$GITHUB_ENV`, keeping one definition for every later step.

**5. Nothing existing was weakened.** No step was deleted, made conditional, or had its command
relaxed. The two diff gates keep their `pull_request` conditions and the step that announces the
reduced push-build gate set is untouched. The header comment was corrected — see Consequences.

### What makes the no-skip rule safe, stated exactly

The task brief requires that a conditional skip say what makes it safe. This gate is the inverse —
it forbids skips — so the thing to state is what it costs.

On this branch the full run is 164 tests and the only skips in it are the 14 gated on
`TEST_DATABASE_URL`. With the service container present there is nothing left to skip, which is
why the rule can be absolute today rather than scoped to one file. It is deliberately strict:
`it.skip` and a `skipIf` on a missing environment variable are the same shape in the report, and
this programme's recurring defect is a green tick over something that never executed. A future task
that needs a genuine skip has to change this step and say why in its pull request. That is the
intended cost. It does not get to add one quietly.

The rule keys on test *status*, not on a file path or a test name, so renaming or moving
`seed.test.ts` cannot make it vacuous. Deleting those tests would, but deleting an acceptance test
is a visible diff; a skipped one is not.

## What this costs in run time

Measured, not estimated (ADR-0016). The test and build figures are three consecutive runs each,
inside a `node:24` container talking to `postgres:17-alpine` over a Docker network; the image and
health figures are from the Docker host directly. Commands and full output are in the pull-request
body.

| Measurement | Result |
| --- | --- |
| `pnpm test` whole run, no database (14 skipped) | 2061 / 1943 / 1925 ms |
| `pnpm test` whole run, database present (0 skipped) | 2371 / 2209 / 2143 ms |
| …of which `packages/core/src/db/seed.test.ts`, no database | 8 ms (24 tests \| 14 skipped) |
| …of which `packages/core/src/db/seed.test.ts`, database present | 728 ms (24 tests) |
| `pnpm --filter @agent-workspace/core run build`, cold `dist/` | 2107 / 2330 / 2077 ms |
| `pnpm --filter @agent-workspace/web run build` — *not* run by CI, measured to justify that | 7281 ms |
| `docker pull postgres:17-alpine`, cold cache | 3769 ms (118 MB compressed, 424 MB on disk) |
| container create → `healthy` | 6650 ms |

So on this host the database adds roughly **0.2 s to the whole test step**: the file that holds the
fourteen tests goes from 8 ms to 728 ms, and vitest runs files in parallel, so the whole run grows
by far less. The build step adds about **2.1 s**. The service container is the larger line, about
**3.8 s to pull and 6.6 s to reach healthy**; the 5 s `--health-interval` sets that figure's
granularity, which is why 6.6 s is not 1.6 s.

**Then the real runner measured it, and the local numbers understated the cost.** A first draft of
this section said GitHub's runners cache many images, so the local pull figure should be read as an
upper bound. It is not an upper bound: `ubuntu-latest` did not have `postgres:17-alpine` and pulled
all nine layers. Both jobs below are `pull_request` builds of this same workflow file, taken from
the GitHub Actions jobs API rather than from prose:

| Step | Baseline (`aw/w1-02b-deps`, run 33718597975) | This branch (run 33719459254) |
| --- | --- | --- |
| Initialize containers | — | **23 s** |
| Build packages/core | — | 2 s |
| packages/core's declared entry points exist | — | 0 s |
| PostgreSQL service is a real PostgreSQL 17 | — | 0 s |
| Test | 7 s | 6 s |
| No test in the run was skipped | — | 0 s |
| Stop containers | — | 3 s |
| **Whole job** | **51 s** | **75 s** |

**+24 s per job, and essentially all of it is the service container** — 23 s to pull and reach
healthy, 3 s to stop. The two new assertion steps cost 0 s each, the build 2 s, and the Test step
did not measurably grow (7 s → 6 s, inside run-to-run variance on shared runners: `Typecheck` moved
14 s → 8 s across the same pair). Twenty-four seconds a job for fourteen acceptance tests that were
previously not executed at all.

## What remains unexercised

Written so the next task inherits a list rather than an unexamined green.

1. **The `db:migrate` and `db:seed` entry points.** The suite calls `runMigrations()` and `seed()`
   as library functions. `node dist/db/migrate.js` and `node dist/db/seed.js` — what an operator
   actually runs, and what §55's walk-through will call — are never executed by CI.
2. **`NO ACTION` versus `RESTRICT`.** W1-DB-01 decision 14 records that no test in this repository
   tells the two apart, because the workspace delete succeeds under both. A database in CI does not
   change that; it takes a different test.
3. **The dependency specifiers themselves.** W1-DEP-01 declared the gap and it is still open: no
   test reads `apps/runner/package.json` and asserts the SDK pin is exact, and none reads
   `apps/web/package.json` and asserts `@agent-workspace/core` is a `workspace:` specifier. This
   task cannot close it — the assertion belongs in `tests/`, which is not in these Owns globs.
4. **Two of §9.1's eight gates.** `spec-inventory` and `no-sdk-import` still do not exist, because
   the product code they assert against does not: `apps/web/app` holds a layout and a placeholder
   page, and `apps/runner/src` holds `index.ts` and its test, not `claude.ts`.
5. **`apps/web` has no tests at all.** `passWithNoTests: true` is deliberate
   ([W0-INF-01](W0-INF-01-vitest-projects-follow-the-workspace.md)), and the no-skip gate does not
   change it: a project that collects nothing is not a skipped test. A member whose tests all
   disappear still passes.
6. **The compose stack.** W1-INF-01's `docker compose up -d` path — web, runner, gateway, MinIO —
   is not exercised here. This job runs one PostgreSQL and the workspace's own test suite.
7. **One database, one platform.** `postgres:17-alpine` on `ubuntu-latest`, amd64. Nothing asserts
   the schema against another minor, another architecture, or a non-Alpine build.
8. **`next build`.** Deliberately not run (see Decision 2), so a type error reachable only through
   the Next.js build graph is not caught by this job.
9. **Nothing imports `@agent-workspace/core` at runtime in CI.** The build step and the entry-point
   gate assert that `dist/` is *produced*; no test loads it. Measured on the merged tree: `pnpm
   typecheck` and `pnpm test` both pass with `dist/` deleted, while `node` in `apps/web` importing
   the package fails with `ERR_MODULE_NOT_FOUND`. The gate closes the gap between "the manifest
   promises these files" and "these files exist"; it does not close the gap between "they exist"
   and "they work".
10. **The workflow file itself is not validated by anything in the repository.** A malformed
   workflow — the `runner`-context mistake of Decision 4 is the worked example — fails in a way that
   reports nothing useful: zero jobs, zero seconds, no annotation an API call can retrieve. It was
   diagnosed here with `actionlint`, run out of band. Adding `actionlint` as a step is deliberately
   *not* done in this task: the step that would run it lives in the very file it validates, so it
   cannot catch the class of error that stops the file from loading at all. The place for it is a
   pre-push hook or a second workflow, and either is a decision for whoever owns that, not a change
   smuggled into this one.

## Alternatives considered

- **Install PostgreSQL onto the runner with `apt`.** Rejected: slower, unpinned, and it makes the
  version a property of the runner image rather than of this file.
- **Keep the suites skipping and assert the schema in a separate scheduled workflow.** Rejected: a
  gate that does not block a pull request does not stop a pull request, and this repository's rule
  is one workflow, one job.
- **Set `TEST_DATABASE_URL` and stop there.** Rejected, and this is the important one. It would have
  satisfied the task brief's first line and left the failure mode intact: unset the variable, or
  misspell it, and the fourteen tests skip again behind a green tick. The variable is not the gate;
  the assertion that the tests ran is the gate.
- **Assert on a hardcoded expected test count.** Rejected: the number goes stale the first time
  anyone adds a test, and a stale gate is edited to match rather than obeyed. The rule is a
  property — nothing was skipped — not a number.
- **Run `pnpm build` for the whole workspace.** Rejected: `next build` is minutes for no gain here.

## Consequences

- The fourteen database-backed tests now run on every pull request and every push to `main`. Run
  33719459254 on GitHub's own runner reported `Tests 164 passed (164)`, with
  `src/db/seed.test.ts (24 tests) 1307ms`, and the gate after it read the run's own report:
  `files=12 tests=164 {"passed":164}` / `Every one of the 164 collected tests ran.` Nothing was
  silenced to get there: no existing step was weakened, and no test failed once the database was
  real.
- A pull request that breaks a cross-tenant foreign key, the migration, or the "exactly one General
  agent" invariant now fails CI instead of passing it.
- **A stale claim in this file's own header was corrected.** It read "Five of the eight gates §9.1
  lists are here … The other three — spec-inventory, sdk-surface, no-sdk-import" and named all three
  as future steps. `sdk-surface` had already landed, as `tests/sdk-surface.test.ts`, collected by
  `pnpm test` through the `tests` entry in `vitest.config.ts`'s `projects`. Six of eight are
  enforced, two do not exist. A gate list that undercounts misleads exactly as much as one that
  overcounts.
- `docs/adr/README.md` is regenerated, because adding this record makes the committed index stale
  and `sh docs/adr/regenerate-index.sh --check` is a blocking step. It is declared on the pull
  request per the orchestrator's ratification and ADR-0017.
- Every job now creates a database container whether or not the diff touches the database. That is
  the cost of the gate being unconditional, and it is the point: a database-backed test must not be
  able to skip because someone judged the diff unrelated.
