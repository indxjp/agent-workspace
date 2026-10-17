# ADR-0081 — pi runs in process, with a pinned loader, behind the port

Status: accepted
Date: 2026-09-29
Decided by: the implementer of ENG-08 (agent-engines programme, tracker #299, unit ENG-08, issue
#307), within the issue's development policy and the orchestrator's instructions of 2026-09-29
Scope: `packages/engine-pi`; `packages/engine/src/{prices,index}.ts`,
`packages/engine/src/testing/{conformance,scripted-engine}.ts`;
`packages/engine-openai-agents/src/budget.ts`; `packages/contracts/src/{engines,agents}.ts`;
`packages/core/src/db/schema/agents.ts`; `migrations/0029_*`;
`apps/web/server/engines/registry.ts`, `apps/web/server/compose/run-request.ts`,
`apps/web/server/agents/store.ts`, `apps/web/components/agents/agent-detail.tsx`;
`apps/runner/src/{engines,session-state}.ts`, `apps/runner/types/engine-modules.d.ts`;
`tests/no-sdk-import.test.ts`; `packages/aw/src/commands/agents.ts`;
`formal/AgentWorkspace/Behaviour/Engines/Pi.lean`

## Context

ADR-0065 scheduled the pi coding agent as the third engine, after the OpenAI Agents SDK
(ADR-0074). pi (`@earendil-works/pi-coding-agent`, MIT, formerly `@mariozechner/*`) is a TypeScript
coding agent with an in-process SDK (`createAgentSession`), four built-in tools (`read`, `write`,
`edit`, `bash`), Agent Skills, JSONL sessions and no MCP client. It has **no permission system**
and, by default, discovers settings, extensions, skills and context files from `~/.pi`, `~/.agents`
and the project. This ADR records how the adapter configures it.

## Decision

<a id="d1--configure-pi-never-patch-it"></a>

### D1 — Configure pi; never patch it

The adapter runs pi in process through `createAgentSession`, and every decision is an option of it:
a `ModelRuntime`, a `ResourceLoader`, a `SettingsManager`, a `SessionManager`, the `tools`
allowlist and `customTools`. The two hooks the adapter installs — the tool guard in
`beforeToolCall` and the `terminate` hint in `afterToolCall` — are pi-agent-core's documented `Agent`
hooks, wrapped rather than replaced (pi's own hook still runs after the guard). The `--mode rpc`
subprocess is not used. pi is pinned exactly (`0.87.1`); a bump is its own change with the
conformance kit re-run. `boundary.ts` is the one file importing pi.

<a id="d2--the-run-token-is-the-models-authorization-header"></a>

### D2 — The run token is the model's `Authorization` header; the key is a placeholder

The gateway authenticates only `Authorization: Bearer <run token>` (`packages/gateway/src/auth.ts`).
pi-ai's Anthropic client sends its API key as `x-api-key`, but a pi model is data and its `headers`
are sent verbatim, so the adapter sets `headers.authorization` on the model it compiles and gives
pi's `anthropic` provider — re-pointed at the gateway's base URL — a fixed public placeholder as its
runtime key (pi refuses a provider with no key at all). The runtime key outranks any
`ANTHROPIC_API_KEY` in the runner's own environment, so a stray host credential is never sent.
`boundary.test.ts` proves against a fake gateway that every request carries the run token as a
bearer and the placeholder as `x-api-key`, and that a decoy `ANTHROPIC_BASE_URL` receives nothing.
The gateway is **not** changed to accept `x-api-key`. pi's credential store is an empty in-memory
one; `~/.pi/agent/auth.json` is never read.

<a id="d3--a-pinned-resource-loader"></a>

### D3 — A pinned resource loader: the platform's skills and instructions, nothing else

The adapter hands pi its own `ResourceLoader`, whose every member answers from the compiled run:
the skills the runner placed under `.pi/skills/<name>/` (the adapter's `placeSkills`, filtered to
the run's allowlist), and the agent's instructions as an **appended** system prompt (pi's own
prompt is kept). It returns no extension, prompt template, theme or context file, and never looks
at `~/.pi`, `~/.agents` or project discovery. Settings are an in-memory `SettingsManager` with
install telemetry off; `agentDir` points inside `.pi`. `.pi` is the adapter's protected directory,
so no tenant file can be granted into it. This is pi's equivalent of Claude's
`settingSources: ['project']` + `strictMcpConfig: true`. The boundary suite plants a hostile
extension, skills and context files under a hostile `HOME` and in the project and asserts none is
loaded or run.

<a id="d4--the-platforms-permissions-are-enforced-in-the-adapter"></a>

### D4 — The platform's permissions are enforced in the adapter

`readFiles`, `writeFiles` and `runCommands` select `read`, `write` + `edit` and `bash` in pi's own
`tools` allowlist; `bash` is withheld while a read-only grant exists, as on the other engines.
`beforeToolCall` blocks any call to a tool the plan does not offer (so `bash` is blocked whenever
`runCommands` is off, even if the model invents the call), a read outside the workspace, and a
`write` or `edit` into a read-only grant or `.pi` — first on the path as named (`..`, absolute
paths, and the spellings pi rewrites — a leading `~` or `@`, Unicode spaces — are refused), then on
the path with its symbolic links resolved. `bash` runs pi's own bash tool with a `spawnHook` that
gives it the request's environment rather than the runner's `process.env`. There is no
command-level allowlisting.

<a id="d5--mcp-is-refused"></a>

### D5 — MCP is refused, not emulated

pi has no MCP client. The descriptor says `mcp: false`; the control plane refuses an agent with a
connector at save (`422 engine_capability_unsupported`, `capability: 'mcp'`), and `compile` refuses
one by name. The conformance kit gains `connectors-are-honoured-or-refused-by-name`, which an
`mcp: false` engine passes only with that typed refusal. A pi MCP bridge extension is a separate
follow-up, only if asked for.

<a id="d6--limits-and-the-shared-price-table"></a>

### D6 — Limits, and one provisional price table

`limits.maxTurns` is counted on `turn_end`; after the tools of the last allowed turn the adapter
sets pi-agent-core's `terminate` hint, so no request for a turn past the limit is sent, and the run
ends `max_turns`. `limits.maxBudgetUsd` is enforced as ADR-0074 D7 does for the OpenAI Agents
engine, provisionally until #342: the compiled model is priced from the provisional table and the
run stops `max_budget` when pi's per-message `usage.cost` reaches the cap; a cap on a model the table
cannot price is refused. The table moved from the OpenAI adapter into the port
(`packages/engine/src/prices.ts`) so both adapters read one copy; the OpenAI adapter's exported
names are unchanged. Billing stays the gateway's `run_usage_records`; `agent.result.engineCostUsd`
is `null`.

<a id="d7--sessions"></a>

### D7 — pi's JSONL tree is one store stream per session

pi's session id is the platform session id (a resume uses the id the earlier `agent.session`
reported). The adapter keeps pi's `SessionManager` in memory and mirrors its file into the
engine-scoped store after every `turn_end` and at the end: one stream per session, one entry per
JSONL line, appending only lines the stream does not hold; the runner keys each entry by its pi `id`.
A resume loads the stream, refuses one that is not this session's tree, and imports it through
pi's own JSONL parser. A fork copies the parent's stream under a new header naming the parent, as
pi's `forkFrom` does to a file, so `fork: true`. A resume or fork without a store is an error, never
a silent fresh conversation.

<a id="d8--anthropic-messages-only"></a>

### D8 — Anthropic Messages only, and pi's own default model

The adapter speaks `anthropic-messages` to the gateway; an OpenAI-family connection is refused by
the control plane's protocol resolution and by `compile`. A run naming no model compiles pi's own
Anthropic default (`claude-opus-4-8` in 0.87.1, restated and held equal by the boundary suite),
which the `agent.session` frame reports.

## Consequences

- `ENGINE_IDS` and the database's engine CHECKs gain `pi` (migration 0029, additive).
- `translatePolicyForEngineSwitch` carries narrowing between `claude-agent-sdk` and `pi` exactly as
  for `openai-agents`, and between `openai-agents` and `pi` verbatim (`withheldPermissions`).
- The runtime image matrix derives `runtime-pi` from the adapter package (ADR-0073);
  `runtime.Dockerfile` needs no change.
- The Lean model's third-party behaviour — requests only to the model's base URL, resources only
  through the loader, `beforeToolCall` before every tool, `terminate` honoured — is declared and
  enforced by the boundary suite (`docs/formal/units/engine-pi.md`).

## Update 2026-10-05

pi-coding-agent moved 0.87.1 to 1.0.2, clearing the HIGH advisory reported in #668 (1.0.2 ships without
the shrinkwrap that pinned the vulnerable brace-expansion). `@anthropic-ai/sdk` is pinned to 0.129.0 in
`packages/embedded` to match pi-ai, and the pi version in `Engines.lean` and the generated engine
vectors were updated.
