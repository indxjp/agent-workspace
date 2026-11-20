---
title: How it runs
evidence: [apps/web/server/runs/api.ts:79-94, apps/web/server/runs/launcher-execution.ts:70-90, apps/web/server/runs/relay.ts:300-315, apps/runner/src/server.ts:255-262, apps/runner/src/engines.ts:40-65, apps/web/server/composition/register.ts:68-101, docs/architecture.md:313-331, docs/architecture.md:597-622, packages/aw/src/main.ts:1-11, docs/adr/0151-a-stopped-run-holds-no-lease-and-run-start-is-idempotent.md]
---

### Start a run

`POST /api/agents/:id/runs` reaches `startRun` (`apps/web/server/runs/api.ts:79`). It reads the run
domain from the application context and answers 503 if runs are `disabled` (no runner configured).
It authenticates the principal, refuses a malformed agent id with `400 invalid_agent_id`, resolves
ownership, checks run permission, and calls `startAuthorisedRun`. The start is idempotent: an
`Idempotency-Key` is stored per principal with the hash of the canonical request, so a replay
returns the original run and a different request under the same key gets
`409 run_idempotency_conflict` (ADR-0151). Preflight and refusal mapping live in `start-input`,
`start-preparation` and `start-refusal`.

<!-- jevlint:diagram flow:start-run -->

The launcher then asks the runtime manager for a sandbox and posts the `RunRequest` to
`${base}/run` (`launcher-execution.ts:76`), carrying `traceparent` and a bearer token when one is
set. `relay.ts` reads the SSE answer into stored frames; a status other than 200 fails the run with
a public reason (`relay.ts:312`).

**Where it fails:** a disabled run domain (503), a refused preflight (spend ceiling, daily cost cap,
demo gate), an idempotency conflict (409), no sandbox capacity, or a runtime that does not answer
200. Interrupting a live run reaches only the replica that launched it (issue #261); orphaned runs
are failed by the stale sweep under a database lease.

### Execute a run in the sandbox

The runtime server inside the sandbox accepts `POST /run` and its alias `/invocations`
(`apps/runner/src/server.ts:259`). Admission parses the `RunRequest`, resource verification checks
every granted file's size and checksum against the archive the control plane streamed, and
`run-execution.ts` starts the engine that `engines.ts` loads by dynamic import. An engine whose
package is not in the image answers `engine_not_installed` (comment above `ENGINE_MODULES`).

<!-- jevlint:diagram flow:execute-run -->

The answer is an SSE stream of `agent.*` frames whose ids are resume cursors. A gated tool call
stops the run as `awaiting_approval`; it holds no lease, and an approval continues it as a new run
in the same session (ADR-0145).

### Boot the control plane

Next.js calls `register()` once per server process (`apps/web/instrumentation.ts`).
`register.ts` reads settings and opens the database, then `registerOpenedDatabase` calls the
`wire<Domain>` functions and finally `installApplicationContext` once. If wiring throws, nothing is
installed and the pools opened so far are closed (`docs/architecture.md:313-331`).

<!-- jevlint:diagram flow:boot-control-plane -->

**Where it fails:** no session secret or no reachable database means no context at all, and every
route answers its 503. A missing runner disables the six run-dependent domains together.

### Run an aw command

`aw` parses arguments, resolves the profile and credential, creates an SDK client and runs one
command per SDK method (`packages/aw/src/main.ts`). The SDK sends `CONTRACTS_VERSION`, validates the
answer and turns a problem into a typed error; `aw` prints a table or JSON and exits with a stable
code. `aw deploy` and `aw publish` load the project CLI through `cli-bridge.ts`.

<!-- jevlint:diagram flow:aw-command -->
