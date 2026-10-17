import AgentWorkspace.Behaviour.Engines
import AgentWorkspace.Concepts.Engine

namespace AgentWorkspace.Theorems.Normative.ContractsEngines

open AgentWorkspace AgentWorkspace.Behaviour.Engines AgentWorkspace.Contracts.Engines

/-! # T1 — the engine is refused, never ignored

Two decisions live here. The first half of the file is ENG-02a's policy parser; the second half is
ENG-02b's save-time capability check, which is where "refuse, never ignore" stops being about the
shape of a body and becomes about the agent it describes.

## The policy parser refuses, and never ignores

This refines ENG-01's `compose_refuses_rather_than_dropping_a_requirement`
(`Theorems/Normative/Engine.lean`) from the abstract composition to the first place a real request
meets it: `PUT /api/agents/:id/policy`.

Two refusals are proved:

* the pre-ADR-0065 `provider` discriminant is never accepted;
* an engine this deployment does not register is never accepted, and is told apart from every other
  shape failure by its own problem code.

Each is stated **over every union verdict**: `unionVerdicts` is the finite set of answers the Zod
union can give a body, so "for every `accept` in that set" is the same statement as "whatever the
union would have said", and it is decidable. That matters, because the failure this rules out is a
parser that consults the union *first* and lets a body the union likes through while it names the
old discriminant.
-/

/-! ## The bodies and the union verdicts a statement quantifies over -/

private def legacyBody : Body := .obj [("provider", .str "claude-agent-sdk")]
private def legacyBodyWithMore : Body :=
  .obj [("provider", .str "claude-agent-sdk"), ("skills", .obj [("mode", .str "all")])]
private def acpBody : Body := .obj [("engine", .str "acp")]
private def unknownEngineBody : Body := .obj [("engine", .str "goose")]
private def nonStringEngineBody : Body := .obj [("engine", .num 1 0)]
private def claudeBody : Body := .obj [("engine", .str "claude-agent-sdk")]
private def bothBody : Body :=
  .obj [("engine", .str "claude-agent-sdk"), ("provider", .str "anthropic")]

/-- The two answers the Zod union can give, as functions of the body: it accepts everything, or it
accepts nothing. Quantifying over both is what makes "whatever the union would have said" a proved
statement rather than a claim about the parser's implementation order. -/
private def unionVerdicts : List (Body → Bool) := [fun _ => true, fun _ => false]

/-- The bodies that carry the pre-ADR-0065 discriminant and no `engine`. -/
private def legacyBodies : List Body := [legacyBody, legacyBodyWithMore]

/-- The bodies that name an engine this deployment does not register. -/
private def unregisteredBodies : List Body :=
  [acpBody, unknownEngineBody, nonStringEngineBody]

/-! ## The refusals -/

/-- A body carrying `provider` and no `engine` is refused as `invalid_body`, whatever the union
would have said about the rest of it. There is no silent acceptance of the old shape. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d1--vocabulary")
  (ts := "apps/web/server/agents/policy.ts#parsePolicyBody")]
theorem legacy_provider_discriminant_is_always_refused :
    (legacyBodies.all fun j =>
      unionVerdicts.all fun accept =>
        parsePolicy defaultRegistered accept j == PolicyVerdict.invalidBody) = true := by decide

/-- The refusal carries `invalid_body` at `400`, not the union's `invalid_policy`: a client on the
old shape is told about the rename rather than handed a list of complaints about a missing key. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/agents.ts#AGENT_POLICY_PROBLEM_CODES")]
theorem legacy_refusal_names_the_rename :
    PolicyVerdict.invalidBody.code = some "invalid_body" ∧
    PolicyVerdict.invalidBody.status = 400 ∧
    PolicyVerdict.invalidBody ≠ PolicyVerdict.invalidPolicy := by decide

/-- An engine this deployment does not register is refused as `unsupported_engine`, whatever the
union would have said. A body whose `engine` is not even a string is refused here too: it names an
engine, and no registry contains it. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d3--what-the-platform-refuses-to-own")
  (ts := "apps/web/server/agents/policy.ts#parsePolicyBody")]
