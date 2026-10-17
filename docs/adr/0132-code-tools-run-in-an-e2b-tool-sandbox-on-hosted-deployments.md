# ADR-0132 — Code tools run in an E2B tool sandbox on hosted deployments

Status: accepted
Date: 2026-10-10
Decided by: the review of PR #934 (issue #827; also #830, #831, #832), orchestrator decision on the PR
Scope: `apps/runner/src/tool-sandbox.ts`, `apps/runner/src/manager.ts`, `apps/runner/src/manager-start.ts`, `packages/runtime/src/external/`, `packages/gateway/src/tools/sandbox.ts`, `packages/cli/src/deploy/`

## Context

ADR-0118 puts a session's code tools and `stdio` MCP servers in a per-session tool sandbox, and
ADR-0120 LC5 places it with the same provider as the agent sandbox. A hosted deployment
(`aw deploy` to Vercel or Cloudflare with `RUNTIME_DRIVER=external`) had no tool host, so a push
with a code tool was refused with `422 code_tool_needs_host`. PR #934 starts the tool host as an
E2B sandbox from the `aw-tool-host` template.

Review found two problems in the first version:

- **The lifecycle lived in process memory.** Both hosted managers are stateless (ADR-0126). A
  `DELETE` served by another invocation found nothing in its table, so the tool sandbox, with the
  decrypted declared secrets and the last run token, lived until the E2B timeout (up to an hour on
  Hobby, a day on Pro). A changed tool set left the old sandbox behind the same way. That breaks
  ADR-0118 TS2 ("destroyed with the session").
- **The manager's `/tool-sandboxes/<id>/mcp` route was public.** It was served before the manager
  token check and added the E2B traffic token itself, so the manager's public URL was an ingress to
  the tool sandbox gated by the per-run token only. LC3 says only the traffic-token holder (the
  manager) reaches the port, and the manager's other routes all require `RUNNER_MANAGER_TOKEN`.

## Decision

- **Placement.** On `RUNTIME_DRIVER=external` with `EXTERNAL_PROVIDER=e2b` and
  `AGENT_WORKSPACE_TOOL_HOST_IMAGE` set, the manager starts the tool sandbox with a second external
  driver (`workload: 'tool-host'`) from that template, pinned as `<template>:<build_id>` in
  production (LC2). `aw deploy` renders the variable from `E2B_TOOL_HOST_TEMPLATE` for `external`
  only.
- **Isolation.**
  - The tool host's environment is an allow-list: the declared secrets of the session's tools, then
    only what the host cannot run without (ADR-0118 TS4). A secret cannot set `PATH`, `HOME`, a
    proxy or an `npm_config_*` variable.
  - The E2B provider key, the manager token and the gateway token never enter the sandbox. The key
    is sent per call (LC6). The sandbox has no runner bearer. The traffic token stays in the manager.
  - The network policy is `none` (no egress at all, not even the gateway) or `open` minus the
    always-denied ranges. `restricted`, that is a declared domain, is refused by name before E2B is
    called (LC4), until E7 proves E2B's allow rules cannot beat the denied ranges.
- **Lifecycle from provider metadata, not memory.**
  - Each tool sandbox is created with E2B metadata `awWorkspace`, `awSession`, `awSessionKey`
    (`profile:sessionId`) and `awTools` (the tool-set key). None of them is a secret.
  - Finding a sandbox again and closing it list the sandboxes through `GET /v2/sandboxes` filtered
    by that metadata, so any invocation sees what another one started.
  - Close kills every tool sandbox of the workspace and session. A stateless `DELETE` knows the
    session from the sealed handle's workspace path but not the run profile, so close covers every
    profile of the session.
  - Before a new tool sandbox starts, every sandbox the session key still holds is killed. That is
    an older tool set or one a lost invocation started. If that kill fails, nothing new is started.
  - If a kill fails, the manager writes an empty token list into a sandbox it knows, so the last
    run token stops working, and the `DELETE` fails so the caller retries. Otherwise the token dies
    with the sandbox. The gateway also refuses the token once the run is over.
- **Timeout backstop.** A tool sandbox lives at most `AGENT_WORKSPACE_TOOL_SANDBOX_TIMEOUT_SECONDS`
  (default 900, from 60 to 3600), capped by the session's runtime timeout. A stateless manager
  renews the deadline each time a run reuses the sandbox, so the timeout counts from the last run
  that opened it. On a stateful manager the timeout counts from creation, and the next run after
  it ends starts a fresh sandbox.
- **Authenticated manager ingress.** `POST /tool-sandboxes/<id>/mcp` is served after the manager
  token check, like every other manager route. It requires `authorization: Bearer
  <RUNNER_MANAGER_TOKEN>` and the per-run token in `x-aw-tool-authorization`. A missing token
  answers `401` before any sandbox lookup. The manager sends the run token on as the tool host's
  `authorization` and never forwards the manager token. The gateway is the only caller.
  `aw deploy` gives it `RUNNER_MANAGER_TOKEN` when a tool host is rendered, and it sends that token
  only to an origin whose path is the manager's route. A container origin (Docker) never receives
  it.
- **What stays refused.** `cloudflare-sandbox` declares no network policy (ADR-0131), so it starts
  no tool sandbox and keeps the typed refusal. `vercel-sandbox` has no tool host yet: it needs a
  provider file write and a tool-host seam. It renders no flag and keeps the refusal (deferred).
  Kubernetes and ACA keep theirs.

## Consequences

- An agent with a code tool can be pushed and run on a hosted `external` deployment, once a person
  has built `aw-tool-host` (`e2b-template.yml`, `template=tool-host`) and set
  `E2B_TOOL_HOST_TEMPLATE`.
- A run that lasts longer than the backstop loses its tools partway through. An operator with
  longer runs raises `AGENT_WORKSPACE_TOOL_SANDBOX_TIMEOUT_SECONDS`.
- The hosted gateway now holds `RUNNER_MANAGER_TOKEN` when a tool host is configured. That token
  lets the gateway reach every manager route, so a gateway compromise also reaches the manager.
- `list` reads one page of 100 sandboxes per filter. A session never comes near that many.
- Nothing has run against live E2B yet. The metadata filter, connect's renewal and the kill are
  covered by the E7 lane, as the rest of the E2B provider is.
- Rollback is a revert. Sandboxes started before the revert end at their timeout.
- Issue #832: a tool sandbox is also tagged with the run that started it (`awRun`), and the
  control plane releases it when that run ends (`DELETE /tool-sandboxes/runs/<runId>`), before the
  run's terminal status is written. Only what the run itself started is killed: a sandbox it reused
  and the session's agent runtime stay, so a run refused as `session_in_flight` cannot end the
  session's live run, and the agent runtime keeps its session-affine lifetime. A tool sandbox's E2B
  timeout is its run deadline (capped by the backstop) plus two minutes, so one whose release never
  came (a crashed manager or control plane) frees its slot soon after. E2B's 429 on create (the
  account's concurrent-sandbox cap) surfaces as `tool_sandbox_unavailable` naming the provider's
  concurrency limit, and is not retried.

## Alternatives rejected

- **Keep the in-memory table and only shorten the E2B timeout.** A stateless manager still never
  closes, and a changed tool set still leaves the old secrets alive until the timeout.
- **Record tool sandboxes in the database.** That puts a provider id in the control plane's store
  for a fact E2B already holds, and the manager has no database.
- **Gate the route by the per-run token alone.** The manager's public URL would stay an ingress to
  the sandbox that skips LC3's traffic-token boundary.
- **Send the manager token to every tool sandbox origin.** A Docker origin is the tool host itself,
  which runs the developer's code.
