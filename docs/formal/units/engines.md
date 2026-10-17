# L-engines — the engine on the wire, in storage, and enforced (ENG-02a, ENG-02b, ENG-02c)

ENG-02c (#319) extends this unit rather than opening a new one: the same `engines` family gains the
catalogue route, the SDK resource and the CLI command, and the `Sdk`/`Cli` layer gains the
projection theorems and the `Authz` row that `GET /api/engines` needs.

## Scope

ADR-0065 makes an agent's **engine** — the harness that turns an agent definition and a prompt into
model calls, tool calls and a stream of events — an extension point behind one port.
`Concepts/Engine.lean` (ENG-01) already names the concept and proves the three rules that hold
before any TypeScript exists, and says of itself that "there is no wire codec here, because no
engine id is on the wire until ENG-02". This unit is that codec, and the two decisions that follow
from it.

- `Contracts/Engines.lean` — `EngineId`, `WireProtocol`, `LimitEnforcement` and `BudgetEnforcement`
  as `WireEnum`s in the TypeScript `as const` order, the four vocabularies as string lists, and
  `EngineCapabilitiesSchema` / `EngineDescriptorSchema` as strict object predicates with codecs.
- `Behaviour/Engines.lean` — `parsePolicyBody`'s verdict order (`invalid_body`,
  `unsupported_engine`, then the union), and migration 0025's per-row rewrite of `agents.policy`'s
  discriminant and `sessions.engine`. ENG-02b adds the two enforcements to the same module: the
  save-time capability check (`AssignmentCapabilities`, `AssignmentDemand`,
  `unsupportedCapability`, `saveAgent`) and session engine pinning (`LaunchState`, `startRun`,
  `recordIdentity`, `launchPaired`).
- `Contracts/Engines.lean`'s `CapabilityKey` — ENG-02b's `ENGINE_CAPABILITY_KEYS` as a `WireEnum`.
  It is a strict subset of the capability set's keys, because only `mcp` and `skills` are decided at
  save time; naming `resume` or `interrupt` in a save-time refusal would promise a check that does
  not exist.
- The refinement of the existing model to the renamed schema: `Contracts/Sessions.lean`'s
  `engineSessionId` and `engine`, `Contracts/Runs.lean`'s `Run.engine` and `Run.engineVersion`,
  `Concepts/Session.lean`'s `Session.engine` and its `enginePaired` invariant,
  `Er/Core.lean`'s renamed `sessions.engine_session_id`, renamed
  `sessions_workspace_engine_session_key` index, new `sessions.engine`, `runs.engine` and
  `runs.engine_version` columns and their two `oneOf` checks, and `Er/Target.lean`'s glossary term.
- `Sdk/Engines.lean` and `Cli/Engines.lean` (ENG-02c) — the catalogue as a projection: the route's
  two answers (`catalogue` / `refused`), `engines.list()`'s unwrapping of the `{ engines }`
  envelope, the CLI's output modes and columns, and `--engine`'s three-valued resolution against
  the catalogue. They keep only the four descriptor fields the projection can observe;
  `capabilities` belongs to `Contracts/Engines.lean` and is proved there.

`EngineId` lists one member while `Concepts.Engine.Engine` lists five. That is not a disagreement:
the concept enumerates what the design admits, and the contract enumerates what a deployment can be
asked for today. Later units append.

## Theorems and vectors

- **T0** (`Theorems/WellFormed/ContractsEngines.lean`): codec round-trips for every new enum;
  `wire_orders_match_the_exports`, which pins the `as const` order rather than only the membership;
  `engine_ids_are_not_model_providers`, which is why the engine needed its own field name; strictness,
  the non-empty `wireProtocols` rule, and `maxTurns`'s refusal of `none`.
