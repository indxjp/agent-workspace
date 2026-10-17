# L-engine-mastra — the Mastra adapter

## Scope

`Behaviour/Engines/Mastra.lean` models `packages/engine-mastra` (ENG-10, #309): the adapter that
runs an agent whose policy says `engine: 'mastra'` as a plain Mastra `Agent` (`@mastra/core`) over a
`Workspace`, in process. It models the decisions the adapter owns, as pure functions: `compile`,
the tool plan, the filesystem wrapper's write rule, the model connection, the event mapping, the
step stop and the memory journal over the engine-scoped store. The path rules are
`Authz/PathGrant.lean`'s, the frames are `Events/AgentFrames.lean`'s, and the permission switches,
refusal codes, protocols, provisional price list, frame vocabulary and pairing scan are
`Behaviour/Engines/OpenAiAgents.lean`'s; none is re-modelled.

## Compile

`compile` is `compileMastraRun`, check for check and in the same order: the policy arm, the file
grants (normalised against the adapter's `.mastra` directory), the gateway connection, its wire
protocol, spec A.11's environment verdict, the absence of a database connection variable (the
`DATABASE_ENV` pattern itself, modelled over the variable names: `DATABASE_URL` and
`*_DATABASE_URL`, libpq's `PG*`, `LIBSQL_*` and `TURSO_*`, in any case), a budget
cap on a model the provisional price table cannot price (a run naming no model is priced as the
adapter's default for its protocol family), the connectors (an unreadable record, and a tool asking
for an approval), and a fork. A requirement the engine cannot honour is refused with the port's
code and the capability it names — `wireProtocols`, `maxBudget`, `approvals`, `fork` — never
dropped, never emulated.

## Tools

Eleven of Mastra's workspace tools: `read_file`, `list_files`, `grep` and `file_stat` from
`readFiles`; `write_file`, `edit_file`, `mkdir` and `delete` from `writeFiles`; `execute_command`
and the two process tools from `runCommands`, withheld while a read-only grant exists (each
`mastra_workspace_`-prefixed). An accepted agent offers exactly those, and has network egress
exactly when `unrestrictedNetwork` allows it; the workspace disables every other tool. The skill
tools are offered exactly when a skill is granted, and the connectors handed to `MCPClient` are
exactly the request's, in order.

Withholding the command tools under a read-only grant is the one documented exception to
"refused, never narrower": as on the `openai-agents` and `pi` arms, the run goes ahead without them
rather than being refused, because a subprocess's writes (a redirect, say) never pass the
filesystem wrapper, and the grant would otherwise be unenforceable.

## Path grants

Before any grant is consulted, the wrapper resolves the path a tool named the way `LocalFilesystem`
does (`mastraWorkspacePath`): a leading `~` (the home directory) and an absolute path outside the
sandbox root are refused; an absolute path under the root has the root stripped; `''`, `.`, `./` and
the root itself are the workspace root, which is not written. Any other write goes through only when
`writeGrantVerdict` allows the resolved path: inside the workspace, outside the adapter's `.mastra`
directory and outside every read-only grant, however the path is spelled. A call that removes or
moves a path — `deleteFile`, a recursive `rmdir`, `moveFile`'s source — takes the whole subtree
with it, so it also asks the subtree rule (`mastraRemoveVerdict`): nothing at or under the path may
be a read-only grant or the `.mastra` directory. A recursive delete of `docs` therefore cannot take
a read-only `docs/contracts` with it. The TypeScript wrapper then repeats both checks on the path
with its symbolic links resolved (`guard.ts`); that half needs a filesystem and is the boundary
suite's.

## Egress

The compiled connection is the gateway's base URL without trailing slashes plus `/v1` and the run
token as `Authorization: Bearer`. `mastraProviderSpec` decides the provider `boundary.ts#modelFor`
builds from it: `createAnthropic` with the token as its `authToken` for Messages, `createOpenAI`
with the token as its `apiKey` and `.responses()` or `.chat()` for the OpenAI dialects, always at
the connection's base URL. Every *model* request the configuration can issue goes to the gateway,
on the protocol's own path, with the run token, and there is exactly one such endpoint; the model
is always that explicit provider, never a `"provider/model"` string. An HTTP connector reaches its
own host; that is not a model request and this rule does not cover it.

## Observability

Every compiled agent has telemetry off and no exporter. Before Mastra loads, the boundary installs
`mastraInstalledEnvironment` in the process: whatever the runner's environment held — a
`MASTRA_TELEMETRY_DISABLED=0` included — Mastra loads with `MASTRA_TELEMETRY_DISABLED=1` and
`MASTRA_OFFLINE=1`, an empty provider base URL removed, and every other variable kept. That the
adapter never constructs a `Mastra` instance is a declared gap, enforced by the boundary suite.

## Memory

Semantic recall, working memory and title generation are off for every accepted agent; the thread
is the platform session (or the one a resume names) and the resource is the tenant namespace. No
variable of an accepted request's **platform** run environment (`request.env`) is a database
connection variable by the `DATABASE_ENV` pattern; the model upper-cases ASCII only, and a name it
matches is all ASCII, so the TypeScript refuses at least every name the model does. This covers
only the platform's own environment (ADR-0084 D2): a stdio connector record's own `env` is merged
after this check and is not covered by it, by design, so a tenant's own database-backed MCP server
(a Postgres connector, say) keeps working with its own credential (Owner decision on #309). The
journal writes the
thread record and one entry per message into the thread's store stream; reading it back folds the
entries by key — the last thread record and the last write of each message win — and refuses a
stream with a message of another thread, an entry the adapter does not write, or no record of the
thread. A thread's messages, each with its own id, round-trip exactly.

## Events

Mastra's `fullStream` chunks map onto the neutral frames: `text-delta` and `reasoning-delta` to
`agent.message.delta`, `text-end` and `reasoning-end` to `agent.message` carrying the part's joined
text, `tool-call` to `agent.tool.call` (`mcp` for a connector's tool), `tool-result` and
`tool-error` to `agent.tool.result`, `error` to `agent.result {stopReason: 'error'}`, and the
adapter's terminal event (built from `finish`) to `agent.usage` then `agent.result`. Step boundaries
and everything else are `agent.native`; a chunk the mapper cannot read is `agent.malformed`. The
boundary's loop is modelled too (`boundaryEvents`): it forwards every raw chunk but `finish`, and
places `finish` as the terminal event — or, after an `error` chunk, which no second result may
follow, forwards it as `agent.native`. No raw chunk is dropped, every mapped stream keeps the
engine's own tool pairing, and so is `paired` in the sense of `Events/AgentFrames.lean`.

## Steps

Compile hands Mastra `limits.maxTurns` as its native `maxSteps`, unchanged. The adapter never
reports more steps than the limit; a `max_turns` stop is exactly at the limit; and a run whose model
keeps asking for tools up to the limit is cut short there and ends
`agent.result {stopReason: 'max_turns'}`. The boundary's verdict is `mastraStopReason`: the budget
cap first, then the caller's interrupt, then `max_turns` exactly when the run reached `maxSteps`
with its last step still asking for tools — a run that used exactly `maxSteps` steps and stopped on
its own ends `end_turn`. A per-run budget cap is priced per step from the port's provisional table
and stops the run `max_budget`.

## Theorems and vectors

- **T1** (`Theorems/Normative/Mastra.lean`): the tools are exactly the permitted ones and network
  egress is exactly `unrestrictedNetwork`; skills and connectors are honoured; semantic recall and
  working memory are off; a fork, an unpriced cap, an unspoken protocol and an approval are refused
  by name.
- **T2** (`Theorems/Invariants/Mastra.lean`): no chunk is dropped, and every raw chunk the
  boundary reads is represented; tool pairing holds, and every mapped stream is `paired`; compile's
  `maxSteps` is `maxTurns`; the run stops at or before `maxTurns`, a `max_turns` stop is at the
  limit, a run the limit cuts short ends `max_turns`, and the stop reason follows the boundary's
  precedence; a thread round-trips through the store.
- **T3** (`Theorems/Adversarial/Mastra.lean`): no permitted write lands in a read-only grant, and
  no permitted removal or move takes one; every model request goes to the gateway with the run
  token; the model is the protocol's explicit provider at the gateway; observability is off and
  the process environment Mastra loads under disables its telemetry; no accepted run carries a
  database connection variable.

The `engine-mastra` vectors are replayed by `tests/formal/engine-mastra.test.ts` against the real
`compileMastraRun`, `mastraToolPlan`, `mastraModelConnection`, `mastraProviderSpec`,
`mastraWriteAllowed`, `mastraRemoveAllowed`, `createMastraFrameMapper`, `readMastraThread`,
`mastraStopReason` and `mastraInstalledEnvironment`.

## Declared gaps

- The AI SDK provider issues model requests only to its base URL plus its method's path, with the
  run token as the bearer whether handed as `authToken` or `apiKey`.
- Mastra sends no telemetry and exports nothing without a `Mastra` instance and with
  `MASTRA_TELEMETRY_DISABLED` / `MASTRA_OFFLINE` set; the boundary never constructs a `Mastra`
  instance.
- Mastra emits a `finish` chunk at the end of every stream, after an `error` chunk included.
- Every workspace tool that writes goes through the `WorkspaceFilesystem` it is handed.
- Mastra stops its loop after `maxSteps` steps.
- Mastra's memory reads and writes a thread only through the storage domain it is handed.
- The symbolic-link half of the wrapper (`guard.ts`) needs a filesystem.

Each is third-party or filesystem behaviour Lean cannot prove; each is enforced by
`packages/engine-mastra/src/boundary.test.ts` (real Mastra against a scripted gateway that receives
every request of the process), `workspace.test.ts` and the engine conformance kit rather than by a
theorem.
