import AgentWorkspace.Contracts.Engines

/-!
# The engine's decisions: the policy parser, the rename migration, and the two enforcements

ENG-02a (#317) names the engine in the contracts and in storage; ENG-02b (#318) enforces it where it
matters. Four behaviours follow, and all four are stated here as pure functions over explicit state
so that the theorems about them are about the real decision rather than about a paraphrase of it.

The last two are ENG-02b's, and they are at the bottom of the file: the save-time capability check
(`engine_capability_unsupported`) and session engine pinning (`session_engine_mismatch`).

## `parsePolicyBody` (`apps/web/server/agents/policy.ts`)

ADR-0065 renamed `AgentPolicy`'s discriminant from `provider` to `engine`, because `provider`
already means the *model* provider on `runs` and on `model_connections`. The parser therefore has
three answers before it ever reaches the Zod union, and the order matters:

1. a body carrying `provider` and no `engine` is the pre-ADR-0065 shape: `invalid_body`. It is
   refused by name rather than accepted, and rather than reported as "`engine` is missing";
2. a body whose `engine` is not one this deployment *registers* is `unsupported_engine`. The
   question is about the registry, not about `ENGINE_IDS`: a deployment installs some of the
   catalogue, and naming an engine it does not install is a different mistake from naming one that
   does not exist;
3. anything else goes to the union, which answers `invalid_policy` for every other shape failure.

`registered` is a parameter rather than a constant for exactly the reason the TypeScript takes one:
while `claude-agent-sdk` is the only engine the contracts publish, no body could otherwise reach
answer 2 with a parseable `engine`, and a refusal that cannot be reached is a refusal that is not
proved.

## Migration 0025 (`migrations/0025_name_the_engine_in_stored_rows.sql`)

The rename that `ALTER TABLE` cannot reach: the discriminant *inside* the `agents.policy` jsonb
document, plus the backfill of `sessions.engine` for every session that already has an identity.
`migrateRow` is the whole of it, per row, so the refinement theorem can quantify over every
pre-migration row rather than over the three the test happens to write.
-/

namespace AgentWorkspace.Behaviour.Engines

open AgentWorkspace AgentWorkspace.Contracts.Engines

/-! ## The policy parser -/

/-- What `parsePolicyBody` answers. Every arm is a `400`; they are told apart because each names a
different thing the client can fix. -/
@[aw_spec (ts := "apps/web/server/agents/policy.ts#parsePolicyBody")
  (ts := "packages/contracts/src/agents.ts#AGENT_POLICY_PROBLEM_CODES")]
inductive PolicyVerdict where
  /-- The body parsed: its `engine` is registered and its shape matched the union. -/
  | accepted
  /-- `400 invalid_body`: the body carries the pre-ADR-0065 `provider` discriminant. -/
  | invalidBody
  /-- `400 unsupported_engine`: a parseable `engine` this deployment does not register. -/
  | unsupportedEngine
  /-- `400 invalid_policy`: every other shape failure. -/
  | invalidPolicy
  deriving DecidableEq, Repr, Inhabited

namespace PolicyVerdict

/-- The problem code each verdict travels under. `accepted` has none. -/
def code : PolicyVerdict → Option String
  | accepted => Option.none
  | invalidBody => some "invalid_body"
  | unsupportedEngine => some "unsupported_engine"
  | invalidPolicy => some "invalid_policy"

/-- Every refusal is a `400`: the four answers differ in what the client should change, not in
whether the request was the client's fault. -/
def status : PolicyVerdict → Nat
  | accepted => 200
  | _ => 400

end PolicyVerdict

/-- A body as the parser sees it: a JSON value, with no assumption that it is even an object. -/
abbrev Body := JValue

/-- Whether an object body states `name` at all. Absent and `null` are different: only the first
makes the body the *old* shape. -/
def states (name : String) (j : Body) : Bool :=
  match j with
  | .obj fs => (JValue.lookup name fs).isSome
  | _ => false

/-- The value of `engine`, when the body is an object that states it as a string. -/
def engineText (j : Body) : Option String :=
  match j with
  | .obj fs => match JValue.lookup "engine" fs with
    | some (.str s) => some s
    | _ => Option.none
  | _ => Option.none

/-- `parsePolicyBody`: the three named refusals, then the union.

`accept` stands for the Zod union's own verdict on a body that has cleared the two engine checks;
the replay suite supplies the real `AgentPolicySchema` for it, so this function is the *order* of
the decisions and not a second copy of the schema. -/
@[aw_spec (ts := "apps/web/server/agents/policy.ts#parsePolicyBody")]
def parsePolicy (registered : List String) (accept : Body → Bool) (j : Body) : PolicyVerdict :=
  if states "provider" j && !states "engine" j then .invalidBody
  else if states "engine" j && !registered.contains ((engineText j).getD "") then .unsupportedEngine
  else if accept j then .accepted
  else .invalidPolicy

/-- The engines a deployment registers by default: the catalogue, and nothing else. -/
def defaultRegistered : List String := engineIds

/-! ## Migration 0025 -/

/-- The engine every row this migration touches belongs to: the only engine the platform has ever
run, which is why the backfill is a record rather than a guess. -/
def migratedEngine : String := EngineId.toWire .claudeAgentSdk

/-- A stored policy document, as `agents.policy` holds one: the discriminant, and the rest of the
document the migration must carry across untouched. -/
structure StoredPolicy where
  /-- `some` under the key the document uses. `none` for a `NULL` column. -/
  discriminant : Option (String × String)
  /-- Every other key, opaque to the migration. -/
  rest : List (String × String)
  deriving DecidableEq, Repr, Inhabited

/-- `agents.policy`'s pre-migration form: discriminated by `provider`. -/
def legacyPolicy (rest : List (String × String)) : StoredPolicy :=
  { discriminant := some ("provider", migratedEngine), rest }

/-- The jsonb rewrite of migration 0025, per document.

`(policy - 'provider') || jsonb_build_object('engine', policy ->> 'provider')`, and its `WHERE`:
a document that already states `engine` is left alone, which is what makes the migration
re-runnable, and a document stating neither key is left for a reader to find rather than given an
invented engine. -/
@[aw_spec (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#agents")]
def migratePolicy (p : StoredPolicy) : StoredPolicy :=
  match p.discriminant with
  | some ("provider", value) => { p with discriminant := some ("engine", value) }
  | _ => p

/-- One `sessions` row, in the two cells the migration reads and writes. -/
structure StoredSession where
  engineSessionId : Option String
  engine : Option String
  deriving DecidableEq, Repr, Inhabited

/-- The backfill of migration 0025: every session that already has an identity names the engine
that reported it; a session with no identity is left unpinned. -/
@[aw_spec (ts := "migrations/0025_name_the_engine_in_stored_rows.sql#sessions")]
def migrateSession (s : StoredSession) : StoredSession :=
  if s.engine.isNone && s.engineSessionId.isSome then { s with engine := some migratedEngine }
  else s

/-- The release invariant, as a predicate on one row: a session that has an engine session id
names the engine that produced it. -/
@[aw_spec (ts := "packages/core/src/db/schema/sessions.ts#sessions")]
def enginePaired (s : StoredSession) : Bool := s.engineSessionId.isNone || s.engine.isSome

/-! ## The save-time capability check (ENG-02b)

ADR-0065 D3 is "refuse, never ignore": an engine handed an agent whose portable configuration it
cannot honour is refused, never run with the configuration silently dropped. Two of the platform's
portable concepts are *assignable* — MCP connectors and `SKILL.md` skills — and ADR-0133 D14 adds a
third an agent's version body can demand, the subagents it names. All three are therefore decidable
at agent save, which is where a caller can still act on the answer.

The demand is modelled as three booleans rather than three counts, because presence is the whole
of what the decision reads. A threshold ("more than three connectors") is not a capability
question, and making it a Nat would only add states no branch distinguishes. -/

/-- What one engine can honour of the three demandable resources: the `mcp`, `skills` and
`subagents` fields of `EngineCapabilitiesSchema`, and nothing else from it. -/
@[aw_spec (ts := "packages/contracts/src/engines.ts#EngineCapabilitiesSchema")]
structure AssignmentCapabilities where
  mcp : Bool
  skills : Bool
  subagents : Bool
  deriving DecidableEq, Repr, Inhabited

/-- What one agent would make its engine honour: whether it is assigned a connector, whether a run
of it would materialise a skill, and whether its version body names a subagent. -/
@[aw_spec (ts := "apps/web/server/engines/capabilities.ts#EngineCapabilityDemand")]
structure AssignmentDemand where
  connectors : Bool
  skills : Bool
  subagents : Bool
  deriving DecidableEq, Repr, Inhabited

/-- Whether this engine can honour this agent at all: every demanded resource is supported.

Stated separately from {@link unsupportedCapability} on purpose. The theorem that the refusal is
*exact* compares the two, and a single definition serving as both the decision and its specification
would make that comparison vacuous. -/
def honoursAssignments (cap : AssignmentCapabilities) (demand : AssignmentDemand) : Bool :=
  (!demand.connectors || cap.mcp) && (!demand.skills || cap.skills) &&
    (!demand.subagents || cap.subagents)

/-- The capability the engine lacks and the agent demands, or `none`.

Connectors are consulted before skills, and skills before subagents, so a refusal names one
capability rather than a set: the caller fixes one thing and a second save answers the next. -/
@[aw_spec (ts := "apps/web/server/engines/capabilities.ts#unsupportedEngineCapability")]
def unsupportedCapability (cap : AssignmentCapabilities) (demand : AssignmentDemand) :
    Option CapabilityKey :=
  if demand.connectors && !cap.mcp then some CapabilityKey.mcp
  else if demand.skills && !cap.skills then some CapabilityKey.skills
  else if demand.subagents && !cap.subagents then some CapabilityKey.subagents
  else Option.none

/-- What `PUT /api/agents/:id/policy` and the one-call create answer about the engine. -/
@[aw_spec (ts := "packages/contracts/src/engines.ts#ENGINE_PROBLEM_CODES")]
inductive CapabilityVerdict where
  /-- The engine can honour this agent; the save proceeds. -/
  | saved
  /-- `422 engine_capability_unsupported`, naming the capability. -/
  | unsupported (capability : CapabilityKey)
  deriving DecidableEq, Repr, Inhabited

namespace CapabilityVerdict

def code : CapabilityVerdict → Option String
  | saved => Option.none
  | unsupported _ => some "engine_capability_unsupported"

/-- `422`, not `400`: the body is well formed and the engine is registered. It is the *combination*
with what this agent is assigned that cannot be honoured. -/
def status : CapabilityVerdict → Nat
  | saved => 200
  | unsupported _ => 422

/-- The refusal's `details`: exactly one entry, the capability, so a client branches on a published
wire string rather than on prose. -/
def details : CapabilityVerdict → List String
  | saved => []
  | unsupported c => [CapabilityKey.toWire c]

end CapabilityVerdict

/-- The save-time decision itself. -/
@[aw_spec (ts := "apps/web/server/agents/policy.ts#engineCapabilityRefusal")]
def saveAgent (cap : AssignmentCapabilities) (demand : AssignmentDemand) : CapabilityVerdict :=
  match unsupportedCapability cap demand with
  | some capability => CapabilityVerdict.unsupported capability
  | Option.none => CapabilityVerdict.saved

/-- `claude-agent-sdk`'s three demandable capabilities, as `apps/web/server/engines/registry.ts`
states them: connectors and skills are honoured; subagents are not yet, like every engine in the
catalogue, which declares `subagents: false` until a run can delegate to one. -/
@[aw_spec (ts := "apps/web/server/engines/registry.ts#registeredEngines")]
def claudeAssignmentCapabilities : AssignmentCapabilities := ⟨true, true, false⟩

/-- Every capability triple, so a statement can quantify over all of them. -/
def assignmentCapabilities : List AssignmentCapabilities :=
  [⟨true, true, true⟩, ⟨false, true, true⟩, ⟨true, false, true⟩, ⟨false, false, true⟩,
   ⟨true, true, false⟩, ⟨false, true, false⟩, ⟨true, false, false⟩, ⟨false, false, false⟩]

/-- Every demand an agent's assignments and version body can make. -/
def assignmentDemands : List AssignmentDemand :=
  [⟨false, false, false⟩, ⟨true, false, false⟩, ⟨false, true, false⟩, ⟨true, true, false⟩,
   ⟨false, false, true⟩, ⟨true, false, true⟩, ⟨false, true, true⟩, ⟨true, true, true⟩]

/-! ## Session engine pinning, on the real launch behaviour (ENG-02b)

ADR-0065 D8: a session stays on the engine it started with. `Concepts/Engine.lean` proves that
abstractly, over a session whose engine is pinned at creation. This is the same rule over the state
the control plane really has — `sessions.engine` NULL until a run pins it, `sessions.engine_session_id`
written with it, and the `runs` rows — so that "no run row is created" is a statement about the rows
rather than about a comparison.

`startRun` is a transition, not a predicate: it answers a verdict *and* a next state. That is the
whole content of the acceptance criterion, which is about both. -/

/-- One `runs` row, in the cell this decision writes: the engine that executed the run. -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs.ts#CreateRunInput")]
structure RunRow where
  engine : String
  deriving DecidableEq, Repr, Inhabited

/-- The state a run-create decision reads and writes. -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs.ts#SessionRecord")]
structure LaunchState where
  /-- `sessions.engine`: `none` until a run pins it. -/
  sessionEngine : Option String
  /-- `sessions.engine_session_id`: `none` until the runner reports one. -/
  engineSessionId : Option String
  /-- This session's `runs` rows, oldest first. -/
  runs : List RunRow
  deriving DecidableEq, Repr, Inhabited

/-- What `startRun` answers about the engine. -/
@[aw_spec (ts := "packages/contracts/src/engines.ts#ENGINE_PROBLEM_CODES")]
inductive LaunchVerdict where
  /-- The run is queued, recording the engine it names. -/
  | created (engine : String)
  /-- `409 session_engine_mismatch`. -/
  | engineMismatch
  deriving DecidableEq, Repr, Inhabited

namespace LaunchVerdict

def code : LaunchVerdict → Option String
  | created _ => Option.none
  | engineMismatch => some "session_engine_mismatch"

/-- `409`, not `400`: nothing about the request is malformed. The session has a history this run
does not belong to. -/
def status : LaunchVerdict → Nat
  | created _ => 202
  | engineMismatch => 409

end LaunchVerdict

/-- `POST /api/agents/:id/runs`, in the one dimension this unit decides.

A session with no engine takes the agent's; a session that has one keeps it, and an agent naming a
different engine is refused with the state **unchanged** — the run row is not written and rolled
back, it is never written. The session is never re-pinned: switching a live session to another
engine is a non-goal of the engine programme, because a session's history belongs to the engine that
produced it.

A `created` answer models the code for a **published** engine id only. The code narrows the engine
it records with `publishedEngineId`, which throws for an id outside `ENGINE_IDS` and so writes no
row; the theorems that conclude `created` carry that hypothesis, and the ones about the rows a
refusal leaves hold of a throw as well. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d8--a-session-is-pinned-to-one-engine")
  (ts := "apps/web/server/runs/api.ts#startRun")]
def startRun (agentEngine : String) (s : LaunchState) : LaunchVerdict × LaunchState :=
  match s.sessionEngine with
  | Option.none => (LaunchVerdict.created agentEngine,
      { s with runs := s.runs ++ [⟨agentEngine⟩] })
  | some pinned =>
      if pinned = agentEngine then
        (LaunchVerdict.created pinned, { s with runs := s.runs ++ [⟨pinned⟩] })
      else (LaunchVerdict.engineMismatch, s)

/-- `recordReportedSessionIdentity`: the reported id and the engine that reported it, in one update.
Splitting them would leave a window in the state `enginePaired` denies. -/
@[aw_spec (ts := "apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity")]
def recordIdentity (engine reported : String) (s : LaunchState) : LaunchState :=
  { s with sessionEngine := some engine, engineSessionId := some reported }

/-- A session before its first run: no engine, no identity, no runs. -/
def freshSession : LaunchState := ⟨Option.none, Option.none, []⟩

/-- {@link enginePaired}, on the launch state: a session that has an engine session id names the
engine that produced it. -/
def launchPaired (s : LaunchState) : Bool :=
  s.engineSessionId.isNone || s.sessionEngine.isSome

end AgentWorkspace.Behaviour.Engines