theorem unregistered_engine_is_always_refused :
    (unregisteredBodies.all fun j =>
      unionVerdicts.all fun accept =>
        parsePolicy defaultRegistered accept j == PolicyVerdict.unsupportedEngine) = true := by
  decide

/-- The refusal carries `unsupported_engine` at `400`. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/engines.ts#ENGINE_PROBLEM_CODES")]
theorem unsupported_engine_is_a_four_hundred :
    PolicyVerdict.unsupportedEngine.code = some "unsupported_engine" ∧
    PolicyVerdict.unsupportedEngine.status = 400 := by decide

/-- `unsupported_engine` is a statement about the **registry**, not about the spelling: registering
acp moves the same body off that refusal and onto the union's own verdict. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/engines/registry.ts#registeredEngineIds")]
theorem the_refusal_is_about_the_registry :
    parsePolicy defaultRegistered (fun _ => true) acpBody = PolicyVerdict.unsupportedEngine ∧
    parsePolicy ["claude-agent-sdk", "acp"] (fun _ => true) acpBody = PolicyVerdict.accepted ∧
    parsePolicy ["claude-agent-sdk", "acp"] (fun _ => false) acpBody
      = PolicyVerdict.invalidPolicy := by decide

/-- Naming **both** discriminants is refused too. The engine check passes — `claude-agent-sdk` is
registered — and the union refuses the extra key, so the body reaches `invalid_policy` rather than
being read as either shape. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/agents.ts#AgentPolicySchema")]
theorem naming_both_discriminants_is_refused :
    parsePolicy defaultRegistered (fun _ => false) bothBody = PolicyVerdict.invalidPolicy := by
  decide

/-- The engine this deployment does register reaches the union, and the union's answer is the
parser's answer. Nothing above turns a well-formed Claude policy into a refusal. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/agents/policy.ts#parsePolicyBody")]
theorem a_registered_engine_reaches_the_union :
    parsePolicy defaultRegistered (fun _ => true) claudeBody = PolicyVerdict.accepted ∧
    parsePolicy defaultRegistered (fun _ => false) claudeBody
      = PolicyVerdict.invalidPolicy := by decide

/-- The registry a deployment installs by default is exactly the published catalogue. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/engines/registry.ts#registeredEngines")]
theorem default_registry_is_the_catalogue : defaultRegistered = engineIds := rfl

/-! ## The save-time capability check (ENG-02b)

The second half of ADR-0065 D3's "refuse, never ignore", and the one that is about the *agent* rather
than about the body: an agent whose assigned connectors or skills its engine cannot honour is refused
at save, with `422 engine_capability_unsupported` naming the capability.

Every statement below quantifies over `assignmentCapabilities × assignmentDemands` — all
sixty-four pairs, which is every input {@link unsupportedCapability} reads — so each is decided
rather than argued. -/

/-- The check refuses **exactly** the agents whose connectors, skills or subagents the engine cannot
honour: no refusal precisely when every demanded resource is supported, and a refusal in every
other case. Both directions, which is what rules out a check that is merely conservative. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d3--what-the-platform-refuses-to-own")
  (ts := "apps/web/server/engines/capabilities.ts#unsupportedEngineCapability")]
theorem capability_refusal_is_exact :
    (assignmentCapabilities.all fun cap =>
      assignmentDemands.all fun demand =>
        (unsupportedCapability cap demand).isNone == honoursAssignments cap demand) = true := by
  decide

/-- When it refuses, the capability it names is one the engine really lacks **and** the agent really
demands. A refusal never names a capability that is beside the point. -/
@[aw_spec (tier := T1)
  (ts := "apps/web/server/engines/capabilities.ts#unsupportedEngineCapability")]
theorem a_capability_refusal_names_a_real_gap :
    (assignmentCapabilities.all fun cap =>
      assignmentDemands.all fun demand =>
        match unsupportedCapability cap demand with
        | some CapabilityKey.mcp => demand.connectors && !cap.mcp
        | some CapabilityKey.skills => demand.skills && !cap.skills
        | some CapabilityKey.subagents => demand.subagents && !cap.subagents
        | Option.none => true) = true := by decide

