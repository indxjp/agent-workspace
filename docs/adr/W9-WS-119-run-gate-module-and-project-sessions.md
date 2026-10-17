# ADR-W9-WS-119-3 — The archived-run/session guard is its own module, with a load-bearing test at every seam it protects

Status: accepted
Date: 2026-09-12
Decided by: W9-WS-119, repair rounds 1 and 2 (verification round 1, findings 2, 3, 5; verification
round 2, finding 1)
Scope: `apps/web/server/workspaces/run-gate.ts`, `apps/web/server/composition/register.ts`

## D1 amendment

The current `guardSessionCreation` returns the typed refusal `unknown-principal` for an actor not
found in the directory, instead of the earlier `not-a-member` spelling described below.

## Context

Issue #119: "Archived workspaces … are excluded from new run/session creation." Before this round,
`register.ts` inlined `isWorkspaceUsableForRuns(await root.workspaces.get(principal.workspaceId))`
at two call sites (`findAgent`, `openSession`) and exported the three-line predicate so
`apps/web/server/workspaces/register-archived-guard.test.ts` could unit-test it directly (this
task's `Owns` names `register.ts` as an exact filename with no test wildcard, so a
`register.test.ts` cannot live beside it —
`docs/adr/W9-PLAN-the-composition-root-moved-after-the-plan-was-written.md`).

Verification round 1, finding 2, showed that test proved only the PREDICATE, not the CALL SITES:
`grep -rln "isWorkspaceUsableForRuns"` found exactly one test file, which calls the predicate with
literal objects and never calls `register()`, `findAgent` or `openSession` at all. Deleting the two
`if (!isWorkspaceUsableForRuns(workspace)) return null;` lines from `register.ts` left every test in
the PR green.

Finding 3 showed a second, undefended seam in the same file: `configureProjectsRuntime` (issue
#125's projects/sessions runtime) is handed a bare `SessionRepository` with no archived check at
all, so `POST /api/projects/:id/sessions` created a new session in an archived workspace — the same
acceptance criterion, unmet at a different call site `register.ts` also wires. That route
(`apps/web/app/api/projects/[id]/sessions/route.ts`) and its runtime type
(`apps/web/server/projects/runtime.ts`) both belong to W9-PROJ-153 this wave and are outside this
task's `Owns`; only the provider `register.ts` constructs and hands to `configureProjectsRuntime`
is this task's to change.

Finding 5 noted a third call site with the identical shape and no check at all — `runPublic` inside
`register.ts`, which creates a session and launches a run directly. It is unreachable today:
`apps/web/app/p/[token]/messages/route.ts` gates on `runnablePublicLinksEnabled()`, which
`apps/web/server/shares/runnable/feature.ts` hard-returns `false`. Declared as a gap, not fixed,
for the reason given below.

## Decision

### 1. One module, `apps/web/server/workspaces/run-gate.ts`, owns the predicate and the gate

`isWorkspaceUsableForRuns` moved here verbatim (re-exported from `register.ts` so the existing
`register-archived-guard.test.ts` import keeps working unchanged) and is now wrapped by
`createRunGate(repository): RunGate`, a two-method-shaped closure — `isUsable(workspaceId):
Promise<boolean>` — built from the same `WorkspaceRepositoryPort` `/api/workspaces` reads. `findAgent`
and `openSession` each call it in one line:

```ts
if (!(await runGate.isUsable(principal.workspaceId))) return null;
```

This is the same "one line, at the two call sites" shape the original ADR already asked for; what
changes is that the check now delegates to a module this task's test suite can drive independently
of `register()`'s own body.

### 2. The call sites get a composition-root integration test, not just the predicate

`apps/web/server/workspaces/run-gate-integration.test.ts` (`describe.skipIf(!hasDatabase)`, gated on
`TEST_DATABASE_URL` exactly like every other database-backed suite in this codebase) calls the REAL
`register()` against an isolated PostgreSQL 17, with `DATABASE_URL`/`SESSION_SECRET`/`RUNNER_URL`
set for the duration of the test, then drives the INSTALLED closures through
`apps/web/server/runs/environment.ts`'s `getRunApi()` — `runApi.findAgent(principal, agentId)` and
`runApi.openSession(principal, agent, null)` — before and after archiving the workspace with
`root.workspaces.archive(...)`. This is a test of the wiring, not of the predicate: deleting either
call-site line in `register.ts`, or deleting `run-gate.ts`'s check inside `createRunGate`, makes
this test's post-archive assertions fail with a real, named result (`findAgent` stops returning
`null`), which is exactly what finding 2 asked for.

`getRunApi()` (not a new export) is used because it is already the seam `register.ts` itself reads
from for `runPublic`, and it hands back the literal `findAgent`/`openSession` closures
`installRunApi` was given — no HTTP request construction, no session cookie minting, needed to
drive them.

### 3. `configureProjectsRuntime`'s `sessions` provider is wrapped, not the route

