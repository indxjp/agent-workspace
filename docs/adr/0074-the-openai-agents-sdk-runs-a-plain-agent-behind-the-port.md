# ADR-0074 — The OpenAI Agents SDK runs a plain `Agent` behind the port

Status: accepted
Date: 2026-09-29
Decided by: the implementer of ENG-09 (agent-engines programme, tracker #299, unit ENG-09, issue
#308), finished locally on the Owner's decision after the hosted runner was lost twice; the Owner
decided the four open deviations on 2026-09-29 (issue #308): function tools stay (D2), remote
connectors need no `unrestrictedNetwork` (D2), a provisional adapter budget cap (D7), and two
follow-ups (D5, Consequences); and on PR #339's review that an engine switch carries the
narrowing across rather than refusing or resetting it (D12)
Scope: `packages/engine-openai-agents`; `packages/contracts/src/{engines,agents}.ts`;
`packages/core/src/db/schema/agents.ts`; `migrations/0028_*`; `apps/web/server/engines/registry.ts`,
`apps/web/server/compose/run-request.ts`, `apps/web/server/agents/{policy,store}.ts`;
`apps/runner/src/engines.ts`, `apps/runner/package.json`, `apps/runner/types/engine-modules.d.ts`;
`runtime.Dockerfile`; `tests/no-sdk-import.test.ts`; `dependency-cruiser.config.mjs`;
`packages/engine/src/testing/conformance.ts`;
`formal/AgentWorkspace/Behaviour/Engines/{OpenAiAgents,EngineSwitch}.lean`;
`packages/aw/src/commands/agents.ts`, `apps/web/app/api/agents/[id]/policy/route.ts`

## Context

ADR-0065 made the engine an extension point and scheduled the OpenAI Agents SDK (`@openai/agents`)
as the second engine, so the port would be designed against two engines rather than copied from one.
ADR-0070 landed the port, ADR-0072 moved the Claude tool mapping into its adapter, ADR-0071 gave every
engine one session store and ADR-0073 one runtime image per engine. This unit adds the second adapter
and records the decisions the SDK forced.

## Decision

<a id="plain-agent"></a>

### D1 — A plain `Agent`, not `SandboxAgent`

The adapter compiles a plain `Agent` and runs it with a `Runner`. `SandboxAgent` and its sandbox
clients are not used: the platform's runtime driver already **is** the sandbox, and nesting OpenAI's
sandbox clients (Docker, E2B, Modal, …) inside it would duplicate the isolation and add egress the
gateway never sees. `UnixLocalSandboxClient` would run in-container, but it would bring the SDK's own
workspace model and skills loader with it, and neither is a platform concept this unit may adopt
without a decision of its own. No handoff, guardrail or `needsApproval` is ever compiled
(ADR-0065 D9).

<a id="function-tools"></a>

### D2 — Every tool is a function tool, backed by our executors

The issue asked for `shellTool` and `applyPatchTool`. Both are Responses-API tool **types**
(`{"type":"shell"}`, `{"type":"apply_patch"}`), and neither survives this platform's path to a model:

- the gateway relays a tool entry only when its `type` is `function` or `custom`
  ([ADR-0068 D4](0068-openai-wire-protocols-are-passthrough-ingress.md)), so both are refused
  `400 hosted_tool_not_permitted` before anything is sent upstream;
- the SDK refuses both on the other two protocols: `OpenAIChatCompletionsModel` throws *"Hosted
  tools are not supported with the ChatCompletions API"*, and the AI SDK adapter throws
  *"Unsupported tool type"*.

So the adapter supplies the executors the issue describes — our Shell and our Editor, run inside the
container under `cwd` — behind SDK **function** tools, which every protocol relays: `read_file`,
`list_files` and `search_files` (`readFiles`), `apply_patch` (`writeFiles`, applied with the SDK's own
`applyDiff`) and `shell` (`runCommands`). Nothing is emulated: the SDK has no executor of its own for
a local shell or a patch. `shell` is withheld while a read-only grant exists, for the reason the
Claude adapter withholds `Bash`: a redirect writes what the grant protects.

The Owner kept this design (2026-09-29): the gateway's hosted-tool allowlist (ADR-0068 D4) stays
closed, and the Responses `shell` / `apply_patch` types are not relayed.

`unrestrictedNetwork` has no tool on this engine — the SDK's web search is vendor-hosted and refused —
so it compiles to `networkEgress`, the statement that the run may reach the open network. **Remote
(`http`/`sse`) MCP connectors do not depend on it**: they compile without the switch, for parity
with the Claude engine, which offers a remote connector on the same terms (Owner decision,
2026-09-29). An earlier draft of this record refused such a connector `engine_policy_invalid`
without the switch; that gate is removed, and the Lean theorem
`a_remote_connector_needs_no_network_switch` states the parity.

<a id="skills"></a>

### D3 — Skills are refused

`skills: false`. A plain `Agent` has no skills, and building a loader on top of it would re-implement
a harness feature, which ADR-0065 D3 forbids. A granted skill is refused
`engine_capability_unsupported` at compile, and nothing is placed. The conformance kit's skills
scenario gained the arm that holds a `skills: false` engine to exactly that — a refusal by name, no
placement, and a skill-free request that still compiles.

<a id="tracing"></a>

### D4 — Tracing is off, always

The SDK exports traces to OpenAI's dashboard by default, which is egress the gateway never sees.
`setTracingDisabled(true)` runs when the boundary module loads and again before every run, every
`Runner` is built with `tracingDisabled: true`, and the compiled configuration carries
`tracingDisabled: true` so a replay can assert it. The boundary test checks, from the boundary's
source, that the call precedes the `Runner` and its `run` (the test may not name the SDK itself:
`tests/no-sdk-import.test.ts` permits only the boundary file), and records every request the process
makes to show that none but the fake gateway is reached. The network-policy half of the issue's
no-trace criterion — the sandbox's egress rules refusing the tracing host — is a live proof, waived
into #345. Mapping the SDK's spans to the platform's
OpenTelemetry is a follow-up.

<a id="protocol"></a>

### D5 — The protocol follows the connection

The adapter speaks `openai-responses`, `openai-chat-completions` and `anthropic-messages`, in that
order, so compose's `resolveWireProtocol` picks Responses for an `openai`, `azure-openai` or
`openai-compatible` connection and Anthropic Messages for an `anthropic` or `anthropic-compatible`
one (ADR-0065 D7).

- OpenAI-family: `OpenAIProvider({ baseURL: <gateway>/v1, apiKey: <run token>, useResponses })`,
  built per run — never `setDefaultOpenAIClient`, which is process-global.
- Anthropic-family: `aisdk(createAnthropic({ baseURL: <gateway>/v1, authToken: <run token> }))`.
  `authToken` rather than `apiKey`, because the AI SDK sends `apiKey` as `x-api-key` and the gateway
  reads only `Authorization: Bearer <run token>`. The AI SDK has no default model, so an
  Anthropic-family run with no model named is refused.

Chat Completions is reached only when compose hands the adapter that protocol. No connection field
selects it today (`ModelConnectionConfig` is `{ baseUrl?, apiVersion?, deployment? }`, strict), so an
`openai-compatible` upstream that implements only Chat Completions needs a connection-level switch.
That field, its migration and its UI are follow-up #340.

<a id="egress"></a>

### D6 — Every model request goes to the gateway, with the run token

The compiled configuration names exactly one model endpoint, `<gateway base URL>/v1`, and one bearer,
the run token. There is no other endpoint in it: the SDK's default model provider, the default
OpenAI client and the tracing exporter are never configured.

<a id="budget"></a>

### D7 — A provisional budget cap, enforced by the adapter

**Provisional.** `maxBudget: 'adapter'`, on the Owner's decision of 2026-09-29 ("a provisional one is
fine, but build it"). #342 moves budget enforcement into the gateway for every engine, priced from
the real catalogue and `run_usage_records`, and retires this one.

- **What is measured.** After every model response the boundary adds the usage the gateway relayed
  back in that response (input, cached input, output tokens) and prices it.
- **What it is priced with.** A small table next to the adapter,
  `packages/engine-openai-agents/src/budget.ts`, with the gateway's arithmetic (decimal rates per
  million tokens, integer micro-dollars, half-up rounding). The gateway's own table cannot be used:
  it is `GATEWAY_PRICING_JSON`, a deployment-owned catalogue that exists only in the gateway process,
  and an engine adapter may not import `packages/gateway` (`docs/architecture.md`, dependency
  rules). The estimate stops a run; it never charges one — settlement stays the gateway's
  (ADR-0065 D6).
- **What a stop looks like.** Once the estimate reaches the cap the run is aborted through its own
  signal, so no further model request or tool call starts, and it ends
  `agent.result { stopReason: 'max_budget' }` — the port's budget stop reason, the one the Claude
  adapter reports for its native cap — not a `422`. A run can overshoot its cap by at most the
  response that reached it (`no_response_starts_after_the_budget_is_spent`).
- **What is refused.** A cap on a model the table does not price, or on the SDK's unnamed default
  model, is refused `engine_capability_unsupported` naming `maxBudget` at compile time: a cap that
  could never stop anything is not accepted (`an_unpriced_budget_cap_is_refused_by_name`).

<a id="max-turns"></a>

### D8 — `maxTurns` is the SDK's own

`limits.maxTurns` is the SDK's native `maxTurns`. A run that reaches it ends with
`agent.result { stopReason: 'max_turns' }`; an interrupted run with `stopReason: 'cancelled'`.

<a id="events"></a>

### D9 — Events are mapped in the adapter, and nothing is dropped

Text and reasoning deltas become `agent.message.delta`; `message_output_created` and
`reasoning_item_created` become `agent.message`; `tool_called` and `tool_output` become
`agent.tool.call` / `agent.tool.result` (kind `read`, `search`, `edit`, `execute`, or `mcp` for a
connector's tool); the terminal usage and outcome become `agent.usage` and `agent.result`; everything
else is `agent.native`. A tool output whose call was never announced is `agent.malformed`. Usage in
`agent.usage` is the engine's own, informational report.

<a id="session"></a>

### D10 — Session items live in the engine-scoped store

The SDK's `Session` is implemented over `EngineSessionStore`: `getItems` lists, `addItems` appends,
`popItem` deletes the last entry and `clearSession` replaces all with nothing (ADR-0071 "The
operations"). Every item is stored wrapped as `{ type: 'openai-agents.item', item }`, because a store
entry needs a string `type` and an SDK user message has none. The engine session id is the platform
session id, which the first `agent.session` frame reports.

<a id="images"></a>

### D11 — Adapters leave the runner's production dependencies

ADR-0073 left one open item: `apps/runner/package.json` named the Claude adapter, so a second
engine's image would fail `pnpm install`. The runner's manifest now names no adapter. In the
workspace the registry's literal `import()`s resolve through the root manifest's development
dependencies; in an image, `runtime.Dockerfile` installs and builds the selected adapter through its
own `--filter` and links it into the runner's `node_modules`. The runner's emit build type-checks the
registry's imports against `apps/runner/types/engine-modules.d.ts` (each module's one export, typed
`unknown` and checked at run time), so an image that does not copy an adapter still compiles and
answers `engine_not_installed` for it. CI's per-engine loop builds, labels and licence-checks the new
`agent-workspace/runtime-openai-agents` image because the engine list is derived from the tree.

The three third-party packages the adapter imports — `@openai/agents`, `@openai/agents-extensions`
and `@ai-sdk/anthropic` — are confined to one boundary file, `packages/engine-openai-agents/src/boundary.ts`.
A second allow-listed file for the Anthropic path would be a second place for an SDK type to leak
from, and the path is four lines.

### D12 — An engine switch carries the narrowing across, and refuses only what it cannot carry

A stored policy is strictly narrowing: the Claude arm can take tools away past the permission
checkboxes with `tools.deny`, a `base` list or a `permissionMode`. The first cut of this unit's
`aw agents update --engine openai-agents` wrote the new arm from `skills` and `limits` alone, so an
agent whose owner denied `Bash` but left `runCommands` on got `shell` after the switch (the review
major on PR #339). The Owner asked for something better than either refusing every switch or
resetting the narrowing, and this is the answer.

**The platform translates, not the client.** `translatePolicyForEngineSwitch`
(`packages/contracts/src/agents.ts`) is a pure function per engine pair. `PUT
/api/agents/:id/policy` runs it (`carryEngineSwitch`, `apps/web/server/agents/policy.ts`) whenever
the body's `engine` differs from the stored arm's, so every client gets it, and the CLI calls the
same function to print the translation before it applies it. It lives in the contracts beside
`CLAUDE_PERMISSION_TOOL_DENIALS` for ADR-0072's reason: `apps/web` may never import an adapter. The
OpenAI adapter's tool names and the switch each needs (`OPENAI_AGENTS_TOOL_NAMES`,
`OPENAI_AGENTS_TOOL_PERMISSION`) moved there too, and the adapter reads them, so no tool name is
written twice.

**The `openai-agents` arm gains `withheldPermissions`.** That arm has no tool grammar; its tools
compile from the four switches. So the carried narrowing is a list of switches the policy turns off,
and compose (`portableAgentConfigFor`) composes the agent's permissions — or a run's narrower
override — with those switches off (`policyNarrowedPermissions`). It only ever narrows, and the
adapter needs no change.

**The mapping** (Claude → OpenAI Agents):

| The Claude arm said                                                   | The new arm withholds            |
| --------------------------------------------------------------------- | -------------------------------- |
| `deny` of `Read`, `Glob` or `Grep`                                     | `readFiles` (`read_file`, `list_files`, `search_files`) |
| `deny` of `Write`, `Edit` or `NotebookEdit`                            | `writeFiles` (`apply_patch`)     |
| `deny` of `Bash`, `BashOutput` or `KillShell`                          | `runCommands` (`shell`)          |
| a scoped `deny` of any of those (`Bash(git push:*)`)                   | the same whole switch            |
| a `base` list that does not name every tool of a switch               | that switch                      |
| `permissionMode: 'plan'`                                               | `writeFiles` and `runCommands`   |
| `permissionMode: 'dontAsk'`, a switch whose tools `autoApprove` does not all name | that switch          |
| `permissionMode: 'default'`, `'acceptEdits'` or `'auto'`               | nothing                          |
| `deny` of a tool this engine does not have (`WebFetch`, `WebSearch`, `Task`, …) | nothing: it stays absent |
| `deny` of an MCP tool, an MCP glob or a wildcard                       | **refused**                      |

The mode mapping is the SDK's own semantics, which the Claude adapter forwards verbatim (ADR-0072,
R-01 §3/§10): `plan` plans and does not act; `dontAsk` denies whatever is not pre-approved; the other
modes govern prompting, not which tools exist. `bypassPermissions` cannot be stored through the
route. A scoped denial becomes the whole switch because this engine has no specifier grammar and the
narrower reading is the safe one. `WebFetch`/`WebSearch` have no counterpart: this engine offers no
web tool, and its `networkEgress` is the `unrestrictedNetwork` switch, which a Claude `deny` never
governed either.

The reverse switch (OpenAI Agents → Claude) writes each withheld switch's
`CLAUDE_PERMISSION_TOOL_DENIALS` into the body's `tools.deny`, which is exact and never refuses.

**Refuse only what would widen.** A denial the new arm cannot express — today, one naming an MCP
tool, since this engine cannot remove one connector tool — is `422 engine_switch_would_widen`, its
`details` naming each rule verbatim, and nothing is stored. Everything else is applied, including a
translation narrower than the original. A `PUT` on the **same** engine is a replacement and is not
translated: that is how an owner widens on purpose. An agent with no stored policy has nothing to
carry, because the compiled policy narrows nothing beyond the checkboxes every engine compiles from.

**The contract, in Lean.** `formal/AgentWorkspace/Theorems/Invariants/EngineSwitch.lean` (T2)
proves that under the translated arm the adapter's tool plan offers only tools whose capability the
old Claude arm allowed, for every permission set; that a switch is refused exactly when a denial is
untranslatable, naming those; that the narrowing never opens the network; and that the reverse
switch denies every withheld tool. The `engine-switch.json` vectors replay the real
`translatePolicyForEngineSwitch`, `policyNarrowedPermissions` and `openAiAgentsToolPlan`.

**The CLI shows it.** `aw agents update --engine <id>` prints, on stderr, each carried item (`from ->
withholds <tools>`), each denial that stays absent, and each that would be refused; it refuses
locally with `engine_switch_would_widen` and writes nothing when anything is refused, and surfaces
the route's refusal when the stored policy changed in between. Moving **to** `claude-agent-sdk` from
the CLI still needs a written tool policy (`aw agents policy set`); the route carries the withheld
switches into whatever policy is written.

## Consequences

- `ENGINE_IDS` is `['claude-agent-sdk', 'openai-agents']`. Migration `0028` widens every engine
  CHECK (`runs`, `sessions`, `session_state_{streams,entries,blobs}`). The change is **additive**: a
  revision from the previous release writes only `claude-agent-sdk`, which both constraints admit, so
  no single-revision cutover is needed. A rollback over a database that already holds an
  `openai-agents` row is not supported by the previous release's parsers; roll back before any such
  run, or restore the backup.
- A deployment offers the engine by configuring `AGENT_WORKSPACE_RUNTIME_IMAGE_OPENAI_AGENTS`
  (`docs/deploy/engine-images.md`); until then `GET /api/engines` reports it `installed: false` and a
  run answers `422 engine_not_installed`.
- The conformance kit accepts a `skills: false` engine that refuses by name, and the runner compiles
  before it writes anything into the sandbox.
- `dependency-cruiser` resolves a third-party subpath through its `exports` map, as Node does.
- The `openai-agents` policy arm has a third optional field, `withheldPermissions`, and
  `AGENT_POLICY_PROBLEM_CODES` a new `422 engine_switch_would_widen` (D12). An MCP denial blocks a
  switch to this engine until the owner removes it, which is deliberate: the engine cannot honour it.
- The agent editor has no engine picker yet; that is follow-up #341. The issue's live-run criteria
  (real model connections, recorded upstream fixtures, `run_usage_records.wire_protocol` asserted
  end to end, and the network-policy half of "no trace egress") are waived into #345 under the
  programme's live-proofs rule; this unit proves the adapter's half against a fake gateway.

## Alternatives considered

- **`SandboxAgent` with `UnixLocalSandboxClient`.** Rejected for D1's reasons; it is the natural
  place to revisit skills if the Owner wants the SDK's own skills loader.
- **Widen the gateway's tool allowlist to `shell` and `apply_patch`.** Rejected in this unit: it is
  a change to ADR-0068 D4's security rule, it would still not work on Chat Completions or the AI SDK
  path, and D2's function tools are equivalent in what they execute.
- **Refuse every cap (`maxBudget: 'none'`).** The first draft of this record. Rejected by the Owner:
  an agent with a budget could not run on this engine at all.
- **Refuse every engine switch whose Claude arm narrows past the checkboxes**, or **reset the
  narrowing to the permission floor on a switch** — the two options PR #339's review offered.
  Rejected by the Owner for D12: the first blocks the common case that can be carried exactly, the
  second silently widens.
- **An adapter budget from token counts and a copied price table.** Adopted **provisionally** (D7):
  the table is an estimate that stops a run, never a billing truth, so ADR-0065 D6's single billing
  source is kept; #342 removes the second table.

## Related decisions

- [ADR-0065](0065-an-agents-engine-is-an-extension-point-behind-one-port.md) — the port and its
  non-goals.
- [ADR-0068](0068-openai-wire-protocols-are-passthrough-ingress.md) — the ingress this engine speaks.
- [ADR-0070](0070-the-engine-port-and-its-first-adapter.md),
  [ADR-0071](0071-one-engine-scoped-session-state-store.md),
  [ADR-0072](0072-the-claude-tool-mapping-and-skills-live-in-the-claude-adapter.md),
  [ADR-0073](0073-one-runtime-image-per-engine.md) — the pieces this unit builds on.
