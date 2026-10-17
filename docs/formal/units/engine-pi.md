# L-engine-pi — the pi coding agent adapter

## Scope

`Behaviour/Engines/Pi.lean` models `packages/engine-pi` (ENG-08, #307): the adapter that runs an
agent whose policy says `engine: 'pi'` on the pi coding agent (`@earendil-works/pi-coding-agent`),
in process. It models the decisions the adapter owns, as pure functions: `compile`, the tool plan,
the `beforeToolCall` guard, the pinned resource loader, the event mapping, the turn stop and pi's
JSONL session over the engine-scoped store. The path rules are `Authz/PathGrant.lean`'s, the frames
are `Events/AgentFrames.lean`'s, and the permission switches, refusal codes, provisional price list
and frame vocabulary are `Behaviour/Engines/OpenAiAgents.lean`'s; none is re-modelled.

## Compile

`compile` is `compilePiRun`, check for check and in the same order: the policy arm, the file grants
(normalised against the adapter's `.pi` directory), connectors, a budget cap on a model the
provisional price table cannot price (a run naming no model is priced as pi's own default), the
gateway connection, its wire protocol, spec A.11's environment verdict, and a fork naming the
session it would create. A requirement the engine cannot honour is refused with the port's code and
the capability it names — `mcp`, `maxBudget`, `wireProtocols` — never dropped, never emulated. No
accepted agent carries a connector.

## Tools

Four of pi's built-in tools: `read` from `readFiles`, `write` and `edit` from `writeFiles`, and
`bash` from `runCommands`, withheld while a read-only grant exists. An accepted agent offers exactly
those, as pi's own `tools` allowlist. The `beforeToolCall` guard blocks every call to a tool the
plan does not offer, so `bash` is blocked whenever `runCommands` is off, even when the model invents
the call.

## Path grants

Before any grant is consulted, the guard resolves the path the model named (`resolveWorkspacePath`):
a spelling pi rewrites — a leading `~` or `@`, or a Unicode space — is refused outright; an
absolute path under the sandbox root has the root stripped, so `/workspace/docs/a.md` is
`docs/a.md`; `.`, `./` and the root itself are the workspace root; and an absolute path outside the
root is left as it is, so normalising it refuses it. `read` then needs the root or a path that
normalises inside the workspace. A `write` or `edit` of the root is refused with its own reason,
and any other one goes through only when `writeGrantVerdict` allows the resolved path: inside the
workspace, outside the adapter's `.pi` directory and outside every read-only grant, however the path
is spelled. The TypeScript guard then repeats the check on the path with its symbolic links
resolved (`guard.ts`); that half needs a filesystem and is the boundary suite's.

## Egress

The compiled connection is the gateway's base URL, without trailing slashes, and the run token as
the model's `authorization` header. pi-ai's Anthropic client appends `/v1/messages`, so every model
request the configuration can issue goes to the gateway with `Authorization: Bearer <run token>`,
and there is exactly one such endpoint. The key pi insists on is a public placeholder.

## Loader

The pinned resource loader returns the skills the platform placed under `.pi/skills/<name>/` and
the run grants, and the agent's instructions as an appended system prompt — and nothing else. What
the platform materialised is built from the compiled configuration alone (one skill per granted
name, and the instructions), and everything the loader returns is in it. Of everything present on a
host, it never admits anything under `~/.pi`, under `~/.agents` or from project discovery
(`.agents/skills`, `.pi/extensions`, `AGENTS.md`, `CLAUDE.md`). The skills a compile grants are the
request's names without repeats, sorted.

## Events

pi's session events map onto the neutral frames: `text_delta` and `thinking_delta` updates to
`agent.message.delta`, an assistant `message_end` to `agent.message`, `tool_execution_start` and
`tool_execution_end` to `agent.tool.call` and `agent.tool.result` (`failed` for a blocked or failing
call), and the adapter's terminal event to `agent.usage` then `agent.result`. Everything else,
`agent_end` included, is `agent.native`; an event the mapper cannot read is `agent.malformed`. No
event is dropped, and tool pairing holds. The mapper holds announced call ids as a set, so a call
started twice is answered once and its second result is `agent.malformed`.

## Turns

The adapter counts `turn_end`. After the tools of the last allowed turn it sets pi-agent-core's
`terminate` hint, so no request for a turn past `limits.maxTurns` is sent; a `max_turns` stop is
exactly at the limit; and a run whose model keeps running tools up to the limit is cut short there
and ends `agent.result {stopReason: 'max_turns'}`. A per-run budget cap is priced from the port's
provisional table and stops the run `max_budget`; the arithmetic is the one
`Behaviour/Engines/OpenAiAgents.lean` proves.

## Session

pi keeps a session as a JSONL tree: a header line whose `id` is the session id, then entries each
with an `id` and the `parentId` of the entry it follows. The adapter stores one stream per session,
one entry per line, and appends only the lines the stream does not hold yet. Mirroring a readable
session file into an empty stream a prefix at a time, as the adapter does at each `turn_end`,
rebuilds exactly the file — a readable tree never repeats an id, so no line of the grown file is
mistaken for one already held — and importing it back gives the same tree; a stream that does not start with the
session's header, repeats an id or names a parent that is not an earlier line is refused.

## Theorems and vectors

- **T1** (`Theorems/Normative/Pi.lean`): the tools are exactly the permitted ones; the guard blocks
  `bash` whenever `runCommands` is off; no accepted agent has a connector, and a connector is refused
  by name; an unpriced cap and an unspoken protocol are refused by name.
- **T2** (`Theorems/Invariants/Pi.lean`): no event is dropped; tool pairing holds; the run stops at
  or before `maxTurns`, a `max_turns` stop is at the limit, and a run the limit cuts short ends
  `max_turns`; the session tree round-trips through repeated `persist`.
- **T3** (`Theorems/Adversarial/Pi.lean`): no permitted write lands in a read-only grant, over the
  resolved path (relative or absolute under the root); every model request goes to the gateway with
  the run token; the pinned loader admits only what the platform materialised.

The `engine-pi` vectors are replayed by `tests/formal/engine-pi.test.ts` against the real
`compilePiRun`, `piToolPlan`, `piModelConnection`, `piToolCallVerdict`, `createPiFrameMapper`,
`PiSessionMirror` and `readPiStream`.

## Declared gaps

- pi issues model requests only to the model's base URL plus `/v1/messages`, with the model's
  headers.
- pi reads resources only through the `ResourceLoader` it is handed.
- pi calls `beforeToolCall` before every tool execution and honours `{ block: true }`.
- pi-agent-core ends a run after a tool batch whose results all carry `terminate`.
- The symbolic-link half of the guard (`guard.ts`) needs a filesystem.

Each is third-party or filesystem behaviour Lean cannot prove; each is enforced by
`packages/engine-pi/src/boundary.test.ts` (real pi against a fake gateway and a hostile home),
`workspace.test.ts` and the engine conformance kit rather than by a theorem.
