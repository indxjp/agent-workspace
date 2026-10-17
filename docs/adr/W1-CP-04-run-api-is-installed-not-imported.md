# W1-CP-04 — The run API is installed at composition time, refuses to serve until it is, and keeps its registry on `globalThis`

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-04 (Control Plane)
Scope: `apps/web/server/runs/environment.ts`, `apps/web/app/api/runs/**`,
`apps/web/app/api/agents/[id]/runs/**`; binding on W1-CP-06 (auth), W1-CP-05 (agents),
W1-RN-02 (runtime) and W1-INF-01 (composition)

## D1 amendment

The five-member `RunApiEnvironment` in this decision was its initial shape. The current installed
environment has nine members; see `apps/web/server/runs/environment.ts`. The installation and
missing-configuration rule of this ADR still applies.

## Context

The three §34 run endpoints need four things this branch does not have:

| What the routes need | Who owns it | On this branch? |
| --- | --- | --- |
| an authenticator and a workspace-scoped principal | W1-CP-06, `apps/web/server/auth/**` | no |
| the agent record | W1-CP-05 / W1-DB-01 | no |
| a durable run store | W1-DB-01 (`run_events` needs a table) | no |
| something that produces run events | W1-RN-02 (`apps/runner`) | no |

They are all at the same stack level as this task (plan §6.3), so none of them can be imported.
Worse, the obvious workaround — depend on `@agent-workspace/core` and read the database directly —
requires editing `apps/web/package.json`, which is **not** in this task's `Owns` globs.

Three shapes were available, and two of them are the ADR-0015 failure written out in advance:

* **Serve with defaults.** An unauthenticated route that returns an empty stream is a capability
  presented as working because nothing about it threw.
* **Serve with a built-in in-memory fallback.** Better behaved and worse: an operator who forgot to
  configure PostgreSQL gets a server that runs, streams, and silently loses every transcript on
  restart. Spec §12 and §41 exist to stop exactly this.
* **Refuse.**

## Decision

**1. One interface, `RunApiEnvironment`, with five members**: `authenticate`, `findAgent`,
`openSession`, `store` and `launch`. The route handlers know nothing else about the rest of the
control plane, and each of the four owners above fills in its own member.

**2. Nothing is installed by default, and an uninstalled run API answers `503
run_api_not_configured` with a message naming what is missing.** Specifically it does **not**
answer `401`, which would promise the caller that credentials could fix it, and does not answer
`200`. W1-CP-06's acceptance criterion ("an unauthenticated request to any `/api/**` route returns
401") becomes reachable the moment it installs an authenticator; until then the honest status for a
server with no authenticator at all is "not configured".

**3. `authenticate` returning a principal is a positive assertion.** The interface documents that
an implementation must not return a default principal when it finds no credentials. A `null` is the
only way to say "no credentials", and it maps to 401.

**4. The registry lives on `globalThis`, under
`__agentWorkspaceRunApiEnvironment__`, not in a module-level `let`.** This is not style. Observed
on `next@16.3.4` during this task's acceptance run: an `instrumentation.ts` that imported
`environment.ts` and called `installRunApi` logged its own success, and in the *same server
process* `GET /api/runs/:id` answered `503 run_api_not_configured`, because Next compiles
`instrumentation` and the route handlers into separate module graphs and each held its own copy of
the variable. A property on the global object is shared by every bundle in one Node process. The
scope this buys is exactly one process, which is correct: what is being registered is per-process
wiring.

## Alternatives considered

* **Import the real modules and let the branch not compile until they exist.** Rejected: it makes
  this task undeliverable and unverifiable, and the acceptance criterion is about streaming, not
  about auth.
* **Add `@agent-workspace/core` to `apps/web/package.json` anyway.** Rejected: it is another task's
  file and CI enforces ownership from the PR body. Escalating (plan §3.5) would have blocked the
  streaming pattern behind a dependency question. Recorded as a declared gap instead.
* **A DI container.** Rejected under §40 and §53: one object and two functions is the whole need.
* **`AsyncLocalStorage` or a request-scoped context.** Rejected: the environment is process-wide
  wiring, not request state, and per-request installation would let one request's configuration
  leak into another's.
* **A module-level singleton plus "just don't use instrumentation".** Rejected: it makes the
  correctness of the wiring depend on which file happens to import it first, and the bundling
  behaviour that broke it is Next's, not ours — it would break again from a different direction.

## Consequences

* Every §34 run route on this branch answers 503 unless something installs an environment. The only
  thing that does so in this repository is the acceptance harness
  (`apps/web/server/runs/acceptance/instrumentation.ts`), which is gated behind a mandatory
  `AW_ACCEPTANCE_HARNESS=1` and is not imported by any committed application file.
* **The 401 path is unit-tested but not exercised by a real authenticator.** It is declared as such
  in the PR.
* W1-CP-06 and W1-INF-01 must add a real composition point (`apps/web/instrumentation.ts` is the
  natural one) that calls `installRunApi`. This ADR is the contract they build against, and the
  `globalThis` finding above is the trap they would otherwise re-discover.
* A future second process (a worker) gets its own registry. That is right for wiring and wrong for
  run state, which is why the run store is a port rather than a process-local structure — see
  `W1-CP-04-run-events-are-in-process-in-wave-1.md`.
