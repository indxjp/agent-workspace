import AgentWorkspace.Behaviour.Engines.Pi

/-!
# T1 — the pi adapter honours the portable core or refuses it by name (ENG-08, #307)

ADR-0065 D3's refuse-never-ignore, refined for this engine. For every agent `compile` accepts:

* it offers exactly the tools the four permission switches allow — with `bash` withheld while a
  read-only grant exists, the one narrowing the plan documents;
* its `beforeToolCall` guard blocks `bash` whenever `runCommands` is off;
* it carries no connector: pi has no MCP client, so a connector is always refused by name.

And for every unsupported portable requirement it reaches, `compile` refuses with a code and the
name of the capability — never a narrower run.
-/

namespace AgentWorkspace.Theorems.Normative.Pi

open AgentWorkspace AgentWorkspace.Authz.PathGrant AgentWorkspace.Behaviour.Engines.Pi

/-! ## The tools -/

/-- An accepted agent offers exactly the tools the four permission switches allow, with `bash`
withheld while a read-only grant exists. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-pi.md#tools")
  (ts := "packages/engine-pi/src/tools.ts#piToolPlan")
  (ts := "packages/engine-pi/src/compile.ts#compilePiRun")]
theorem accepted_agent_offers_exactly_the_permitted_tools {r : Request} {c : Compiled}
    (h : compile r = .ok c) (t : Tool) :
    t ∈ c.tools ↔
      (t.permitted r.permissions = true ∧ ¬(t = .bash ∧ c.grants.any (·.readOnly) = true)) := by
  obtain ⟨grants, _, _, _, _, _, rfl⟩ := compile_ok_shape h
  simp only [compileWith, toolPlan, List.mem_filter, Tool.all_complete, true_and,
    Bool.and_eq_true, Bool.not_eq_true', Bool.and_eq_false_iff]
  constructor
  · rintro ⟨hp, hs⟩
    refine ⟨hp, ?_⟩
    rintro ⟨rfl, hro⟩
    cases hs with
    | inl hne => simp at hne
    | inr hno => simp [hro] at hno
  · rintro ⟨hp, hs⟩
    refine ⟨hp, ?_⟩
    by_cases ht : t = .bash
    · subst ht
      right
      cases hro : grants.any (·.readOnly)
      · rfl
      · exact absurd ⟨rfl, hro⟩ hs
    · left
      simpa using ht

/-- Witness: an agent allowed to read and run commands, with no grant, gets `read` and `bash`,
and neither `write` nor `edit`. -/
example :
    (compile
      { cwd := "/workspace/", policyReadable := true,
        permissions :=
          { readFiles := true, writeFiles := false, runCommands := true,
            unrestrictedNetwork := false },
        model := some "claude-sonnet-4-5", skills := [], session := .fresh,
        forksIntoItself := false, maxTurns := some 2, budgetCap := false,
        gateway := some ("http://gw", "tok", "anthropic-messages"), environmentClean := true,
        grants := [], connectors := [] }) =
      .ok { cwd := "/workspace", tools := [.read, .bash], networkEgress := false,
            connection := connectionFor "http://gw" "tok", model := "claude-sonnet-4-5",
            maxTurns := some 2, budgetCap := false, grants := [], skills := [] } := by
    decide

/-! ## `beforeToolCall` blocks bash whenever `runCommands` is off -/

/-- Whenever the agent's `runCommands` switch is off, the compiled guard blocks every `bash` call,
whatever it asks for: pi is never told about the tool, and a call the model invents is blocked. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-pi.md#tools")
  (ts := "packages/engine-pi/src/workspace.ts#piToolCallVerdict")
  (ts := "packages/engine-pi/src/boundary.ts#startPiRun")]
theorem the_guard_blocks_bash_when_run_commands_is_off {r : Request} {c : Compiled}
    (h : compile r = .ok c) (hr : r.permissions.runCommands = false) (path : Option String) :
    guard c "bash" path = false := by
  obtain ⟨grants, b, tk, _, _, _, rfl⟩ := compile_ok_shape h
  have hnone :
      (compileWith r grants b tk).tools.find? (fun t => t.name == "bash") = none := by
    rw [List.find?_eq_none]
    intro x hx
    simp only [compileWith, toolPlan, List.mem_filter] at hx
    cases x <;> simp_all [Tool.name, Tool.permitted]
  simp [Behaviour.Engines.Pi.guard, hnone]

