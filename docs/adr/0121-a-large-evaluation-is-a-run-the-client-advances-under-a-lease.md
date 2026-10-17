# ADR-0121 — A large evaluation is a run the client advances under a lease

Status: accepted
Date: 2026-10-07
Decided by: the issue #799 plan (D2), reviewed in the pull request
Scope: `apps/web/server/evaluations/runs.ts`, `apps/web/app/api/agents/[id]/evaluation-runs` and `evaluation-advance`, `agent_version_evaluations` (`status`, `lease_until`), `packages/contracts/src/evaluations.ts`, `aw eval run`

## Context

[ADR-0106](0106-evaluation-gates-promotion-and-production-is-watched.md) makes a stored evaluation
the gate for promotion. `POST /api/agents/:id/evaluations` runs every case inside one request, so
it is bounded by the host's HTTP timeout and holds 20 cases (`EVALUATION_CASE_LIMIT`). A real
regression suite needs about 200.

The control plane has no job queue and no worker process: it is request-scoped Next.js route
handlers, and `aw dev` runs the same code in one process. A response that outlives the host's
240 s timeout is cut off, and so is the work behind it.

## Decision

A run of up to 200 cases is stored first and executed in steps, each step a request the **client**
makes.

- `POST /api/agents/:id/evaluation-runs` stores a `running` row holding the cases and answers 202.
  Nothing runs.
- `POST /api/agents/:id/evaluation-advance` claims the row's **lease** (`lease_until`, an atomic
  `UPDATE … WHERE status = 'running' AND (lease_until IS NULL OR lease_until < now())`), runs the
  next cases with the same `runCase` the synchronous route uses, stores each result as it lands,
  and stops starting cases after 120 s. Each case has a 100 s deadline, so a step answers inside
  240 s. At least one case runs per step, so every step progresses. A second step while the lease
  is held is `409 evaluation_run_busy`; a step on a completed run is answered unchanged.
- `GET /api/agents/:id/evaluation-runs?evaluation=<id>` reads a run at any status.
- A request that dies leaves its lease to expire; the next step resumes at the first case with no
  stored result. The promotion gate (`latest`) reads only `completed` rows, so a half-run
  evaluation never gates anything.
- The synchronous route is unchanged: 20 cases, 201. `aw eval` uses it for small files, so a CLI
  talking to an older server keeps working.

Two routes are siblings (`evaluation-runs`, `evaluation-advance`) and not `evaluation-runs/:id/advance`
because the RBAC decision (`server/rbac/decide.ts`) admits only `/api/<resource>/:id/<sub>`; a
deeper path is refused outright, and each sub-resource is declared with its reason.

## Rejected

- **A background job** in the web process: nothing supervises it, a deploy or a scale-to-zero ends
  it silently, and `aw dev` and the hosted deployment would differ. A queue and a worker are a new
  service for one feature.
- **Streaming one long request**: the host's timeout still ends it, and a dropped connection loses
  the cases already run.
- **Raising `EVALUATION_CASE_LIMIT`**: it bounds the length of one request; raising it only moves
  the timeout.

## Consequences

- The client owns progress: `aw eval run` calls advance until `completed` and prints the run's id
  if it is interrupted. There is no resume command yet.
- An abandoned `running` row stays in the table and is never gated on. Expiry and cleanup are a
  follow-up.
- During a mixed rollout, code that predates migration 0044 reads `latest` without the status
  filter and could read a `running` row. This matters only if a run is started during the rollout.
- A 200-case run spends up to 200 model runs and as many judge calls, under the existing run
  limits; there is no new budget guard.
- `--min-score`, `--junit` and `--baseline` are CLI-only: the server stores and reports, the CLI
  decides the exit code.
