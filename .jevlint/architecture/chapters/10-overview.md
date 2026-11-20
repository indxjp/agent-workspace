---
title: Overview
evidence: [docs/architecture.md:8-37, README.md, apps/web/server/runs/api.ts:79-94, apps/web/server/runs/launcher-execution.ts:76, apps/runner/src/server.ts:259, apps/runner/src/engines.ts:60-65]
---

Agent Workspace runs AI agents for a team, on infrastructure the team chooses. A workspace member
defines an agent (instructions, model connection, files, skills, connectors, a runtime profile),
talks to it in sessions, and shares it as a hosted chat surface, an A2A endpoint or a portal app.
Developers drive the same platform from the `aw` command line, the TypeScript SDK or a generated
project. The product is one control plane (`apps/web`), one runner (`apps/runner`), one gateway
(`packages/gateway`) and a set of published packages under `@indx-workspace/*`.

### The main workflow in one paragraph

A caller sends `POST /api/agents/:id/runs`. The route hands the request to `startRun` in
`apps/web/server/runs/api.ts`, which authenticates the principal, checks run permission and starts
an authorised, idempotent run: the run row is stored as `queued` in PostgreSQL through
`packages/core`. The launcher then asks the runner's runtime manager for a sandbox and posts a
`RunRequest` to `${base}/run` over HTTP (`launcher-execution.ts:76`). Inside the sandbox the
runner's runtime server (`apps/runner/src/server.ts:259`) checks the granted files' checksums,
loads one engine adapter through `apps/runner/src/engines.ts`, and streams `agent.*` frames back as
server-sent events. Every model call the engine makes goes to the gateway, which swaps the
short-lived run token for the stored provider credential. The control plane stores the frames and
settles usage and cost on the run.

### Who uses it

| Caller | Enters through | Credential |
| --- | --- | --- |
| Workspace member in a browser | `apps/web/components` screens, through the SDK | signed sign-in session cookie |
| Developer or CI job | `aw`, the SDK, `create-agent-workspace` | API key or CLI token |
| Visitor of a surface or portal app | public pages, `@indx-workspace/react`, `@indx-workspace/app` | browser token or share link |
| External agent | the A2A endpoint | API key or OAuth access token |
| Scheduler | cron route and trigger fire URL | cron secret or trigger secret |

The diagram shows what the system talks to. Solid arrows are imports in the code; dashed arrows are
HTTP calls between processes, which the import graph cannot show.

<!-- jevlint:diagram context -->
