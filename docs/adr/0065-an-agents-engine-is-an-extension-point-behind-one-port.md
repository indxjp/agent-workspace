# ADR-0065 — An agent's engine is an extension point behind one port

Status: accepted
Date: 2026-09-26
Decided by: the Owner (agent-engines programme, tracker #299, unit ENG-01 #300)
Scope: `docs/spec.md` §5, §42 and §53; `docs/sdk/04-api-specification.md` §1.1 and §6;
`docs/sdk/README.md`; the docs site's concept and building pages; the planned `packages/engine` and
`packages/engine-<id>`; `apps/runner`'s engine registry; `formal/AgentWorkspace/Concepts/Engine.lean`

## Context

Every agent this platform runs today is executed by the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`), imported from exactly one file, `apps/runner/src/claude.ts`,
and guarded by `tests/no-sdk-import.test.ts`. Three standing decisions made that singular:

1. `docs/spec.md` §5 ("Claude Agent SDK Must Remain the Core") required the Claude Agent SDK as
   "the actual agent runtime" and forbade "a generic `Agent` abstraction that replaces Claude Agent
   SDK semantics". §42 named `runner/src/claude.ts` as the single translation site, and §53 listed
   `AgentLoop`, `ToolExecutor` and their relatives as concepts the control plane must never grow.
2. `docs/sdk/README.md` recorded, under "Decisions taken with the Owner (2026-09-21)", that "no
   provider-independent policy format is invented until a second provider exists". The same
   sentence is restated on `docs/sdk/site/concepts/runtime-neutrality.mdx` and in
   `target-architecture.mdx` under "What never changes".
3. `docs/sdk/04-api-specification.md` §1.1 defined a "runtime provider" as the engine and noted
   "Today exactly one: `claude-agent-sdk`"; §6.4 gave the four steps a second provider would have
   to follow, as groundwork rather than as a plan.

Those decisions were right while there was one engine and no customer asking for another. The
condition they named has now been met from the other side: the Owner decided on 2026-09-26 that
the platform accepts engines other than the Claude Agent SDK, and the tracker #299 schedules pi,
the OpenAI Agents SDK, Mastra and a generic Agent Client Protocol (ACP) adapter behind one port.
Eleven units (ENG-01 … ENG-11) implement it, and every one of them needs a normative text to
implement against. This record is that text. It reverses the two standing decisions above and
states, positively, what the platform owns and what it still refuses to own.

The word `provider` is already taken. On `Run` and on a model connection it means the *model*
provider (`MODEL_PROVIDERS` in `packages/contracts/src/runs.ts`: `anthropic`, `openai`,
`azure-openai`, …). Reusing it for the harness would make `Run.provider` permanently ambiguous, so
the harness gets its own word and its own field.

## Decision

An agent's **engine** is an extension point, behind one port that the platform owns. The nine
decisions below are the whole of it.

### D1 — Vocabulary

Four terms, and each names one thing only. New prose uses these words; older prose is corrected
where it is edited.

| Term               | Meaning                                                                         | Field                    | Values                                                                        |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| **Engine**         | The harness that turns an agent definition and a prompt into model calls, tool calls and a stream of events | `engine`                 | `claude-agent-sdk` today; `pi`, `openai-agents`, `mastra`, `acp` planned      |
| **Model provider** | Who serves the model; a property of a model connection                          | `provider` (unchanged)   | `anthropic`, `anthropic-compatible`, `openai`, `azure-openai`, `openai-compatible` |
| **Runtime driver** | Where the sandbox runs                                                          | `driver` (unchanged)     | `local`, `docker`, `kubernetes`, `aca-sessions`, …                            |
| **Wire protocol**  | The HTTP dialect an engine uses to reach the gateway                            | `wireProtocol`           | `anthropic-messages`, `openai-responses`, `openai-chat-completions`           |

The engine field is `engine`, never `provider`. `AgentPolicy.provider` — today the discriminant of
the policy union, with a single `'claude-agent-sdk'` arm — is renamed to `engine` by ENG-02 (#301),
**before** the first npm publish of `@agent-workspace/contracts` (#246), while renaming is still
free rather than a breaking change.

### D2 — What the platform owns

The platform owns a port and the machinery around it, and nothing more:

1. **The `AgentEngine` port** — a new package `packages/engine`, which depends on
   `@agent-workspace/contracts` and `zod` and on nothing else in the workspace. It never imports
   `core`, `runtime`, `gateway` or an application. Its shape is decided by ENG-04 (#303).
2. **One adapter package per engine** — `packages/engine-<id>`, which imports `packages/engine`,
   `packages/contracts` and its own third-party SDK.
3. **One boundary file per third-party SDK** — `packages/engine-<id>/src/<boundary>.ts` is the only
   file in the repository allowed to import that engine's SDK. This generalises today's single-file
   rule rather than relaxing it: `tests/no-sdk-import.test.ts` becomes an allow-list of one boundary
   file per engine, checked for set equality, so an unlisted importer is still a build failure.
4. **The runner registry** — `apps/runner` maps an engine id to its adapter and imports adapters
   only through that registry. An image that does not ship an adapter refuses its engine with a
   typed error; it does not fall back to another engine.
5. **The conformance kit** — one scripted set of scenarios (text turn, tool call, write under a
   grant, denied write, interrupt mid-tool, resume, MCP call or refusal, skill use or refusal,
   max-turns, gateway-metered usage) that every adapter passes. It arrives with ENG-04.
6. **`docs/engine-matrix.md`** — a generated matrix, the counterpart of
   `docs/runtime-driver-matrix.md`, where `?` means not verified rather than not supported.

`apps/web` is not on this list. The control plane knows engines only through contracts — ids,
capabilities and policy arms — and never imports an adapter.

### D3 — What the platform refuses to own

The platform does not become an agent framework. It does not acquire, now or later:

- an agent loop;
- a tool executor;
- a memory system;
- prompt templates.

An adapter **translates configuration**. It maps the portable core and its own policy arm onto its
engine's native options, and it maps its engine's output onto neutral frames. It never
re-implements a harness feature its engine already has, and it never emulates one its engine lacks.

When an engine lacks a capability the agent's configuration requires, the platform **refuses with a
typed error**, at agent save *and* again at run compose:

| Code                            | Status | Meaning                                                            |
| ------------------------------- | ------ | ------------------------------------------------------------------ |
| `engine_capability_unsupported` | 422    | The engine cannot honour a portable requirement (MCP on pi, say).   |
| `unsupported_engine`            | 422    | The engine id is not one this deployment's contracts know.          |
| `engine_not_installed`          | 422    | The id is known, but this runtime image ships no adapter for it.    |

Refusing is the whole of the behaviour: a requirement is honoured or it is named in a refusal.
Silently dropping one is forbidden. This is the rule
`Theorems/Normative/Engine.lean#compose_refuses_rather_than_dropping_a_requirement` proves, and
§53 of the specification keeps its list of forbidden concepts unchanged because of it.

### D4 — The portable core every engine honours

The portable core is the set of configuration an agent carries that every engine must either
honour exactly or refuse by name:

- `instructions`;
- the four `permissions` booleans (`readFiles`, `writeFiles`, `runCommands`, `unrestrictedNetwork`);
- file grants (per-path read-only access);
- connectors (MCP), or a refusal;
- skills (a `SKILL.md` directory, the Agent Skills format), or a refusal;
- `(modelConnectionId, model)`;
- `limits` (`maxTurns`, `maxBudgetUsd`).

Anything outside that list is an **engine-native policy arm**: the arm of the `AgentPolicy` union
discriminated by `engine`, carrying that engine's own vocabulary (for the Claude Agent SDK, its
`tools` presets and `permissionMode`). The portable core is workspace-owned data; an arm is not.

