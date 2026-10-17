# ADR-0070 — The engine port, the private `/run` contract, and the cap on `raw`

Status: accepted
Date: 2026-09-28
Decided by: the agent-engines programme (tracker #299, unit ENG-04 #303)
Scope: `packages/engine`; `packages/engine-claude-agent-sdk`; `apps/runner/src/engines.ts`,
`runtime.ts`, `server.ts`, `index.ts`, `session.ts`; `packages/core/src/schemas.ts`'s `RunRequest`;
`apps/web/server/engines/protocol.ts` and `apps/web/server/compose/run-request.ts`;
`tests/no-sdk-import.test.ts`; `dependency-cruiser.config.mjs`;
`formal/AgentWorkspace/Behaviour/EnginePort.lean`, `Behaviour/SandboxEnv.lean`,
`Authz/PathGrant.lean`

## Context

ADR-0065 made the engine an extension point and named the shape it should take. ENG-02 (#301) gave
engines an identity in the contracts and a registry in the control plane; ENG-03 (#302) gave their
messages one neutral `agent.*` vocabulary. Neither made the runner engine-agnostic: `apps/runner`
still imported an SDK boundary directly, `packages/core` still held a Claude-shaped compile step,
and a second engine would have meant editing a run path rather than adding a package.

This unit is the extraction. Four decisions were open and each had a cheaper wrong answer.

## Decision

### D1 — `compile` is separate from `start`, and its refusals are values

`AgentEngine` has two methods where one would do. `compile(request)` is pure: it parses this
engine's policy arm, consults its declared capabilities, assembles the sandbox environment and
answers `{ ok: true, compiled }` or an `EngineRefusal` carrying a stable code. `start` is called
only after a successful compile.

The separation buys the T2 invariant. A refusal decided by `compile` is decided **before any
output frame**: nothing has been written to the socket, nothing has been spawned, and the run can
still be answered with a code a control plane branches on. Folding the two together would mean an
adapter discovering, three frames in, that it could not honour the request — and a consumer that
had already stored those frames being told to discard them.

The refusals are _values_ and not throws for the same reason every other boundary in this
repository returns a verdict: a thrown `Error` carries a sentence, and the runner would have to
decide what kind of failure it was by reading the message.

### D2 — the runner reaches an adapter through one file, and the specifier is a literal

`apps/runner/src/engines.ts` holds a static table of `engine id → () => import('…')`. Two
properties, and both are enforced rather than described:

- **one file.** `dependency-cruiser.config.mjs`'s `runner-reaches-engine-adapters-only-through-engines-ts`
  forbids every other module in `apps/runner` from naming a `packages/engine-*` path. That is what
  makes "adding an engine is adding a package" a fact rather than an aspiration.
- **a literal specifier.** `tests/no-sdk-import.test.ts` resolves every module reference with the
  TypeScript compiler and refuses one it cannot read (ADR-0031). An id interpolated into a
  specifier would fail that gate, which is the right answer — a gate that cannot decide a call
  site must refuse it. The table is the shape that satisfies both.

The import is **dynamic** because an image built without an adapter must come up, serve
`/healthz`, and answer `run-error {code: 'engine_not_installed'}`. A static import would make it
fail to start instead: the same information, delivered as a crash.

### D3 — the private `/run` contract gains `engine` and `gateway`; the rest of v2 is deferred

`RunRequest` gains two fields:

- `engine`, **defaulted** rather than required. The runner and the control plane ship together but
  are _deployed_ separately, so for one rollout window a new runner receives bodies an old control
  plane composed. Defaulting to the engine that existed before this unit makes that window a run
  on the right engine instead of a `400`.
- `gateway: { baseUrl, token, protocol }`, optional for the same window. It is what lets the port
  hand an adapter its model connection _programmatically_ instead of having every adapter
  reconstruct it from two environment variables named after one engine's CLI, and it carries the
  `protocol` the compose-time check resolved.

What is **not** in this unit is the rest of ENG-04's v2: splitting `agent` into a portable core
plus a named engine arm, and dropping `scope`. That change reaches `RunRequest`'s shape, and the
issue's own stop condition asks for the callers to be listed before it is made. They are listed
on the unit's PR. Until then the port carries the Claude-shaped `agent`/`scope` pair as its opaque
`policy` arm — which the adapter _parses_ rather than casts, so the day the shape changes the
refusal is typed and immediate — and `dependency-cruiser` records `@agent-workspace/core` as a
transitional dependency of an adapter with the sentence that removes it.

### D4 — `raw` is capped at 64 KiB per frame, and truncation is a marker rather than a drop

Restated here because ENG-04 is where the builders moved. `AGENT_FRAME_RAW_MAX_BYTES` is 65 536
bytes of `JSON.stringify` output. A payload over it is **truncated, never rejected**: `raw` exists
so nothing is lost, but the neutral fields beside it are what a consumer renders, and dropping the
frame to protect the log would lose those too. A payload that cannot be serialised at all — a
cycle, a BigInt — gets the same marker with `encodedBytes: null`, so the frame renders instead of
failing later.

For a **new** adapter, the cap is applied by `@agent-workspace/engine`'s `engineFrameBuilder`,
which also fills `engine`: such an adapter names its engine once and cannot forget either on the
fourth frame of an eight-frame fan-out, because it never writes either by hand. The builders are
the port's offering to the next adapter; today their only caller is the conformance kit's scripted
engine.

The shipped Claude adapter does **not** use them. It reaches the same two rules through
`packages/core`'s `toAgentFrames`, which applies `packages/core`'s own `capAgentFrameRaw` and sets
`engine` itself — the mapping that has to stay in `core` while the control plane still upgrades
pre-ENG-03 `run_events` rows with it (Deviation 2 on the unit's PR). That is a declared
duplication of the two rules in two packages, not a second mechanism: when Deviation 2 is resolved
and the Claude mapping moves into its adapter, it is rebuilt on `engineFrameBuilder` and
`packages/core`'s `capAgentFrameRaw` is removed.

**Amendment (R2c, #958).** The Claude mapping is now built on `engineFrameBuilder`: `toAgentFrames`
makes every frame through the builder, so `engine` and the capped `raw` come from the one
implementation every adapter shares. `packages/core`'s `capAgentFrameRaw` is a re-export of the
port's `capFrameRaw`, not a second copy; the name stays because `apps/web/server/runs/` and the
contract's documentation refer to it. The mapping itself stays in `packages/core` until Deviation 2
is resolved, because the control plane (which may not import an adapter) still runs it over
pre-ENG-03 `run_events` rows; moving it would leave two copies of the same ~200 lines. The Claude
adapter's own `start` skeleton is the port's `createEngineAdapter`, like the other adapters'.

## Consequences

- **Adding an engine is adding a package.** A row in `apps/runner/src/engines.ts`, a row in
  `ENGINE_SDK_BOUNDARIES` (`tests/no-sdk-import.test.ts`), a descriptor in
  `apps/web/server/engines/registry.ts`, a `deps` line in `runtime.Dockerfile`, and a passing
  `expectConformance`. No run path changes.
- **The §42 claim is now per engine.** The boundary gate's table applies the same set equality and
  the same emitted-`.d.ts` leak check to every SDK, so the second adapter gets the gate rather
  than an exception.
- **Spec A.11 generalises.** `sandboxEnvironmentVerdict` states the rule as a property of the
  environment — no `ANTHROPIC_API_KEY`, and every `*_API_KEY` / `*_AUTH_TOKEN` holding this run's
  own gateway token — so an engine this repository has never heard of is covered. The declared
  gap is a credential in a variable spelled neither way; `RunEnvironment`'s reserved names and the
  gateway's own issuance remain the primary defences. The rule's other edge is agent secrets: a
  secret stored as `OPENAI_API_KEY` or `STRIPE_API_KEY` is a valid secret name
  (`packages/contracts/src/secrets.ts`) and would make every engine refuse the run. So
  `packages/runtime`'s `buildRuntimeEnvironment`, the injector that emits agent secrets, refuses a
  credential-shaped secret name with a sentence about the secret rather than letting the engine
  refuse it later with a sentence about model connections. Neither path is live yet (no production
  caller passes agent secrets); refusing such a name at save time (`POST /api/secrets`), or scoping
  the rule to the provider spellings the gateway serves, is left to the unit that connects secrets
  to runs.
- **One behaviour change is visible on the wire.** The runner's terminal frame reports `events` as
  the number of _frames_ it wrote, where it used to report the number of engine messages: the
  one-to-many mapping now happens in the adapter, and what this server can honestly count is what
  it wrote.
- **A stricter compile.** Three refusals are new and each turns a late failure into a named one: a
  policy arm the adapter cannot read, a fork on an engine whose capabilities forbid it, and a
  credential-shaped variable holding something other than the run token.
  `formal/AgentWorkspace/Theorems/Refinement/EnginePortCompile.lean` states each as a difference
  from the old path rather than folding them into the behaviour-preservation claim.

## Alternatives considered

**Keep the compile step in `packages/core` and let adapters import it.** Cheaper today and wrong
at the second engine: `core` would hold one engine's option surface, and every other adapter would
depend on a package shaped by a competitor's SDK.

**Make the registry a plugin loader that scans `node_modules`.** It would resolve specifiers this
repository's own boundary gate cannot read, and the gate would have to be relaxed to accept it.
ADR-0031's rule points the other way: a static gate that cannot decide a construct refuses it, and
the construct changes.

**Require `engine` and `gateway` rather than defaulting them.** Correct as an end state and wrong
as a deployment step: a required field makes the rollout window a window of `400`s.
