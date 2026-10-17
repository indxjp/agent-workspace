# ADR-0084 — Mastra runs a plain agent, with memory over the platform's store, behind the port

Status: accepted
Date: 2026-09-29
Decided by: the implementer of ENG-10 (agent-engines programme, tracker #299, unit ENG-10, issue
#309), within the issue's development policy and the orchestrator's instructions of 2026-09-29
Scope: `packages/engine-mastra`; `packages/contracts/src/{engines,agents}.ts`;
`packages/core/src/db/schema/agents.ts`; `migrations/0031_*`;
`apps/web/server/engines/registry.ts`, `apps/web/server/compose/run-request.ts`,
`apps/web/server/agents/store.ts`, `apps/web/components/agents/agent-detail.tsx`;
`apps/runner/src/{engines,session-state}.ts`, `apps/runner/types/engine-modules.d.ts`;
`tests/no-sdk-import.test.ts`; `packages/aw/src/commands/agents.ts`;
`formal/AgentWorkspace/Behaviour/Engines/Mastra.lean`

## Context

ADR-0065 scheduled Mastra as the fourth engine, after the OpenAI Agents SDK (ADR-0074) and pi
(ADR-0081). Mastra (`@mastra/core`, Apache-2.0) is a TypeScript agent framework: an `Agent` runs a
model with tools, a `Workspace` offers file and command tools over a filesystem and a sandbox and
discovers `SKILL.md` skills, `@mastra/mcp`'s `MCPClient` reaches MCP servers, and `@mastra/memory`'s
`Memory` keeps a conversation as a thread of messages on a storage adapter. It also ships a server
(`mastra dev`), a coding harness (`Harness`/`createCodingAgent()`), wrappers around other engines,
observability exporters and usage telemetry. This ADR records which of those the adapter uses and
how it configures them. No Mastra server process is needed: an `Agent` runs in process.

## Decision

<a id="d1--a-plain-agent-and-a-workspace"></a>

### D1 — A plain `Agent` over a `Workspace`; nothing else of Mastra's runtime

The adapter builds one `Agent` per run, with a `Workspace` and a `Memory`, and calls
`agent.stream()`. It never constructs a `Mastra` instance (so there is no server, no registry, no
storage and no observability to export through), never uses `Harness`/`createCodingAgent()`
(modes, goals and background tasks are not platform concepts), never uses `@mastra/claude` or any
wrapper of another engine (the platform already runs Claude natively), and never uses workflows,
`.network()` or sub-agents. Mastra is pinned exactly (`@mastra/core` 1.71.0, `@mastra/mcp` 2.1.0,
`@mastra/memory` 1.32.1); `boundary.ts` is the one file importing Mastra and the two AI SDK
providers, and imports them lazily (D4).

<a id="d2--memory-is-journalled-into-the-platform-store"></a>

### D2 — Memory is journalled into the platform's store; the sandbox has no database

Design (a) of the issue: a storage adapter implementing only Mastra's `memory` domain over the
engine-scoped store. Mastra's `MastraCompositeStore` accepts a single domain, and `MemoryStorage`
has nine abstract methods and defaults for the rest (observational memory, resources, cloning), so
nothing else needs stubbing. The adapter subclasses Mastra's own in-process `InMemoryMemory` — the
query semantics (pagination, ordering, filters) stay Mastra's — and journals every `saveThread`,
`updateThread`, `saveMessages` and `updateMessages` into one store stream per thread before the
call resolves: one entry per record, keyed `thread` or `message:<id>`, which the runner uses as the
idempotency key so an updated message replaces its entry. A resume loads the stream, refuses one
that is not this thread's (a missing thread record, a message of another thread, an entry this
adapter does not write), and replays it into the in-process domain before the run. Deletions are
refused from inside a run. Design (b) — LibSQL in a file snapshotted to a blob — was not needed.

