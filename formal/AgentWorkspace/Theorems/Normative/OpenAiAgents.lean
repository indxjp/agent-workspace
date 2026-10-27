import AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-!
# T1 — the OpenAI Agents adapter honours the portable core or refuses it by name (ENG-09, #308)

ADR-0065 D3's refuse-never-ignore, refined for this engine. For every agent `compile` accepts:

* it offers exactly the tools the four permission switches allow — with `shell` withheld while a
  read-only grant exists, the one narrowing the plan documents;
* it offers no vendor-hosted tool: every compiled tool is a function tool, which the gateway's
  closed allowlist relays;
* the protocol follows the connection: compose resolves an OpenAI-family connection to the
  Responses dialect and an Anthropic-family one to Messages, and the compiled client follows the
  protocol.

And for every unsupported portable requirement it reaches, `compile` refuses with a code and the
name of the capability — never a narrower run.
-/

namespace AgentWorkspace.Theorems.Normative.OpenAiAgents

open AgentWorkspace AgentWorkspace.Authz.PathGrant AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-! ## The tools -/

/-- An accepted agent offers exactly the tools the four permission switches allow, with `shell`
withheld while a read-only grant exists. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#tools")
  (ts := "packages/engine-openai-agents/src/tools.ts#openAiAgentsToolPlan")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
theorem accepted_agent_offers_exactly_the_permitted_tools {r : Request} {c : Compiled}
    (h : compile r = .ok c) (t : Tool) :
    t ∈ c.tools ↔
      (t.permitted r.permissions = true ∧ ¬(t = .shell ∧ c.grants.any (·.readOnly) = true)) := by
  obtain ⟨grants, _, _, _, _, _, _, _, htools, hgrants, _⟩ := compile_ok_shape h
  rw [htools, hgrants]
  simp only [toolPlan, List.mem_filter, Tool.all_complete, true_and, Bool.and_eq_true,
    Bool.not_eq_true', Bool.and_eq_false_iff]
  constructor
  · rintro ⟨hp, hs⟩
    refine ⟨hp, ?_⟩
    rintro ⟨rfl, hro⟩
    cases hs with
    | inl hne => simp at hne
    | inr hno => simp [hro] at hno
  · rintro ⟨hp, hs⟩
    refine ⟨hp, ?_⟩
    by_cases ht : t = .shell
    · subst ht
      right
      cases hro : grants.any (·.readOnly)
      · rfl
      · exact absurd ⟨rfl, hro⟩ hs
    · left
      simpa using ht

/-- Witness: an agent allowed to read and run commands, with no grant, gets the three read tools
and `shell`, and no `apply_patch`. -/
example :
    (compile
      { policyReadable := true,
        permissions :=
          { readFiles := true, writeFiles := false, runCommands := true,
            unrestrictedNetwork := false },
        model := none, skills := [], session := .fresh, maxTurns := some 2, budgetCap := false,
        gateway := some ("http://gw", "tok", "openai-responses"), environmentClean := true,
        grants := [], connectors := [] }) =
      .ok { tools := [.readFile, .listFiles, .searchFiles, .shell], networkEgress := false,
            connection := connectionFor .openaiResponses "http://gw" "tok", connectors := [],
            maxTurns := some 2, budgetCap := false, grants := [], tracingDisabled := true } := by
    decide +kernel

/-- No compiled tool is vendor-hosted: every one is sent as a function tool, which the gateway's
closed hosted-tool allowlist relays. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#tools")
  (ts := "packages/engine-openai-agents/src/boundary.ts#startOpenAiAgentsRun")
  (ts := "packages/gateway/src/providers/passthrough.ts#unrelayableToolType")]
theorem no_vendor_hosted_tool_is_compiled {r : Request} {c : Compiled} (_h : compile r = .ok c) :
    ∀ t ∈ c.tools, t.wireType = .function ∧ t.wireType.isRelayable = true := by
  intro t _
  cases t <;> exact ⟨rfl, rfl⟩