/-- Witness: with `runCommands` off the guard blocks `bash`, and with it on (and no read-only
grant) it lets `bash` through. -/
example :
    let base : Request :=
      { cwd := "/workspace/", policyReadable := true,
        permissions :=
          { readFiles := true, writeFiles := true, runCommands := false,
            unrestrictedNetwork := false },
        model := none, skills := [], session := .fresh, forksIntoItself := false,
        maxTurns := none, budgetCap := false,
        gateway := some ("http://gw", "tok", "anthropic-messages"), environmentClean := true,
        grants := [], connectors := [] }
    (match compile base with
      | .ok c => guard c "bash" none
      | .refused _ => true) = false ∧
      (match compile { base with permissions := { base.permissions with runCommands := true } } with
        | .ok c => guard c "bash" none
        | .refused _ => false) = true := by decide

/-! ## MCP is always refused -/

/-- An accepted compile carries no connector: pi has no MCP client, so no agent with a connector is
ever run on it. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-pi.md#compile")
  (ts := "packages/engine-pi/src/compile.ts#compilePiRun")]
theorem no_accepted_agent_has_a_connector {r : Request} {c : Compiled} (h : compile r = .ok c) :
    r.connectors = [] := by
  obtain ⟨_, _, _, _, _, hc, _⟩ := compile_ok_shape h
  exact hc

/-- A connector is refused `engine_capability_unsupported` naming `mcp` on a request whose policy
and grants read, never dropped and never bridged. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-pi.md#compile")
  (ts := "packages/engine-pi/src/compile.ts#compilePiRun")]
theorem a_connector_is_refused_by_name {r : Request} {grants : List Grant}
    (hp : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hc : r.connectors ≠ []) :
    compile r = .refused (.capabilityUnsupported "mcp") := by
  cases hcs : r.connectors with
  | nil => exact absurd hcs hc
  | cons x xs => simp [compile, hp, hg, hcs]

/-! ## Every other unsupported requirement is refused by name -/

/-- A per-run budget cap the provisional price table cannot price is refused naming `maxBudget`: a
cap that could never stop the run is not accepted (ADR-0074 D7, shared by ADR-0081). -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-pi.md#compile")
  (ts := "packages/engine-pi/src/compile.ts#compilePiRun")
  (ts := "packages/engine/src/prices.ts#provisionalPriceFor")]
theorem an_unpriced_budget_cap_is_refused_by_name {r : Request} {grants : List Grant}
    (hp : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hc : r.connectors = []) (hb : r.budgetCap = true) (hpr : priced (modelOf r) = false) :
    compile r = .refused (.capabilityUnsupported "maxBudget") := by
  unfold compile
  simp [hp, hg, hc, hb, hpr]

/-- A connection served over any dialect but Anthropic Messages is refused naming
`wireProtocols`. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-pi.md#compile")
  (ts := "packages/engine-pi/src/compile.ts#compilePiRun")]
theorem an_unspoken_protocol_is_refused_by_name {r : Request} {grants : List Grant}
    {b t w : String}
    (hp : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hc : r.connectors = []) (hb : r.budgetCap = false)
    (hgw : r.gateway = some (b, t, w)) (hw : w ≠ "anthropic-messages") :
    compile r = .refused (.capabilityUnsupported "wireProtocols") := by
  unfold compile
  simp [hp, hg, hc, hb, hgw, hw]

/-- Witness for the refusal theorems: a connector, an unpriced cap, an OpenAI dialect and a missing
gateway are each refused by name on otherwise acceptable requests, and a cap on a priced model
compiles. -/
example :
    let base : Request :=
      { cwd := "/workspace/", policyReadable := true,
        permissions :=
          { readFiles := true, writeFiles := true, runCommands := true,
            unrestrictedNetwork := true },
        model := none, skills := ["writer"], session := .fresh, forksIntoItself := false,
        maxTurns := none, budgetCap := false,
        gateway := some ("http://gw", "tok", "anthropic-messages"), environmentClean := true,
        grants := [], connectors := [] }
    compile { base with connectors := ["docs"] } = .refused (.capabilityUnsupported "mcp") ∧
      compile { base with budgetCap := true } = .refused (.capabilityUnsupported "maxBudget") ∧
      (match compile { base with budgetCap := true, model := some "claude-sonnet-4-5" } with
        | .ok c => c.budgetCap
        | .refused _ => false) = true ∧
      compile { base with gateway := some ("http://gw", "tok", "openai-responses") } =
        .refused (.capabilityUnsupported "wireProtocols") ∧
      compile { base with gateway := none } = .refused (.credentialRefused "gateway") := by
  decide

end AgentWorkspace.Theorems.Normative.Pi