The thread id is the engine session id: the platform session id, or on a resume the id an earlier
`agent.session` reported. The resource is the run's `projectKey` (the tenant namespace), not the
session owner's principal id the issue names: `EngineRunRequest` carries no principal, and with
semantic recall and working memory off (D3) the resource scopes nothing but ownership of the
thread. No **platform** database credential enters the sandbox: `compile` refuses a request whose
platform environment (`request.env`) carries one (`DATABASE_URL`, `*_DATABASE_URL`, libpq's `PG*`,
`LIBSQL_*`, `TURSO_*`) as `engine_credential_refused`, and Mastra is never given a database
adapter. This covers only the platform's own environment: a tenant's stdio connector may still
carry its own database secret in its own `env` (D7), merged in after this check, so a tenant
Postgres MCP server keeps working (Owner decision on #309).

<a id="d3--no-model-calls-outside-the-run-connection"></a>

### D3 — Nothing calls a model outside the run's connection

Semantic recall (embeddings), working memory and thread-title generation are off: each is an extra
model or embedding call that would not go through the run's connection. `lastMessages` is fixed at
40. The policy arm carries no memory option.

<a id="d4--telemetry-and-exporters-are-off"></a>

### D4 — Telemetry and exporters are off

Mastra's usage telemetry is a PostHog client inside the `Mastra` class, switched off by
`MASTRA_TELEMETRY_DISABLED`; its model-catalogue refresh is switched off by `MASTRA_OFFLINE`. Both
are read from the process environment when Mastra's modules load, so `boundary.ts` imports Mastra
lazily, after setting both to `1`. With no `Mastra` instance there is no observability exporter to
configure. The boundary suite replaces the process's `fetch` with the scripted gateway and asserts
every request of a whole run — five model calls, a skill, a read, an edit and a command — went to
the gateway and nowhere else.

<a id="d5--the-model-is-an-explicit-provider"></a>

### D5 — The model is an explicit AI SDK provider at the gateway

Anthropic-family connections use `createAnthropic({ baseURL: <gateway>/v1, authToken: <run token> })`
(so the run token travels as `Authorization: Bearer` and no `x-api-key` is sent); OpenAI-family
connections use `createOpenAI({ baseURL: <gateway>/v1, apiKey: <run token> })`, with `.responses()`
for `openai-responses` and `.chat()` for `openai-chat-completions`. Mastra's `"provider/model"`
strings are never used: its router reads provider keys from the environment and would bypass the
gateway. The adapter advertises all three protocols, Anthropic Messages first; each connection is
reached in its own dialect and the gateway never translates. A run naming no model compiles
`claude-sonnet-4-5` or `gpt-5`, both rows of the provisional price table.

<a id="d6--permissions-and-grants"></a>

### D6 — Permissions select workspace tools; grants are enforced by wrapping the filesystem

`readFiles`, `writeFiles` and `runCommands` select Mastra's own workspace tools (`read_file`,
`list_files`, `grep`, `file_stat`; `write_file`, `edit_file`, `mkdir`, `delete`;
`execute_command` and the process tools — each `mastra_workspace_`-prefixed). The workspace's tool
configuration disables every tool by default and enables exactly the plan's; `ast_edit`, search,
index and LSP are always off. The command tools are withheld while a read-only grant exists, as on
the other engines. File grants are enforced by a `LocalFilesystem` subclass (`contained: true`)
that checks every mutating call — write, append, delete, copy, move, mkdir, rmdir — first on the
path as named (a leading `~`, an absolute path outside the workspace, the root, `..` out, the
adapter's `.mastra` directory and every read-only grant are refused) and then on the path with its
symbolic links resolved. `LocalSandbox` runs in the request's environment, never the runner's; the
runtime driver is the isolation boundary and no remote sandbox is used. Tool approvals are not used.

<a id="d7--skills-mcp-limits"></a>

### D7 — Skills, MCP and limits

Skills are placed under `.mastra/skills/<name>/` and handed to the workspace as its skill paths;
Mastra adds its `skill`, `skill_search` and `skill_read` tools exactly when a skill is granted.
Connectors become `MCPClient` servers: a stdio server gets the request's environment plus its own
and none of the runner's (`inheritDefaultEnv: false`), an HTTP server's requests are confined to its
own host (`allowedHosts`), a tool the connector's policy blocks is removed, and a tool whose policy
asks for an approval is refused by name. Their tools (`<server>_<tool>`) are `agent.tool.call
{kind: 'mcp'}`. `limits.maxTurns` is Mastra's native `maxSteps`, and a run whose last allowed step
still asked for tools ends `max_turns`. `limits.maxBudgetUsd` is priced per step from the port's
provisional table (ADR-0074 D7, shared by ADR-0081) and aborts the stream `max_budget`; billing
stays the gateway's `run_usage_records`, and `agent.result.engineCostUsd` is `null`. A fork is
refused (`fork: false`): a Mastra thread is continued, not branched. Interrupt is `abortSignal`.

<a id="d8--the-policy-arm"></a>

### D8 — The policy arm

`{ engine: 'mastra', toolCallConcurrency?, withheldPermissions?, skills, limits }`.
`toolCallConcurrency` (1–16) is Mastra's own option; `withheldPermissions` carries an engine
switch's narrowing exactly as on the `openai-agents` and `pi` arms (ADR-0074 D12). Nothing else is
added until a customer need is recorded.

## Consequences

- `ENGINE_IDS` and the database's engine CHECKs gain `mastra` (migration `0031`, additive). The file
  prefix equals the journal `idx`, because `drizzle-kit generate` names the next migration from
  `lastEntry.idx + 1`; the developer-platform programme's `0030` (`cli_sessions`, ADR-0083) merged
  first, so this migration was regenerated on top of it as `0031`.
- `translatePolicyForEngineSwitch` carries narrowing between `claude-agent-sdk` and `mastra` as for
  the other withholding arms, and between `openai-agents`, `pi` and `mastra` verbatim.
- The runtime image matrix derives `runtime-mastra` from the adapter package (ADR-0073);
  `runtime.Dockerfile` needs no change. Mastra's dependency tree (several AI SDK provider
  generations, the MCP SDK, `posthog-node`) passes the licence gate without an exception.
- The SDK-boundary gate confines five packages to `packages/engine-mastra/src/boundary.ts`;
  `@ai-sdk/anthropic` is now confined to one boundary file per adapter that uses it.
- The Lean model's third-party behaviour — requests only to the provider's base URL, no telemetry
  without a `Mastra` instance, writes only through the handed filesystem, `maxSteps` honoured,
  memory only through the handed storage domain — is declared and enforced by the boundary suite
  (`docs/formal/units/engine-mastra.md`).
