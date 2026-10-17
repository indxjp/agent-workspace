# W1-COMP-01 — The launcher's `POST /run` body becomes a required argument

Status: accepted
Date: 2026-09-03
Decided by: W1-COMP-01 (the composition root)
Scope: `apps/web/server/runs/launcher.ts` and `launcher.test.ts`,
`apps/web/server/runs/acceptance/instrumentation.ts`, `apps/web/server/runs/api.test.ts`
(one construction each); new file `apps/web/server/compose/run-request.ts`. Claimed under
[ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) with the reason below.

## Context

`createRunnerLauncher` posted this to `POST {runner}/run`:

```ts
body: JSON.stringify({ runId, sessionId: context.session.id, agentId: context.agent.id, prompt })
```

It had never been sent to a runtime. W1-CP-04's acceptance drove `fake-runner.mjs`, which reads
`runId` and `sessionId` and ignores the rest; W1-RN-02's acceptance drove the real server with
bodies of its own. The first request from the one to the other was made by this task:

```text
$ curl -s -i -X POST http://127.0.0.1:8099/run -H 'Content-Type: application/json' \
    -d '{"runId":"…","sessionId":"…","agentId":"…","prompt":"hello"}'
HTTP/1.1 400 Bad Request
{"error":"invalid_run_request","message":"the request body is not a valid RunRequest.","issues":[
  {"path":["cwd"],   "message":"Invalid input: expected string, received undefined"},
  {"path":["agent"], "message":"Invalid input: expected object, received undefined"},
  {"path":["session"],"message":"Invalid input: expected object, received undefined"},
  {"path":["scope"], "message":"Invalid input: expected object, received undefined"},
  {"path":["env"],   "message":"Invalid input: expected record, received undefined"},
  {"code":"unrecognized_keys","keys":["agentId"],"message":"Unrecognized key: \"agentId\""}]}
```

§14.3's body is `RunRequest` from `@agent-workspace/core`. It is `.strict()`, it needs the agent's
model, instructions, tool policy, skill policy and connectors, the sandbox `cwd`, the §25 tenant
session scope and the subprocess environment — and it forbids `agentId`, which travels inside
`agent`. None of that is in `LaunchContext`, whose `agent` is `{ id, workspaceId }`.

## Decision

**`RunnerLauncherOptions` gains `buildRunRequest(context)`, required, with no default.**

The launcher keeps everything it was already right about — the connect deadline that must not
become a run deadline, the relay, the terminal status written to the store rather than to the HTTP
response — and stops pretending to know what a run request is. The body is composed by
`apps/web/server/compose/run-request.ts`, from an agent record read out of the store and the
deployment's `RUNNER_URL` / `RUNNER_WORKSPACE_ROOT`, and it ends with `RunRequest.parse` — the same
schema the runner parses with, so a body that would be refused on the wire fails on this side,
before a 202 has been answered, and is written to the run as a named failure.

**No default, and the two candidates are both worse than requiring it.** Keeping today's four
fields as the default preserves a body that is known not to work, under a signature that says it
does. Importing `RunRequest` into the launcher and filling it in would put a fabricated agent
configuration on the wire under a schema that validated it — the worst of the available outcomes,
because it would look right.

## Why this task edits another task's file

ADR-0018 makes the declared `Owns` line the boundary provided the globs are disjoint from
siblings, CI passes, and every glob outside the plan's card carries its reason. This is the
reason, and it is the same shape as
[W1-INT-02's](W1-INT-02-a-repository-wide-route-rule-is-satisfied-not-narrowed.md): the defect is
a disagreement *between* two tasks' files, neither of which could see the other, and the repair
lands above both so that nothing below is rewritten and nothing is restacked. W1-CP-04 is frozen
several branches down. ADR-0017 rule 5 is what makes cross-cutting wiring a task at all, and a
wiring task that could not adjust a seam it is the first caller of would be a wiring task that
cannot wire.

The edit is four lines of behaviour: one field, one `try`/`catch` around it, one `JSON.stringify`
of the result, one deleted object literal. The three other constructions in the repository are
updated in place, and `launcher.test.ts` gains a case for the new failure path.

## Consequences

**A body that cannot be built fails the run, and posts nothing.** The caller already holds a 202
and a stream URL, so the store is the only place left to say so: `markRunning`, a `running`
platform event, then `failed` with `the run request could not be built: <reason>`. A client that
reconnects learns about it by replay, like every other terminal status. `launcher.test.ts` asserts
the transcript and asserts that `fetch` was never called.

**`launcher.test.ts` no longer asserts the shape of the body**, because the launcher no longer
decides it. It asserts that whatever the composer returned arrives unchanged. The shape is
asserted where it is decided, in `run-request.test.ts`, against `RunRequest` itself.

**The acceptance harness keeps its four fields.** `apps/web/server/runs/acceptance/` drives
`fake-runner.mjs`, which is not the §14.3 validator and never was. Giving that probe a real
composer would make it a second composition root; it now passes the four fields its own fixture
reads, with a comment saying so.

## Alternatives rejected

* **Fix it in `apps/runner` by relaxing `RunRequest`.** The strictness is the contract, and R-01 §4
  is the reason it is strict: an unknown key is a setting one side believes was honoured.
* **Compose the body inside `launcher.ts` by importing the agent store.** It would give this module
  a dependency on `apps/web/server/agents/**` and on the deployment's environment, both of which
  its own header says it deliberately does not have.
* **Wrap `fetch` in the composition root to rewrite the body.** Available, one line, and a lie: the
  module's signature would still say it builds a request it does not build.
* **Declare the mismatch and stop.** The honest minimum, and the reason this task exists is that
  three tasks in a row have correctly done exactly that.
