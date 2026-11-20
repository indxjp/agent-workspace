---
title: Glossary
evidence: [docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md, apps/web/server/contexts.json, apps/web/server/application-context.ts:51, packages/run-protocol/src/schemas.ts:618-662, packages/contracts/src/run-events.ts:519-532, packages/core/src/db/repositories/scope.ts:111, apps/web/server/rbac/principal.ts:133]
---

| Term | Meaning here | Where in the code |
| --- | --- | --- |
| Workspace | the tenant; every row and object key belongs to one | `WorkspaceScope`, `packages/core/src/db/repositories/scope.ts` |
| Principal | the resolved caller of a request: person, API key, agent, guest | `apps/web/server/rbac/principal.ts` |
| Agent | stored instructions, model connection, permissions and grants | `AgentRecord`, `packages/core/src/db/repositories/agents.ts` |
| Agent version | an immutable numbered body; an environment pointer names which runs | `packages/core/src/db/repositories/agent-versions.ts` |
| Session | a conversation with one agent; runs continue in it | `SessionRecord`, `packages/core/src/db/repositories/runs/types.ts` |
| Run | one execution of an agent with its usage and cost | `RunRecord`, same file; status in `packages/contracts/src/runs.ts` |
| Engine | the agent harness that executes a run (Claude Agent SDK, OpenAI Agents, Mastra, pi) | `packages/engine-*`, port in `packages/engine/src/port.ts` |
| Provider | the model provider that served the calls, never the engine | `MODEL_PROVIDERS`, `packages/contracts/src/runs.ts` |
| Runtime, runtime driver | where a run's sandbox lives (local, Docker, Kubernetes, Cloud Run, ...) and the code that allocates it | `packages/runtime`, `apps/runner/src/manager-driver-*.ts` |
| Runtime manager | the runner process that allocates sandboxes and proxies to them | `apps/runner/src/manager*.ts` |
| RunRequest | the body of `POST /run` sent to the runtime | `packages/run-protocol/src/schemas.ts` |
| agent.* frame | one event of a run's stream; its id is the resume cursor | `AgentFrame`, `packages/contracts/src/run-events.ts` |
| Gateway | the model and tool proxy that swaps a run token for a stored credential | `packages/gateway` |
| Run token | short-lived credential a run uses at the gateway | `packages/gateway/src/tokens/run-token.ts` |
| Catalog | the rows that name stored objects; the only way to them | `apps/web/server/storage/service.ts` |
| Surface | a hosted chat for an agent on a customer page | `apps/web/server/surfaces/`, `packages/react` |
| Share link | a public `/p/<token>` link to a session selection, stored as a hash | `apps/web/server/shares/` |
| Builder | the built-in agent that edits agents through its own ports | `apps/web/server/builder/` |
| Context | one bounded group of server folders with a direction and an entry | `apps/web/server/contexts.json` |
| Shared kernel | server folders every context may use | `apps/web/server/{audit,features,http,...}` |
| Application context | the one object holding every built domain, read per request | `apps/web/server/application-context.ts` |
| Portal app | a customer's Next.js app built on the app kit | `packages/app`, `examples/` |
| Demo, guest | an Agent Store visitor's temporary workspace and its email-link identity | `apps/web/server/demo/`, `apps/web/server/email-link/` |
| Portable agent, platform target | a definition that exports to other agent platforms | `packages/platforms`, `packages/contracts/src/portable-agent.ts` |