- **T1** (`Theorems/Normative/ContractsEngines.lean`): the parser's two refusals, each stated over
  **both** answers the Zod union can give, so "whatever the union would have said" is proved rather
  than asserted. This refines ENG-01's `compose_refuses_rather_than_dropping_a_requirement` from the
  abstract composition to `PUT /api/agents/:id/policy`. `the_refusal_is_about_the_registry` separates
  `unsupported_engine` from a claim about spelling.
  ENG-02b adds the save-time capability check to the same tier: `capability_refusal_is_exact` states
  it in **both** directions over all sixteen `(capabilities, demand)` pairs — which is every input
  the decision reads — `a_capability_refusal_names_a_real_gap` rules out a refusal that names
  something beside the point, `claude_agent_sdk_never_refuses_an_assignment` is the "nothing changes
  for Claude agents" criterion, and `capability_check_refines_compose` shows the concrete check _is_
  ENG-01's abstract `compose` instantiated on the two assignable portable concepts rather than a
  second rule that resembles it.
- **T2** (`Theorems/Invariants/BehaviourEngines.lean`, ENG-02b): session engine pinning on the real
  launch behaviour. `session_engine_mismatch_creates_no_run` is the acceptance criterion in full — the
  state is _unchanged_, so the run row is never written rather than written and rolled back — and
  `session_engine_mismatch_is_exactly_a_different_pin` gives both directions.
  `a_run_never_repins_the_session` and `a_run_never_claims_an_engine_session_id` are why the
  invariant holds of every reachable state rather than of a checked one, and
  `recording_identity_establishes_the_pairing` is the release invariant
  (`engine IS NULL AND engine_session_id IS NOT NULL` never holds) at its single writer.
  ENG-01's `every_run_of_a_session_carries_the_session_engine` already carries the sequence-level
  statement over the abstract session; this file refines it onto the state the control plane has.
- **T4** (`Theorems/Refinement/ContractsEngines.lean`): migration 0025. The discriminant rename
  carries the value and every other key across; the session backfill pins exactly the identified
  sessions and never touches an identity; both halves are idempotent;
  `session_backfill_establishes_the_pairing` is the acceptance criterion's
  `select count(*) from sessions where engine is null and engine_session_id is not null` = 0, and
  `the_backfill_has_something_to_do` rules out a migration that satisfies it by doing nothing.
