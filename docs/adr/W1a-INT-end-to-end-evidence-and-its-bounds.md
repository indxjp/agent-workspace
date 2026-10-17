# W1a-INT — The end-to-end run needed two scratch launchers, and that is the finding

Status: accepted
Date: 2026-09-03
Decided by: W1a integrator
Scope: the integration acceptance evidence for `aw/w1a-integration`; binding on what that evidence
may be read to prove

## Context

The integration question this branch exists to answer is *"four tracks each passed alone; do they
compose?"*, and the concrete form of it is: run the runner and the web app together and exercise
`POST /api/agents/:id/runs` end to end.

Doing that turned up the shape of the answer before any request was sent. **There is no way to start
the composed system from the repository as it stands**, for two separate reasons, each honestly
declared as a gap by the task that found it:

1. **The web application has no composition root.** `apps/web/server/runs/environment.ts` exports
   `installRunApi()` and `apps/web/server/agents/runtime.ts` exports `configureAgentsRuntime()`.
   Nothing calls either. The file that would — `apps/web/instrumentation.ts` — is outside every W1a
   task's `Owns` line, and both W1-CP-04 (#18, gap 5) and W1-CP-05 (#15, gap 2) say so.
2. **The runner has no entry point.** `apps/runner/package.json`'s `start` script runs
   `node dist/index.js`, and `apps/runner/src/index.ts` is still the Wave-0 placeholder that exports
   a package-name constant. W1-RN-02's `startRunnerServer()` in `server.ts` is never called;
   W1-RN-02 (#17, gap 5) declares this as *"Nothing starts the server. `apps/runner/src/index.ts` is
   outside `Owns`"*.

There is also no sign-in route: W1-CP-06 owns `apps/web/server/auth/**` and `middleware.ts`, and
`docs/adr/W1-CP-06-sign-in-lives-outside-the-api-prefix.md` records that the route itself is not
this wave's. `signIn()` exists and nothing serves it.

## Decision

**Run it anyway, from scratch launchers held outside every worktree, and state precisely what the
resulting evidence does and does not prove.**

Three scratch files under `<home>/aw-worktrees/scratch-w1a/` — outside every worktree, per
the execution protocol, and committed nowhere:

- a launcher that imports `startRunnerServer` from `apps/runner/dist/server.js` directly, standing in
  for the entry point `index.ts` does not provide;
- a script that calls `signIn()` from `apps/web/server/auth/session.ts` with the same environment the
  server was started with, standing in for the sign-in route;
- `next start` on the real production build, unmodified.

Nothing was added to any worktree and no owned file was edited. What the run then measured is the
**true composed behaviour of the branch as committed**, which is the point: the 503s below are the
answer, not an obstacle to getting one.

## What the evidence proves

Proven, by executed output pasted in the Wave 1a manifest:

- the five §34 route handlers of two different tasks build into **one** Next.js production app;
- W1-CP-06's middleware gates W1-CP-04's and W1-CP-05's routes **without either task knowing it
  exists** — `POST /api/agents/:id/runs` with no cookie is `401 no_session_cookie`, and so is
  `GET /api/agents`. This is the one genuine cross-task composition in Wave 1a and it works;
- with a valid session, every route answers `503` naming the piece nobody installed —
  `run_api_not_configured` and `agents_runtime_not_configured`. Both are
  [ADR-0015](0015-gates-decide-on-positive-assertions.md) behaving exactly as designed: an
  unconfigured capability refuses rather than pretending;
- W1-RN-02's runner serves the §14.3 contract standalone — `GET /healthz` 200, `POST /run` with a
  bad body 400 with per-field issues, `GET /files` **501** (not 404), an unknown path 404 naming the
  three endpoints it does serve;
- W1-DB-01's migration and seed run against a real PostgreSQL 17.11 in Docker, and with
  `TEST_DATABASE_URL` set the suite's 14 skips become passes — `7 failed | 562 passed | 14 skipped
  (583)` without it, `7 failed | 576 passed (583)` with it, both at `cb9a9d7`. The total moves to 585
  intermittently, and that is FINDING 5 in the manifest, not a database effect.

## What it does not prove

- **`POST /api/agents/:id/runs` has never produced a run.** No request in Wave 1a has travelled from
  the web app to the runner. The relay, the launcher and the SSE path are covered by W1-CP-04's own
  unit tests and by its nginx acceptance run against `fake-runner.mjs`; they are **not** covered
  against W1-RN-02's real runner, and this branch does not change that.
- **The session used was minted in-process, not obtained over HTTP.** It exercises the middleware's
  verification path, not a sign-in flow, because there is no sign-in flow.
- **Windows 11 / win32-x64, Node 24.19.0, one Docker Desktop host.** The Linux evidence for the
  branch is CI, and CI is red for the reasons in
  `W1a-INT-closed-world-gates-break-on-the-union.md`.

## Alternatives considered

- **Write `apps/web/instrumentation.ts` and `apps/runner/src/index.ts` on this branch** so the run
  could actually reach the runner. Rejected: both are outside the integrator's `Owns` line, both are
  declared gaps on open PRs, and composing the application is a task with a place in the stack —
  [ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md) rule 5 says
  cross-package wiring is a task, not an obligation smuggled into an unrelated one. Writing it here
  would also have produced a green end-to-end result that the branch itself cannot reproduce.
- **Report "not testable" and skip the run.** Rejected: the 401 result is a real cross-task
  composition fact that nothing else in the wave establishes, and the two 503s are the wave's most
  important finding stated in the system's own words.
- **Declare the capability supported because nothing failed.** Rejected — that is the sentence
  [ADR-0015](0015-gates-decide-on-positive-assertions.md) exists to forbid, and spec §12/§14.5 make
  it the product's core claim.

## Consequences

- **Wave 1a delivers no working run.** Every §34 control-plane route answers `503` in a real
  deployment. The routes, the store, the relay, the runner and the auth gate all exist and are
  individually exercised; the file that joins them does not.
- **W1b's first task must be the composition root** — `apps/web/instrumentation.ts` calling
  `installRunApi()` and `configureAgentsRuntime()`, plus an `apps/runner/src/index.ts` that calls
  `startRunnerServer()`. Until it lands, no end-to-end assertion about this product is possible, and
  any claim of one should be disbelieved.
- The scratch launchers are deliberately **not** committed anywhere, so this evidence is not
  reproducible by re-running a checked-in script. The commands are pasted in the manifest instead.
  That is a weaker artefact than a committed harness, and it is the correct trade only because the
  committed harness belongs to the task that owns the composition root.
