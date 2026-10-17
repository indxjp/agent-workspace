# W1-INF-01 — Phase 0 is not met: the stack comes up, the browser cannot reach a run

Status: accepted
Date: 2026-09-03
Decided by: W1-INF-01 (Infra, wave integrator)
Scope: the Wave 1 exit criterion; W1-CP-04, W1-CP-05, W1-CP-06, W1-UI-02, W1-RN-02 and whoever
owns the composition root

## Context

Spec §46 states the Phase 0 goal in one sentence — *"Run one Claude Agent SDK agent through a
browser on a self-hosted machine"* — and its completion criteria as a sequence: `docker compose
up -d`, then **Create Agent → enter instructions → select Claude → Run → receive streamed result**.
This task's acceptance criterion is that sentence, and this task is the last one in the wave, so
"W1-INF-01 passed" and "Phase 0 is met" would be read as the same claim by every later wave.

They are not the same claim here. **The infrastructure works and the product does not.** This
record exists so that nobody has to rediscover which is which, and so that the difference is stated
before anyone builds Phase 1 on top of it.

Everything below was executed against the images this branch builds, on 2026-09-03, on the branch
tip `aw/w1-11-compose` at the commit this record lands in. The full transcript is in this task's
PR body.

## What was demonstrated to work

* `docker compose up -d` on a clean machine brings up **five** services (§33). `postgres`, `minio`,
  `runner` and `web` all reach `healthy`; the `gateway` placeholder logs its refusal banner.
* `web` migrates the schema and seeds on first start. The database afterwards holds exactly one
  workspace, one user (`admin@example.com`, the `BOOTSTRAP_ADMIN`) and one agent named **General** —
  §19.5 rule 3's built-in agent, as an ordinary row.
* A real Chrome tab at the published port renders the §44 shell and the §45 home composer.
* `POST /run` on the `runner` container answers **200 `text/event-stream`** and streams framed,
  id-numbered SSE events off the **real Claude Agent SDK running inside the container**: `retry`,
  `system/init`, an `assistant` event, a `result` event, and a terminal `run-failed` frame. The
  §14.3 contract, `apps/runner/src/claude.ts`'s SDK boundary and the SSE framing are all live.
* The sandbox image (`runtime.Dockerfile`) builds, runs as uid 1000, answers `/healthz` 200 and
  answers `/files` `501 not_implemented` by name.

## Where the chain breaks, in order, and who owns each break

**1. A browser cannot obtain a session.** There is no sign-in page and no sign-in route. `/login`
and `/signin` are `404`; `/api/auth/signin` is `401` from the gate, because the route does not
exist and `apps/web/middleware.ts` answers before routing. `apps/web/server/auth/session.ts`
exports a working `signIn()` and **nothing calls it**. So every `/api/**` request from a browser is
`401 no_session_cookie`, including `POST /api/agents`. *Owner:* W1-CP-06, which declared this in
`W1-CP-06-the-gate-covers-api-only.md` — *"no Wave 1 task owns a sign-in page"*.

**2. Nothing installs the application's wiring.** `apps/web/server/agents/runtime.ts` reaches its
store through `configureAgentsRuntime`, and `apps/web/server/runs/environment.ts` reaches its
authenticator, agent lookup, run store and launcher through `installRunApi`. Across the whole tree,
the only callers of either are unit tests and W1-CP-04's acceptance harness. There is no root
`apps/web/instrumentation.ts` and no other composition root, so both answer `503 …_not_configured`
by design. *Owner:* unassigned. W1-CP-04 and W1-CP-05 each declared the composition root outside
their ownership (`W1-CP-04-run-api-is-installed-not-imported.md`,
`W1-CP-05-agents-api-has-no-core-dependency.md`) and named "integration" as its home; the wave's
task cards give that file to nobody, including this one.

**3. The home screen can never offer an agent.** `apps/web/app/(shell)/page.tsx`'s
`composerAgents()` has two branches and both return `no-agents`: one for "no store installed", one
for "the workspace cannot be resolved", the latter because the session cookie carries the workspace
*slug* while `AgentStoreProvider.forWorkspace` takes a `workspaces.id`. The screen says so honestly
— *"No agent store is configured — nothing can run yet."* — with the pickers disabled, and it says
it even now that the seeded **General** agent is in the database. *Owner:* W1-UI-02, which declared
it in its own file header.

**4. The composer does not send.** Clicking **Send** with a prompt typed produces no network
request at all. There is no client call to `POST /api/agents/:id/runs`. *Owner:* W1-UI-02.

**5. The two halves of the run contract do not agree.** `apps/web/server/runs/launcher.ts` posts
`{runId, sessionId, agentId, prompt}`; `apps/runner/src/server.ts` parses the body as
`RunRequest`, which is `.strict()` and additionally requires `cwd`, `agent`, `session`, `scope` and
`env` while forbidding `agentId`. Even with breaks 1–4 repaired, that request is a `400
invalid_run_request`. Nothing between W1-CP-04 and W1-RN-02 compiles the agent row into a
`RunRequest`. *Owner:* the same unassigned integration seam as break 2 — it is the compile step
§5 puts between the database and the SDK, and `packages/core/src/config.ts` is the half that exists.

**6. There is no configured path for a provider credential.** Spec A.11 is explicit that a provider
master credential never enters a sandbox: the gateway holds it and injects a run-scoped
`ANTHROPIC_AUTH_TOKEN`. The gateway is Wave 4 and `compose.yaml` runs a placeholder that refuses
every request, and §27's schema has no model-connection credential storage wired to anything. The
probe run above proves this from the inside: the SDK started, reported `apiKeySource: "none"`, and
the stream's terminal frame carried *"Not logged in · Please run /login"*. *Owner:* Wave 4
(`W4-GW-*`) for the real path; Wave 1's "one model connection: Anthropic" line in §46 has no
implementing task card in the development plan §6.

## Decision

**Land the infrastructure, and state that Phase 0 is not met.** This task returns `escalated:
true`. `compose.yaml`, both Dockerfiles, `.dockerignore` and `.env.example` are complete, executed
and correct on their own terms, and the six breaks above are all outside this task's ownership
globs and all in other tasks' code.

The alternative — reaching into `apps/web` and `apps/runner` to write the composition root, a
sign-in route and a request compiler — was rejected for three reasons, in increasing order of
weight. It is outside the declared `Owns` line (ADR-0018). The wave script's own brief for this
task says *"Do not fix other tasks' code; report conflicts instead"* (the development plan §7.2).
And an integrator who repairs six tasks silently destroys the wave's signal: the next wave would
inherit a green Phase 0 with no record of which six pieces were never actually built by the tasks
that were paid to build them.

**Phase 0 is not met, and this record is the reason a later wave may not assume it was.** §46's
last line — *"No other features are required before this works reliably"* — is a instruction to
close these six before Phase 1, not a licence to move past them.

## Alternatives rejected

* **Declare Phase 0 met because the infrastructure passed.** This is the exact failure ADR-0015
  names: a capability asserted because the part that was tested did not fail. The criterion is a
  browser reaching a streamed answer, not a stack reaching `healthy`.
* **Declare it met on the strength of the runner's SSE stream.** The stream is real and it is not
  the criterion. It was reached by `docker compose exec`, from inside the private network, with a
  hand-written `RunRequest` no part of the product can currently produce — and it ended in
  `run-failed`, not in a Claude answer.
* **Commit W1-CP-04's acceptance harness as the composition root.** It authenticates every request
  unconditionally and stores runs in memory. Its own header forbids exactly this. Wiring it into
  `compose.yaml` would produce a demo that satisfies §46's script and ships an open control plane.
* **Ship a `compose.yaml` that hides the breaks** — no `web` service, or a `web` that serves the
  `ui/` mockups. Rejected: the mockups are already in the tree for anyone who wants to see the
  intended product, and a compose file that runs them would be this file lying about what is built.

## Honest downside

This wave ends with a working deployment of a control plane that cannot yet run an agent, and a
Phase 0 that four separate later phases assume. That is expensive. It is less expensive than the
alternative, which is a `true` in a wave manifest that nobody can trace back to an executed
scenario — and this programme has already paid, three times in Wave 0, for gates that passed
because nothing failed.

The second downside is that break 2 and break 5 have **no owner at all**, and this record does not
create one; it only says so. Assigning them is a plan amendment (§11), not an infra decision.