- **T2** (`Theorems/Invariants/SdkEngines.lean`, ENG-02c #319): `engines.list` and
  `aw engines list` are a **total projection** of the registry — `list registry = some registry`,
  which is the same elements, each exactly once, in the registry's order, at the route, through the
  SDK and through every CLI output mode. Its other half is the refusal: a registry holding a
  descriptor `EngineDescriptorSchema` cannot describe yields no list at all, never the publishable
  subset a caller would read as the whole catalogue. `the_engine_flag_is_resolved_or_refused` adds
  `aw agents create|update --engine`, which has exactly three answers and no silent default.
- **T1, the RBAC row** (`Theorems/Normative/AuthzDecide.lean`, ENG-02c #319):
  `engine_catalogue_is_read_by_every_role` — `GET /api/engines` is allowed for all four roles under
  every ownership answer, and refused as a write to admin, builder and viewer. The `engines`
  resource joins `RESOURCES` (now 26), §3.3's documented table and the four generated role-table
  cells, and `ENG-02C-ENGINES-319`'s route joins `declaredRoutes` (now 102).
- `Vectors/Engines.lean` emits `sdk.json`, `cli.json`, `catalog.json`, `schemas.json`,
  `policy.json`, `migration.json` and ENG-02b's `enforcement.json`. `apps/web/formal/engines.test.ts`
  replays all but `cli.json` against the real `AgentPolicySchema`, `apps/web/server/agents/policy.ts`'s
  `parsePolicyBody` and `engineCapabilityRefusal`, `apps/web/server/engines/registry.ts`,
  `apps/web/server/composition/session-launch.ts`'s `sessionForLaunch`, the real `GET /api/engines`
  route handler driven through the RBAC harness (for `sdk.json`) and — for the pinning vectors — the
  **real run route**, `apps/web/server/runs/api.ts`'s `startRun` with a run store installed, so "and
  creates no run row" is replayed against the rows and not against a verdict.
  `tests/formal/engines.test.ts` replays `cli.json` against the real `aw` binary through its public
  `main`/`CliIo` boundary (decision D-012's split).

The T1 and T4 statements quantify over explicit domains (`unionVerdicts`, `sessionCases`,
`policyCases`, `assignmentCapabilities`, `assignmentDemands`) rather than over every value of their
types, so each is decided by `decide` rather than by a tactic script standing in for the statement.
The domains are exhaustive up to what the functions under proof actually read: the union's answer is
a boolean, both migration functions read only whether each cell is present, and the capability check
reads only whether each resource is demanded and each capability supported — which is why the demand
is modelled as two booleans rather than two counts.

ENG-02b's pinning statements in `BehaviourEngines.lean` are the exception, and deliberately: they
quantify over every `LaunchState` and every pair of engine ids (published ids, for the two that
conclude `created`), because "and creates no run row" is a claim about the rows a _particular_
fixture would not establish. They are proved by case analysis with concrete witnesses beside them.

## Verification

Built and regenerated locally, with the Lean toolchain, on the tree that merges ENG-02b (#318) onto
`main` after ENG-02c (#321). The implementing session had no toolchain, so this is the first run
that checks ENG-02b's Lean.

- `pnpm formal:build`: 345 jobs, no errors.
- `pnpm formal:generate`: 2768 catalogue entries (2741 on `main` before ENG-02b) and 158 vector
  files, every citation resolving. ENG-02b adds 27 entries: 6 **T1** theorems in
  `Theorems/Normative/ContractsEngines.lean`, 9 **T2** theorems in
  `Theorems/Invariants/BehaviourEngines.lean`, and 12 model declarations.
- `pnpm formal:check`: 12020 declarations audited, depending only on `propext`, `Classical.choice`
  and `Quot.sound`; 430 import edges follow the layer direction; the generated artefacts are current.
- The replay (`pnpm vitest run tests/formal apps/web/formal apps/runner/formal`): 32 files and 8090
  vectors pass, 5 skipped, including every vector of `enforcement.json`, `sdk.json` and `cli.json`.

The `enforcement.json` committed before this run was emitted by a Node re-implementation of
`Vectors.writeFamily`'s printer rather than by `lake exe`. `pnpm formal:generate` rewrote it
byte-for-byte unchanged, so it is now the file Lean emits. What was stale was
`formal/generated/catalogue.json`, `docs/formal/catalogue.md` and `docs/formal/traceability.md`,
and this run regenerated all three.

One statement changed on the first build. `an_unpinned_session_accepts_any_engine` and
`a_run_records_the_engine_the_session_is_pinned_to` quantified over every engine string and
concluded `created`. The code narrows the engine it records with `publishedEngineId`, which throws
for an id outside `ENGINE_IDS`. Both theorems therefore now assume `engine ∈ engineIds`, and a
witness shows that `claude-agent-sdk` satisfies the assumption. The theorems about the rows a refusal
leaves need no such assumption, because a throw also writes no row.

## Follow-ups

- The transcript routes are still addressed by a path segment named `:engineSessionId`. The segment
  is the route path, which `Authz/Decide.lean` and the `authz-decide` vectors cite verbatim, so
  renaming it is a route change rather than a field rename and is deliberately outside ENG-02.
- Neither slice models the _run-compose_ half of ADR-0065 D3's "the refusal happens at agent save
  **and** at run compose". Save time is ENG-02b's; compose time needs the engine port (#303), which
  is where a compile can refuse, so it belongs to that unit.
- `PUT /api/agents/:id/resources` can still attach a connector to an agent whose engine cannot honour
  one. #318's items name the policy route and the one-call create, and both are covered; the
  assignment route is the third door and is listed as an open question on that pull request.
