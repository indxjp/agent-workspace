# W1-COMP-01 — What the composition root wires, what it refuses to wire, and why both 503s survive it

Status: accepted
Date: 2026-09-03
Decided by: W1-COMP-01 (the composition root)
Scope: `apps/web/instrumentation.ts`; `apps/web/server/agents/runtime.ts` (the registry anchor
only, claimed under [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md));
`compose.yaml` (`RUNNER_URL` on the `web` service)

## D1 amendment

The `openSession` refusal of every caller-supplied `sessionId` in the historical unwired list
below has been superseded: the current composition root resumes an owned active session.

## Context

`installRunApi()` and `configureAgentsRuntime()` had no callers outside tests and a probe fixture
that refuses to start unless `AW_ACCEPTANCE_HARNESS=1`. Every §34 route therefore answered 503 in
a real deployment. This record is about the two halves of doing something about that: what gets
installed, and what deliberately does not.

## Decision 1 — each seam is installed only when its own configuration is present

`register()` asks three questions and each "no" leaves something genuinely unavailable:

| absent | consequence |
| --- | --- |
| `SESSION_SECRET` (or shorter than 32) | nothing installed; the middleware already refuses every `/api/**` request 401 |
| `DATABASE_URL` unusable | nothing installed; both APIs 503, because neither can resolve a workspace |
| `RUNNER_URL` | agent API installed, run API **not**; the three run routes 503 by name |

The third row is the interesting one. Agent CRUD needs a session and a workspace and does not need
a runtime, so a deployment with no runtime serves `/api/agents` and refuses to start runs — which
is the truth about it. Collapsing the two into one switch would have made a missing runtime look
like a broken control plane.

**Both 503s stay reachable and were re-checked after the wiring landed**, which is the point the
task card makes: a 503 that can no longer fire because the check was deleted is the wrong fix.
Neither check was touched; what changed is that a configured deployment now passes them.

## Decision 2 — the agents registry moves to `globalThis`

`apps/web/server/agents/runtime.ts` held its runtime in a module-level `let`. Next.js compiles
`instrumentation.ts` and the route handlers into **separate module graphs**, so that is one
variable per bundle. Measured on `next@16.3.4`, on this branch: `register()` logged
`[compose] agent API installed` and, in the same process, `GET /api/agents` with a valid session
answered `503 agents_runtime_not_configured`, while `GET /api/runs/:id` — whose registry
W1-CP-04 had already moved to `globalThis` for exactly this reason — reached its adapters.

The anchor moves; nothing else about that module changes. The claim on a file W1-CP-05 owns is
declared with this reason under ADR-0018, and it is the same shape as W1-INT-02's two route-file
edits: a defect between two tasks that neither could see, repaired above both, with the frozen
branches left alone.

## Decision 3 — identity is three rows, not one lookup

A verified session carries an email and a workspace slug. `resolveIdentity` reads the workspace by
slug, the user by email, and **the membership joining them**, and returns `null` if any is absent.

Reading the membership is the whole reason it is three queries. A valid session proves only that
this deployment's secret signed those claims; it does not prove the account still belongs to that
workspace. Deriving a workspace id from the slug alone would make deleting a membership do nothing
until the twelve-hour token expired. §25's isolation is a property of what the database says now.

The agent routes' three-way `WorkspaceResolution` is honoured rather than flattened: no valid
session is `unauthenticated`, a valid session with no membership is `forbidden` and says so.

## What is NOT wired, and why not here

| seam | state | why this file does not fix it |
| --- | --- | --- |
| agent persistence | `createInMemoryAgentStoreProvider()` | it is the only implementation that exists. `apps/web/server/agents/store.ts` states the obligation a PostgreSQL adapter owes and `store.test.ts` is its conformance suite; writing one is a feature task, not a wiring file growing a persistence layer |
| run records and events | `InMemoryRunStore` | already recorded as Wave 1's state in [W1-CP-04](W1-CP-04-run-events-are-in-process-in-wave-1.md) |
| sessions (§20) | minted per run, never stored | the `sessions` table exists and nothing in `apps/web` reads it. `openSession` therefore **refuses** a caller-supplied `sessionId` — a 409 telling the caller to omit it — rather than trusting one it cannot verify. §19.5 rule 4 makes the wrong answer a silently forked conversation |
| provider credentials | none | spec A.11: the master key never enters a sandbox; §26's gateway injects a run-scoped token, it is Wave 4, and `compose.yaml` runs a placeholder that refuses every request |
| sign-out | unbuilt | `clearedSessionCookie()` is exported and served by nothing; it belongs to the shell that would show the control |

The first two mean **a restart loses every agent and every run**, and two replicas do not agree
about either. That is a Wave 1 property, it is stated here and on the PR, and it is not something
the routes' own `200`s will tell anyone.

## Consequences

**A database failure is a 500, not a 401.** `authenticate` and `resolveWorkspace` let a connection
error propagate rather than returning `null`, because `null` means "this request carries no valid
identity" and a database that cannot be reached has not established that. Deciding "unauthenticated"
from a failure to check is the ADR-0015 shape precisely.

**`RUNNER_URL` is a `compose.yaml` literal with a default, not a seventh line in `.env.example`.**
`runner` is a service name in that file's own network and resolves nowhere else, so there is no
decision for an operator to make inside the shipped topology — the same reasoning
`compose.yaml`'s header already gives for the Postgres credentials. `.env.example` is W1-INF-01's
file and [its six-value record](W1-INF-01-env-example-is-six-values.md) stays true.

**`RUNNER_WORKSPACE_ROOT` defaults to `/workspace`.** Not a guess: `runtime.Dockerfile` already
creates that directory owned by `node` and describes it as the SDK's `cwd` for a run.
`Dockerfile`'s `runner` target now does the same, because nothing had ever sent that container a
run.

**The database module is loaded with `await import()`, below the edge guard.** Measured: a
top-level `import … from '@agent-workspace/core/db'` is compiled for the edge runtime as well,
`pg` and `node:url` do not exist there, and every `/api/**` route answered 500 instead of 401 —
the whole live-server block of `tests/auth.test.ts` went red. A guard inside the function does not
help, because the import resolves before the function is called.