/-- Why the tools are function tools: the SDK's own `shell` tool type is one the gateway refuses
as hosted, so an adapter that compiled it could not reach its model through the gateway. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#tools")
  (ts := "packages/contracts/src/agents.ts#OPENAI_AGENTS_TOOL_NAMES")]
theorem the_sdk_shell_tool_type_is_not_relayed :
    Behaviour.GatewayIngress.ToolType.shell.isRelayable = false := by decide +kernel

/-! ## The protocol follows the connection -/

/-- Compose resolves an OpenAI-family connection to the Responses dialect and an Anthropic-family
one to Messages for this engine, and the compiled client follows the protocol: `OpenAIProvider`
for the two OpenAI dialects, `aisdk()` for Messages. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#compile")
  (ts := "apps/web/server/engines/protocol.ts#resolveWireProtocol")
  (ts := "packages/engine-openai-agents/src/compile.ts#openAiAgentsModelConnection")]
theorem the_protocol_follows_the_connection :
    (["openai", "azure-openai", "openai-compatible"].all fun provider =>
        Behaviour.EnginePort.resolveWireProtocol engineProtocols provider ==
          some "openai-responses") = true ∧
      (["anthropic", "anthropic-compatible"].all fun provider =>
        Behaviour.EnginePort.resolveWireProtocol engineProtocols provider ==
          some "anthropic-messages") = true ∧
      clientFor .openaiResponses = .openai ∧ clientFor .openaiChatCompletions = .openai ∧
      clientFor .anthropicMessages = .aisdkAnthropic := by decide +kernel

/-- An accepted compile speaks exactly the protocol the gateway connection names, through the
client that protocol selects. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#compile")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
theorem compiled_protocol_is_the_gateway_protocol {r : Request} {c : Compiled}
    (h : compile r = .ok c) :
    ∃ b t w, r.gateway = some (b, t, w) ∧ c.connection.protocol.toWire = w ∧
      c.connection.client = clientFor c.connection.protocol := by
  obtain ⟨_, b, t, w, p, _, hgw, hp, _, _, _, hconn, _⟩ := compile_ok_shape h
  refine ⟨b, t, w, hgw, ?_, ?_⟩
  · rw [hconn]
    simp only [connectionFor]
    unfold Protocol.ofWire? at hp
    have := List.find?_some hp
    simpa using this
  · rw [hconn]
    rfl

/-! ## Every unsupported requirement is refused by name -/

/-- A granted skill is refused `engine_capability_unsupported` naming `skills` (the engine
declares `skills: false`), never dropped. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#compile")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
theorem a_granted_skill_is_refused_by_name {r : Request} {grants : List Grant}
    (hp : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hs : r.skills ≠ []) :
    compile r = .refused (.capabilityUnsupported "skills") := by
  unfold compile
  simp [hp, hg, hs]

/-- A fork is refused naming `fork`. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#compile")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
theorem a_fork_is_refused_by_name {r : Request} {grants : List Grant}
    (hp : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hs : r.skills = []) (hf : r.session = .fork) :
    compile r = .refused (.capabilityUnsupported "fork") := by
  unfold compile
  simp [hp, hg, hs, hf]

/-- A per-run budget cap the provisional price table cannot price — an unlisted model, or none
named — is refused naming `maxBudget`: a cap that could never stop the run is not accepted
(ADR-0074 D7). -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#compile")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
theorem an_unpriced_budget_cap_is_refused_by_name {r : Request} {grants : List Grant}
    (hp : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hs : r.skills = []) (hf : r.session ≠ .fork) (hb : r.budgetCap = true)
    (hpr : priced r.model = false) :
    compile r = .refused (.capabilityUnsupported "maxBudget") := by
  unfold compile
  simp [hp, hg, hs, hf, hb, hpr]

