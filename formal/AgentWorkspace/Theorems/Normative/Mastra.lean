import AgentWorkspace.Behaviour.Engines.Mastra

/-!
# T1 — the Mastra adapter honours the portable core or refuses it by name (ENG-10, #309)

ADR-0065 D3's refuse-never-ignore, refined for this engine. For every agent `compile` accepts:

* it offers exactly the workspace tools the four permission switches allow — with the command
  tools withheld while a read-only grant exists — and network egress exactly when
  `unrestrictedNetwork` allows it, and the skill tools exactly when a skill is granted;
* it hands `MCPClient` exactly the connectors the request carries, in order;
* semantic recall, working memory and title generation are off.

And for every unsupported portable requirement it reaches, `compile` refuses with a code and the
name of the capability — never a narrower run, with one documented exception: under a read-only
grant the command tools are withheld rather than the run refused, as on the `openai-agents` and
`pi` arms, because a subprocess's writes never pass the filesystem wrapper
(`docs/formal/units/engine-mastra.md#tools`).
-/

namespace AgentWorkspace.Theorems.Normative.Mastra

open AgentWorkspace AgentWorkspace.Authz.PathGrant AgentWorkspace.Behaviour.Engines.Mastra

/-! ## The tools -/

/-- An accepted agent offers exactly the workspace tools the four permission switches allow, with
the command tools withheld while a read-only grant exists, and is given network egress exactly when
`unrestrictedNetwork` allows it. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-mastra.md#tools")
  (ts := "packages/engine-mastra/src/tools.ts#mastraToolPlan")
  (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")]
theorem accepted_agent_offers_exactly_the_permitted_tools {r : Request} {c : Compiled}
    (h : compile r = .ok c) (t : Tool) :
    (t ∈ c.tools ↔
      (t.permitted r.permissions = true ∧
        ¬(t.isCommand = true ∧ c.grants.any (·.readOnly) = true))) ∧
      c.networkEgress = r.permissions.unrestrictedNetwork := by
  obtain ⟨grants, _, _, _, _, _, _, _, _, _, _, _, _, _, rfl⟩ := compile_ok_shape h
  refine ⟨?_, rfl⟩
  simp only [compileWith, toolPlan, List.mem_filter, Tool.all_complete, true_and,
    Bool.and_eq_true, Bool.not_eq_true', Bool.and_eq_false_iff]
  constructor
  · rintro ⟨hp, hs⟩
    refine ⟨hp, ?_⟩
    rintro ⟨hc, hro⟩
    cases hs with
    | inl hne => simp [hc] at hne
    | inr hno => simp [hro] at hno
  · rintro ⟨hp, hs⟩
    refine ⟨hp, ?_⟩
    cases hc : t.isCommand
    · left; rfl
    · right
      cases hro : grants.any (·.readOnly)
      · rfl
      · exact absurd ⟨hc, hro⟩ hs

/-- An accepted agent is offered the skill tools exactly when it is granted a skill, and hands
`MCPClient` exactly the connectors the request carries. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-mastra.md#tools")
  (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")]
theorem skills_and_connectors_are_honoured {r : Request} {c : Compiled} (h : compile r = .ok c) :
    c.skillTools = !(skillSet r.skills).isEmpty ∧
      compileConnectors r.connectors = .ok c.connectors := by
  obtain ⟨grants, b, t, _, p, names, tid, _, _, _, _, _, hn, _, rfl⟩ := compile_ok_shape h
  exact ⟨rfl, hn⟩

/-- Witness: an agent allowed to read and run commands, with no grant, gets the four readers and
the three command tools; a read-only grant withholds the command tools. -/
example :
    let base : Request :=
      { cwd := "/workspace/", sessionId := "s1", projectKey := "tenant", policyReadable := true,
        permissions :=
          { readFiles := true, writeFiles := false, runCommands := true,
            unrestrictedNetwork := false },
        model := some "claude-sonnet-4-5", skills := [], session := .fresh, maxTurns := some 2,
        budgetCap := false, gateway := some ("http://gw", "tok", "anthropic-messages"),
        environmentClean := true, envNames := [], grants := [], connectors := [] }
    (match compile base with
      | .ok c => c.tools
      | .refused _ => []) =
        [.readFile, .listFiles, .grep, .fileStat, .executeCommand, .getProcessOutput,
         .killProcess] ∧
      (match compile { base with grants := [(false, "contract.pdf", true)] } with
        | .ok c => c.tools
        | .refused _ => []) = [.readFile, .listFiles, .grep, .fileStat] := by
  decide

/-! ## Memory features that would call a model outside the run's connection are off -/

/-- Every accepted agent runs with semantic recall, working memory and title generation off, on
the platform's own thread and the tenant's namespace. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-mastra.md#memory")
  (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
theorem semantic_recall_and_working_memory_are_off {r : Request} {c : Compiled}
    (h : compile r = .ok c) :
    c.memory.semanticRecall = false ∧ c.memory.workingMemory = false ∧
      c.memory.generateTitle = false ∧ c.memory.resourceId = r.projectKey ∧
      threadOf r = some c.memory.threadId := by
  obtain ⟨grants, b, t, _, p, names, tid, _, _, _, _, _, _, ht, rfl⟩ := compile_ok_shape h
  exact ⟨rfl, rfl, rfl, rfl, ht⟩

/-! ## Every unsupported requirement is refused by name -/

/-- The checks every refusal theorem below assumes have passed. -/
private theorem compile_reaches_budget {r : Request} {grants : List Grant} {b t w : String}
    {p : Behaviour.Engines.OpenAiAgents.Protocol}
    (hpol : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hgw : r.gateway = some (b, t, w)) (hp : Behaviour.Engines.OpenAiAgents.Protocol.ofWire? w = some p)
    (he : r.environmentClean = true) (hd : databaseEnvClean r.envNames = true) :
    compile r =
      if r.budgetCap && !priced (modelOf r p) then
        .refused (.capabilityUnsupported "maxBudget")
      else match compileConnectors r.connectors with
      | .error e => .refused e
      | .ok names =>
        match threadOf r with
        | none => .refused (.capabilityUnsupported "fork")
        | some threadId => .ok (compileWith r grants b t p names threadId) := by
  unfold compile
  simp only [hpol, hg, hgw, hp, he, hd, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
  cases compileConnectors r.connectors <;> cases threadOf r <;> rfl

/-- A fork is refused `engine_capability_unsupported` naming `fork`: a Mastra thread is continued,
never branched, and a fork is not run as a fresh thread in its place. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-mastra.md#compile")
  (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")]
theorem a_fork_is_refused_by_name {r : Request} {grants : List Grant} {b t w : String}
    {p : Behaviour.Engines.OpenAiAgents.Protocol} {names : List String} {parent : String}
    (hpol : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hgw : r.gateway = some (b, t, w)) (hp : Behaviour.Engines.OpenAiAgents.Protocol.ofWire? w = some p)
    (he : r.environmentClean = true) (hd : databaseEnvClean r.envNames = true)
    (hb : r.budgetCap = false) (hn : compileConnectors r.connectors = .ok names)
    (hf : r.session = .fork parent) :
    compile r = .refused (.capabilityUnsupported "fork") := by
  rw [compile_reaches_budget hpol hg hgw hp he hd]
  simp [hb, hn, threadOf, hf]

/-- A per-run budget cap the provisional price table cannot price is refused naming `maxBudget`
(ADR-0074 D7, shared by ADR-0084). -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-mastra.md#compile")
  (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")
  (ts := "packages/engine/src/prices.ts#provisionalPriceFor")]
theorem an_unpriced_budget_cap_is_refused_by_name {r : Request} {grants : List Grant}
    {b t w : String} {p : Behaviour.Engines.OpenAiAgents.Protocol}
    (hpol : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hgw : r.gateway = some (b, t, w)) (hp : Behaviour.Engines.OpenAiAgents.Protocol.ofWire? w = some p)
    (he : r.environmentClean = true) (hd : databaseEnvClean r.envNames = true)
    (hb : r.budgetCap = true) (hpr : priced (modelOf r p) = false) :
    compile r = .refused (.capabilityUnsupported "maxBudget") := by
  rw [compile_reaches_budget hpol hg hgw hp he hd]
  simp [hb, hpr]

/-- A connection served over a dialect the adapter does not speak is refused naming
`wireProtocols`. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-mastra.md#compile")
  (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")]
theorem an_unspoken_protocol_is_refused_by_name {r : Request} {grants : List Grant}
    {b t w : String}
    (hpol : r.policyReadable = true)
    (hg : normaliseGrants (some protectedDirectory) r.grants = some grants)
    (hgw : r.gateway = some (b, t, w))
    (hw : Behaviour.Engines.OpenAiAgents.Protocol.ofWire? w = none) :
    compile r = .refused (.capabilityUnsupported "wireProtocols") := by
  unfold compile
  simp [hpol, hg, hgw, hw]

/-- A connector tool whose policy asks for a human approval is refused naming `approvals`: the
engine runs no approvals (ADR-0065 D9), so the tool is never offered on other terms. -/
@[aw_spec (tier := T1) (doc := "docs/formal/units/engine-mastra.md#compile")
  (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")]
theorem an_approval_is_refused_by_name (c : Connector) (rest : List Connector)
    (hr : c.readable = true) (ha : c.asksApproval = true) :
    compileConnectors (c :: rest) = .error (.capabilityUnsupported "approvals") := by
  simp [compileConnectors, hr, ha]

/-- Witness for the refusal theorems: a fork, an unpriced cap, an unknown dialect, a missing
gateway, a database variable and an approval each refuse by name, and every protocol the adapter
advertises compiles. -/
example :
    let base : Request :=
      { cwd := "/workspace/", sessionId := "s1", projectKey := "tenant", policyReadable := true,
        permissions :=
          { readFiles := true, writeFiles := true, runCommands := true,
            unrestrictedNetwork := true },
        model := none, skills := ["writer"], session := .fresh, maxTurns := none,
        budgetCap := false, gateway := some ("http://gw", "tok", "anthropic-messages"),
        environmentClean := true, envNames := [], grants := [], connectors := [] }
    compile { base with session := .fork "parent" } =
        .refused (.capabilityUnsupported "fork") ∧
      compile { base with budgetCap := true, model := some "unpriced" } =
        .refused (.capabilityUnsupported "maxBudget") ∧
      compile { base with gateway := some ("http://gw", "tok", "gemini") } =
        .refused (.capabilityUnsupported "wireProtocols") ∧
      compile { base with gateway := none } = .refused (.credentialRefused "gateway") ∧
      compile { base with envNames := ["HOME", "PGPASSWORD"] } =
        .refused (.credentialRefused "database") ∧
      compile { base with connectors := [⟨"docs", true, true⟩] } =
        .refused (.capabilityUnsupported "approvals") ∧
      (engineProtocols.all fun w =>
        match compile { base with gateway := some ("http://gw", "tok", w) } with
        | .ok _ => true
        | .refused _ => false) = true := by
  decide

end AgentWorkspace.Theorems.Normative.Mastra