Skills are portable-with-refusal rather than engine-native, which is a change from
`04 §6.1`: `SKILL.md` is now read by pi (`.agents/skills`), by Mastra (workspace skills) and by
the OpenAI Agents SDK's `SandboxAgent` skills capability, so the format is no longer one engine's.

### D5 — Events are normalised in the runner, by the adapter

Normalisation happens **in the runner, in the adapter**, at the point where the engine's own output
is first read. The runner emits neutral `agent.*` frames, and every frame carries two extra fields:
`engine` (which engine produced it) and `raw` (the engine's own message, untouched, so nothing is
lost).

The SDK's `AgentEvent` therefore stops being a mapper and becomes a **parser**: it decodes a frame
that is already neutral instead of translating one engine's classification into a neutral shape.
Today's Claude-shaped mapping in `packages/sdk/src/events/agent-event.ts` moves into the Claude
adapter. ENG-03 (#302) makes the change and upgrades legacy frame names on read, so durable runs
recorded before it stay readable.

Normalising in the runner rather than in the control plane keeps the control plane free of every
engine's vocabulary; normalising in the adapter rather than in the runner keeps the runner free of
it too.

### D6 — Billing is always gateway-metered

A run's billed usage is a function of the gateway's usage records (`run_usage_records`) and of
nothing else. The gateway sees every model call, because credential substitution means a model
call cannot leave the sandbox any other way.

Usage an engine reports about itself is **informational**. It may be stored and displayed, it may
be compared with the ledger to detect drift, and it never enters an amount the platform bills.
Changing an engine's self-report changes no billed number. This is
`Theorems/Normative/Engine.lean#billed_usage_is_a_function_of_the_gateway_ledger`.

### D7 — An engine speaks the connection's native protocol when it can

An engine that can speak the wire protocol of the model connection it was given does so. pi, Mastra
and the OpenAI Agents SDK all select a protocol per connection, so they talk to the gateway in the
connection's own dialect and the gateway passes the call through.

The gateway **translates only for single-protocol engines** — the case where an engine speaks
exactly one dialect and the connection speaks another, such as the Claude Agent SDK reaching an
OpenAI connection. Translation is approximate, so it is a fallback, never the default path.
ENG-05 (#304) adds the OpenAI Responses and Chat Completions ingress that makes the passthrough
possible, and meters each protocol on its own terms.

### D8 — A session is pinned to one engine

A session is pinned to the engine of its first run. Every later run of that session carries the
same engine. A request that would run a session on a different engine is refused with
`409 session_engine_mismatch`; it is never silently re-pinned, and a session is never migrated
between engines.

The reason is resumption. Session state is engine-native and opaque to the platform — a Claude
`SessionStore` mirror, a pi JSONL tree, an OpenAI session's items — so a second engine cannot read
the first engine's state, and a session whose engine changed would resume into a transcript its
engine does not understand. ENG-02 (#301) adds `sessions.engine`, ENG-06 (#305) the engine-scoped
state store. The invariant is
`Theorems/Invariants/Engine.lean#every_run_of_a_session_carries_the_session_engine`.

### D9 — Non-goals

These are not part of this decision and do not become part of it by implication. Each needs its
own record if it is ever wanted:

- **Interactive approvals (HITL) through the API.** No engine offers them in a shape the platform
  could expose today; Claude runs with static allow/deny lists.
- **Handoffs, subagents and multi-agent graphs as platform concepts.** An engine may have them; the
  platform does not model them.
- **Vendor-hosted tools** that execute at the model vendor (hosted web search, code interpreter,
  hosted MCP). They bypass the sandbox and the gateway, which is exactly what the platform
  guarantees they cannot do.
- **Publishing `packages/engine` as a third-party SPI.** It is shaped so that publishing it later
  is possible, and it is an internal port until someone decides otherwise.
- **Switching an existing session to a different engine** — the direct consequence of D8.

## Consequences

- Specification §5 is renamed and reworded, §42 names the per-engine boundary path, and §53 gains
  one sentence saying an adapter is not an `AgentLoop`. §53's list and its two responsibility lists
  are unchanged: D3 is that list restated for a world with more than one engine.
- `docs/sdk/README.md` no longer carries "no provider-independent policy format is invented until a
  second provider exists". The portable core of D4 *is* that format, and the condition the sentence
  named — a second engine — is being met by units ENG-08 … ENG-11.
- Specification §39 rule 3 says to avoid abstract factories unless there are at least two real
  implementations. This decision does not suspend it: ENG-04 lands the port and extracts the Claude
  Agent SDK as the first adapter, and ENG-09 (the OpenAI Agents SDK) is the second implementation
  immediately behind it, precisely so the port is designed against two engines rather than copied
  from one.
- No TypeScript changes with this record. Every contract, table, package and gate change belongs to
  ENG-02 … ENG-11, so this ADR is the only thing a reviewer of those units has to check them
  against.
- Three of the nine decisions are machine-checked before any of that code exists:
  `formal/AgentWorkspace/Concepts/Engine.lean` models the vocabulary and composition, and the
  theorems named under D3, D6 and D8 prove refuse-never-ignore, billing independence and session
  engine pinning. The remaining six are prose obligations that later units turn into theorems
  against real code (tracker #299, "Formal specification across the programme").

## Related decisions

- [ADR-0052](0052-the-sdk-is-contracts-first-and-the-application-is-its-first-consumer.md) — the
  contracts-first direction the port follows, and the record that first disambiguated "SDK".
- [ADR-0062](0062-the-specification-is-a-lean-4-model-and-typescript-is-tested-against-it.md) — why
  this record's rules are stated in Lean as well as in prose.
- [ADR W1-RN-02](W1-RN-02-runtime-driver-is-generic.md) — the runtime driver interface, the
  extension point this one is modelled on and is orthogonal to.
- `docs/spec.md` §5, §42, §53 — amended by this record.
- Tracker [#299](https://github.com/indxjp/agent-workspace/issues/299) — the eleven units
  that implement it.