/-- Every accepted compile carries the request's cap into the configuration the boundary enforces
it from, and a cap is only ever accepted on a model the provisional table prices: the cap is
neither dropped nor accepted unenforceable (ADR-0074 D7). -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#compile")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
theorem an_accepted_budget_cap_is_priced_and_compiled {r : Request} {c : Compiled}
    (h : compile r = .ok c) :
    c.budgetCap = r.budgetCap ∧ (r.budgetCap = true → priced r.model = true) := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, _, _, hbc⟩ := compile_ok_shape h
  refine ⟨hbc, fun hb => ?_⟩
  cases hpr : priced r.model
  · exfalso
    unfold compile at h
    split at h
    · cases h
    · split at h
      · cases h
      · split at h
        · cases h
        · split at h
          · cases h
          · simp [hb, hpr] at h
  · rfl

/-- A protocol the engine does not speak is refused naming `wireProtocols`. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#compile")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
theorem an_unspoken_protocol_is_refused_by_name {r : Request} {grants : List Grant}
    {b t w : String}
    (hp : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hs : r.skills = []) (hf : r.session ≠ .fork) (hb : r.budgetCap = false)
    (hgw : r.gateway = some (b, t, w)) (hw : Protocol.ofWire? w = none) :
    compile r = .refused (.capabilityUnsupported "wireProtocols") := by
  unfold compile
  simp [hp, hg, hs, hf, hb, hgw, hw]

/-- An Anthropic-family connection with no model named is refused naming `model`: the AI SDK
adapter has no default model, and the adapter does not invent one. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#compile")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
theorem anthropic_without_a_model_is_refused_by_name {r : Request} {grants : List Grant}
    {b t : String}
    (hp : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hs : r.skills = []) (hf : r.session ≠ .fork) (hb : r.budgetCap = false)
    (hgw : r.gateway = some (b, t, "anthropic-messages")) (hm : r.model = none) :
    compile r = .refused (.capabilityUnsupported "model") := by
  unfold compile
  simp [hp, hg, hs, hf, hb, hgw, hm]
  rfl

/-- A connector whose tool asks for a human approval is refused naming `approvals`; it is not
silently left out. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#compile")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
theorem an_unhonourable_connector_is_refused_by_name (c : Connector) (rest : List Connector)
    (ha : c.asksApproval = true) :
    compileConnectors (c :: rest) = .error (.capabilityUnsupported "approvals") := by
  simp [compileConnectors, ha]

/-- Remote MCP parity with the Claude engine (Owner decision on #308, ADR-0074 D2): a connector
that asks for no approval is compiled whether it is remote or stdio, so `unrestrictedNetwork` off
never removes an assigned remote connector. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-openai-agents.md#compile")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
theorem a_remote_connector_needs_no_network_switch (c : Connector) (rest : List Connector)
    (ha : c.asksApproval = false) :
    compileConnectors (c :: rest) = (compileConnectors rest).map (c.name :: ·) := by
  simp [compileConnectors, ha]

/-- Witness for the refusal theorems: a skill, a fork, an unpriced cap and an unknown protocol are
each refused by name on otherwise acceptable requests, and a cap on a priced model compiles. -/
example :
    let base : Request :=
      { policyReadable := true,
        permissions :=
          { readFiles := true, writeFiles := true, runCommands := true,
            unrestrictedNetwork := true },
        model := none, skills := [], session := .fresh, maxTurns := none, budgetCap := false,
        gateway := some ("http://gw", "tok", "openai-responses"), environmentClean := true,
        grants := [], connectors := [] }
    compile { base with skills := ["support"] } = .refused (.capabilityUnsupported "skills") ∧
      compile { base with session := .fork } = .refused (.capabilityUnsupported "fork") ∧
      compile { base with budgetCap := true } = .refused (.capabilityUnsupported "maxBudget") ∧
      compile { base with budgetCap := true, model := some "gpt-unlisted" } =
        .refused (.capabilityUnsupported "maxBudget") ∧
      (match compile { base with budgetCap := true, model := some "gpt-5" } with
        | .ok c => c.budgetCap
        | .refused _ => false) = true ∧
      compile { base with gateway := some ("http://gw", "tok", "gemini") } =
        .refused (.capabilityUnsupported "wireProtocols") ∧
      compile { base with gateway := some ("http://gw", "tok", "anthropic-messages") } =
        .refused (.capabilityUnsupported "model") := by decide +kernel

end AgentWorkspace.Theorems.Normative.OpenAiAgents
