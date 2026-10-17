# L-engine-openai-agents — the OpenAI Agents SDK adapter

## Scope

`Behaviour/Engines/OpenAiAgents.lean` models `packages/engine-openai-agents` (ENG-09, #308): the
adapter that runs an agent whose policy says `engine: 'openai-agents'` on the OpenAI Agents SDK. It
models four decisions the adapter owns, as pure functions: `compile`, the tool plan, the event
mapping, and the SDK `Session` over the engine-scoped store. The path rules are
`Authz/PathGrant.lean`'s and the frames are `Events/AgentFrames.lean`'s; neither is re-modelled.

## Compile

`compile` is `compileOpenAiAgentsRun`, check for check and in the same order: the policy arm, the
file grants (normalised against the adapter's `.openai-agents` directory), skills, fork, a budget
cap on a model the provisional price table cannot price, the gateway connection, its wire protocol, an Anthropic-family connection's model, spec A.11's
environment verdict, then the connectors. A requirement the engine cannot honour is refused with the
port's code and the capability it names — `skills`, `fork`, `maxBudget`, `wireProtocols`, `model`,
`approvals` — never dropped. An accepted cap is carried into the configuration, and is accepted only
on a priced model. A remote (HTTP or SSE) connector compiles without `unrestrictedNetwork`, as on the
Claude engine. An accepted compile speaks the protocol the
gateway connection names, through `OpenAIProvider` for the two OpenAI dialects and `aisdk()` for
Anthropic Messages, and compose resolves an OpenAI-family connection to the Responses dialect and an
Anthropic-family one to Messages.

## Tools

Five function tools: `read_file`, `list_files` and `search_files` from `readFiles`, `apply_patch`
from `writeFiles`, and `shell` from `runCommands`, withheld while a read-only grant exists. An
accepted agent offers exactly those. Every tool is an SDK **function** tool, because the SDK's own
`shell` and `apply_patch` tool types are refused by the gateway's closed hosted-tool allowlist
(ADR-0068 D4) and by the SDK itself on Chat Completions and through `aisdk()`; so no compiled tool is
vendor-hosted. `unrestrictedNetwork` has no tool on this engine; it compiles to `networkEgress` and
does not gate remote connectors.

## Engine switch

An agent switched to this engine from `claude-agent-sdk` keeps every narrowing the Claude arm
carried (ADR-0074 D12). `translatePolicyForEngineSwitch` (`packages/contracts/src/agents.ts`) turns
a Claude `tools.deny` rule, a `base` list and a narrowing `permissionMode` into the switches the new
arm's `withheldPermissions` turns off, and a run composes the agent's permissions with those
switches off. A denial of an MCP tool, an MCP glob or a wildcard cannot be said on this arm and is
refused by name (`422 engine_switch_would_widen`); a denial of a tool this engine does not have
stays absent. The reverse switch writes each withheld switch's Claude tools into `tools.deny`.

## Path grants

The Editor and the read tools resolve every path against the run's workspace and write only where
`writeGrantVerdict` allows: never inside a read-only grant, never in the adapter's own directory,
never outside the workspace. The grants the compiled Editor enforces are the request's own,
normalised.

## Egress

Every model request an accepted configuration can issue is the gateway's base URL plus `/v1` and the
protocol's path, carrying the run token as `Authorization: Bearer`; the configuration names no other
model endpoint. The Anthropic path uses the AI SDK's `authToken` rather than `apiKey`, because the
gateway reads only the bearer header.

## Tracing

Every compiled configuration carries `tracingDisabled: true`. That `setTracingDisabled(true)` runs
before `run`, and that the SDK then exports no trace, is a hypothesis about the third-party SDK,
enforced by the package's boundary suite.

## Events

The mapper turns every SDK stream event into at least one frame of the closed `agent.*` vocabulary:
text and reasoning deltas into `agent.message.delta`, message and reasoning items into
`agent.message`, `tool_called` and `tool_output` into `agent.tool.call` and `agent.tool.result`, the
adapter's terminal event into `agent.usage` and `agent.result`, and everything else into
`agent.native` — or `agent.malformed` when it cannot be read. A tool output whose call was never
announced is `agent.malformed`, so tool pairing holds on every mapped stream.

## Turns

The SDK enforces `maxTurns` natively (a hypothesis): a run whose model would take more responses than
the limit stops at the limit, and the adapter ends it with `agent.result {stopReason: 'max_turns'}`.

The provisional budget cap (ADR-0074 D7, #342) is the adapter's own: after each response the
estimated cost so far is compared with the cap, and the run stops `max_budget` at the first response
that reaches it. A run under its cap is never stopped by it, a stop happens only at the cap, and no
response starts after it is reached, so a run overshoots by at most one response.

## Session

The SDK's `Session` is a list of items. The adapter implements `getItems`, `addItems`, `popItem` and
`clearSession` over the store's list, append, delete-last and replace-all, wrapping every item under
its own entry type; on a stream it wrote, each operation is exactly the list operation. A second run
on the session sees the first run's items.

## Theorems and vectors

- **T1** (`Theorems/Normative/OpenAiAgents.lean`): the tools are exactly the permitted ones; no
  vendor-hosted tool; the SDK `shell` tool type is not relayed; the protocol follows the connection;
  each unsupported requirement, an unpriced budget cap among them, is refused by name; an accepted
  cap is compiled and priced; a remote connector needs no network switch.
- **T2** (`Theorems/Invariants/OpenAiAgents.lean`): no event is dropped; tool pairing holds; the run
  stops at or before `maxTurns` with `max_turns`; the provisional budget stops a run only at its cap,
  never under it, and no response starts after it.
- **T2** (`Theorems/Invariants/EngineSwitch.lean`): an engine switch never widens the tool plan —
  every tool the adapter offers under the carried arm is one the old Claude arm allowed, for every
  permission set; a switch is refused exactly when a denial is untranslatable, naming those; the
  narrowing never opens the network; the reverse switch denies every withheld tool.
- **T3** (`Theorems/Adversarial/OpenAiAgents.lean`): no permitted write lands in a read-only grant;
  every model request goes to the gateway with the run token; tracing is disabled.
- **T4** (`Theorems/Refinement/OpenAiAgents.lean`): the session refines the store.

The `engine-openai-agents` vectors are replayed by `tests/formal/engine-openai-agents.test.ts`
against the real `compileOpenAiAgentsRun`, `openAiAgentsToolPlan`, `openAiAgentsModelConnection`,
`workspaceWriteAllowed`, `createOpenAiAgentsFrameMapper`, `EngineStoreSession` and — for
`engine-switch.json` — `translatePolicyForEngineSwitch` with `policyNarrowedPermissions`.

## Declared gaps

- The SDK issues model requests only through the client the compiled connection builds.
- `setTracingDisabled(true)` precedes `run`, and no trace is exported.
- The SDK enforces `maxTurns` natively.

Each is third-party behaviour Lean cannot prove; each is enforced by the adapter's boundary suite and
the engine conformance kit rather than by a theorem.