/-- Nothing changes for `claude-agent-sdk`'s assignments. It honours both assignable resources, so
the check never fires for it on connectors or skills, whatever the agent is assigned — which is why
the refusal of an assignment needs a test-only descriptor to be reachable at all. A subagent is a
different matter: like every catalogue engine it declares `subagents: false`, so a demand for one is
refused naming `subagents`, whatever else the agent is assigned. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/engines/registry.ts#registeredEngines")]
theorem claude_agent_sdk_never_refuses_an_assignment :
    (assignmentDemands.all fun demand =>
      saveAgent claudeAssignmentCapabilities demand ==
        if demand.subagents then CapabilityVerdict.unsupported CapabilityKey.subagents
        else CapabilityVerdict.saved) = true := by decide

/-- The refusal travels as `422 engine_capability_unsupported`, and its `details` is exactly the
capability — one published wire string, never prose a client would have to parse. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/engines.ts#ENGINE_PROBLEM_CODES")
  (ts := "packages/contracts/src/engines.ts#ENGINE_CAPABILITY_KEYS")]
theorem engine_capability_unsupported_is_a_four_twenty_two :
    (CapabilityVerdict.unsupported CapabilityKey.mcp).code
        = some "engine_capability_unsupported" ∧
    (CapabilityVerdict.unsupported CapabilityKey.mcp).status = 422 ∧
    (CapabilityVerdict.unsupported CapabilityKey.mcp).details = ["mcp"] ∧
    (CapabilityVerdict.unsupported CapabilityKey.skills).details = ["skills"] ∧
    (CapabilityVerdict.unsupported CapabilityKey.subagents).details = ["subagents"] ∧
    CapabilityVerdict.saved.details = [] := by decide

/-- Every capability a refusal can name is one the published capability set has a field for, so a
`details` entry always points at something an engine descriptor really states. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/engines.ts#ENGINE_CAPABILITY_KEYS")]
theorem a_refusal_only_names_a_published_capability :
    capabilityKeys = ["mcp", "skills", "subagents"] := by decide

/-! ### The refinement of ENG-01's abstract composition

`Concepts/Engine.lean` states D3 over an abstract `compose`: accept only when every portable
requirement is supported, and otherwise refuse naming at least one that is not. The save-time check
is that decision over the three portable concepts an agent can demand at save, so the two must agree
wherever both are defined. -/

/-- The abstract engine whose three demandable concepts are `cap`'s; every other concept is
supported, because no other concept is decided at save time. -/
private def abstractEngine (cap : AssignmentCapabilities) : Concepts.Engine.EngineCapabilities :=
  { engine := Concepts.Engine.Engine.claudeAgentSdk,
    supports := fun c =>
      match c with
      | Concepts.Engine.PortableConcept.connectors => cap.mcp
      | Concepts.Engine.PortableConcept.skills => cap.skills
      | Concepts.Engine.PortableConcept.subagents => cap.subagents
      | _ => true,
    speaks := fun _ => true }

/-- The abstract agent that demands exactly what `demand` says, in the concept order D4 lists. -/
private def abstractAgent (demand : AssignmentDemand) : Concepts.Engine.AgentRequirements :=
  { required :=
      (if demand.connectors then [Concepts.Engine.PortableConcept.connectors] else []) ++
      (if demand.skills then [Concepts.Engine.PortableConcept.skills] else []) ++
      (if demand.subagents then [Concepts.Engine.PortableConcept.subagents] else []),
    connectionProtocol := Concepts.Engine.WireProtocol.anthropicMessages }

/-- The save-time check refines ENG-01's `compose`: it saves exactly when `compose` accepts. So the
concrete refusal is the abstract rule instantiated, not a second rule that happens to resemble it. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d3--what-the-platform-refuses-to-own")
  (ts := "apps/web/server/agents/policy.ts#engineCapabilityRefusal")]
theorem capability_check_refines_compose :
    (assignmentCapabilities.all fun cap =>
      assignmentDemands.all fun demand =>
        (saveAgent cap demand == CapabilityVerdict.saved) ==
          (Concepts.Engine.compose (abstractAgent demand) (abstractEngine cap)
            == Concepts.Engine.ComposeResult.accepted)) = true := by decide

end AgentWorkspace.Theorems.Normative.ContractsEngines