`run-gate.ts` exports `guardSessionCreation(sessions, workspaceId, gate): SessionRepository` — a
`SessionRepository` whose `ensure` (the one row-creating method) checks the gate first and
delegates to the real repository otherwise; every other method (`get`, `list`, `update`, `archive`,
`restore`) is untouched, because issue #119 excludes an archived workspace from NEW creation only,
never from reading or archiving a session that already exists. `register.ts` wraps exactly the
`sessions` field of the object it hands `configureProjectsRuntime.forWorkspace`, leaving
`apps/web/app/api/projects/**` and `apps/web/server/projects/**` (W9-PROJ-153's, this wave) fully
unedited — the fix lives entirely at the one seam inside `register.ts` this task owns.

`EnsureSessionOutcome` (`packages/core/src/db/repositories/runs.ts`, outside this task's `Owns`) is
a closed union with no "workspace archived" member and this task cannot widen it, so the refusal is
reported as `{ kind: 'not-a-member', userId: input.userId }` — of the four existing outcomes, the
one whose meaning is least wrong (a membership that cannot create a session here right now) and the
one `POST /api/projects/:id/sessions`'s own handler already turns into a generic, non-2xx
`422 project_session_start_failed` for any kind other than `created`/`existing`. The response is
therefore correct (>= 400, no session created) even though its `outcome.kind` string is borrowed.

### 4. `runPublic` is wired to the same gate, and proved through the runtime registry, not HTTP

Round 1 declared finding 5 an untestable gap on the theory that `runPublic` cannot be reached over
HTTP (`runnablePublicLinksEnabled()` in `apps/web/server/shares/runnable/feature.ts` is a
hard-coded `false`, so `apps/web/app/p/[token]/messages/route.ts` 404s before `runPublic` runs) and
therefore cannot be tested. **That reasoning was wrong, and verification round 2's finding 1 showed
it directly**: `runPublic` is a closure installed on the module-global shares runtime registry
(`configureSharesRuntime` / `currentSharesRuntime()` in `apps/web/server/shares/core/runtime.ts`)
exactly the way `findAgent`/`openSession` are installed on the run-API registry — a test does not
need an HTTP path to a closure that is already reachable by importing the registry that holds it.
`run-gate-integration.test.ts`'s third test does exactly that: it calls the real `register()`
against an isolated PostgreSQL, retrieves `currentSharesRuntime()`, creates a runnable public
share, archives the workspace, and calls `sharesRuntime.runPublic(...)` directly — the same pattern
the file's second test already used against `currentProjectsRuntime()` for finding 3. Before this
round that probe wrote a session row and a queued run row into the archived workspace and only then
failed for the unrelated reason that the share was not reserved; after this round it refuses with
`runGate.isUsable(workspaceId)` before either row is written.

`runPublic` (`register.ts`) now opens with the same one-line check as `findAgent`/`openSession`:

```ts
if (!(await runGate.isUsable(workspaceId))) {
  throw new Error('The public share became unavailable because its workspace is archived.');
}
```

placed before the session `ensure` and the run `store.create` it guards. `runPublic` still cannot
be reached over `/p/:token/messages` while `runnablePublicLinksEnabled()` remains `false` — that
flag is unrelated to this fix and stays outside this task's `Owns` — but the closure itself is no
longer a place where an archived workspace's run/session invariant silently does not hold; it holds
for exactly the same reason and by exactly the same mechanism as the other two call sites, proved
by exactly the same style of test.

## Alternatives considered

- **Export `findAgent`/`openSession` themselves as a factory function, tested directly with fakes,
  with `register.ts` reduced to assigning the factory's output to `installRunApi`.** Rejected: it
  would move agent-lookup and session-open business logic that belongs to the run API's own
  contract (`apps/web/server/runs/environment.ts`) into a workspaces-owned module for the sole
  purpose of making one two-line guard testable — a much larger surface change than the defect
  warrants, and one that would leave `run-gate.ts` no longer describing only "the archived-workspace
  gate" but "how a run is found and a session is opened", which is not this task's resource.
- **Skip the database-backed integration test and rely only on a unit test of `createRunGate` with
  a fake `{ get }` repository.** Rejected: that would repeat exactly finding 2's mistake one layer
  down — proving the GATE correct without proving `register.ts`'s call sites still invoke it. The
  integration test is what makes the call-site lines themselves load-bearing.
- **(Round 1, superseded) Leave `runPublic` an explicitly declared gap, on the theory that an
  HTTP-unreachable closure cannot be tested.** This was round 1's decision and it was wrong: the
  closure is reachable — and testable — through `currentSharesRuntime()` without going anywhere
  near HTTP, exactly as `findAgent`/`openSession` are reachable through `getRunApi()`.
  Verification round 2's finding 1 demonstrated the probe directly. Superseded by decision 4 above;
  kept here so the mistake and the correction are both on the record rather than the mistake being
  quietly dropped.

## Consequences

- A future call site that creates a run or a session inside a workspace boundary composes
  `run-gate.ts`'s `createRunGate`/`guardSessionCreation` rather than re-deriving the archived check.
- All three known composition-root call sites that create a run or a session (`findAgent`,
  `openSession`, `runPublic`) now check the same `runGate`, each proved by a database-backed
  integration test that fails with a named, real assertion if its check is removed. There is no
  longer a declared gap on this axis; `runnablePublicLinksEnabled()` staying `false` is a separate,
  unrelated feature flag this task does not own.
