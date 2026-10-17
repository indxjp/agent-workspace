import AgentWorkspace.Contracts.Engines

namespace AgentWorkspace.Theorems.WellFormed.ContractsEngines

open AgentWorkspace AgentWorkspace.Contracts.Engines

/-! # T0 — the engine contracts are well formed

Every enumeration `packages/contracts/src/engines.ts` publishes decodes back to the member it was
encoded from, every schema accepts exactly what its predicate accepts, and the wire order is the
TypeScript `as const` order rather than any other order that happens to contain the same members.
-/

/-! ## The enumerations -/

/-- `EngineIdSchema` round-trips every member of `ENGINE_IDS`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#EngineIdSchema")]
theorem engine_id_roundtrip (e : EngineId) : WireEnum.ofWire? (WireEnum.toWire e) = some e :=
  WireEnum.ofWire?_toWire e

/-- `WireProtocolSchema` round-trips every member of `WIRE_PROTOCOLS`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#WireProtocolSchema")]
theorem wire_protocol_roundtrip (p : WireProtocol) :
    WireEnum.ofWire? (WireEnum.toWire p) = some p :=
  WireEnum.ofWire?_toWire p

/-- `EngineLimitEnforcementSchema` round-trips every limit-enforcement member. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#EngineLimitEnforcementSchema")]
theorem limit_enforcement_roundtrip (l : LimitEnforcement) :
    WireEnum.ofWire? (WireEnum.toWire l) = some l :=
  WireEnum.ofWire?_toWire l

/-- `EngineBudgetEnforcementSchema` round-trips every budget-enforcement member. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#EngineBudgetEnforcementSchema")]
theorem budget_enforcement_roundtrip (b : BudgetEnforcement) :
    WireEnum.ofWire? (WireEnum.toWire b) = some b :=
  WireEnum.ofWire?_toWire b

/-- The wire order is the `as const` order, member for member. A list with the same members in
another order would satisfy every round-trip above and still break a consumer that reads
`ENGINE_IDS[0]`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#ENGINE_IDS")
  (ts := "packages/contracts/src/engines.ts#WIRE_PROTOCOLS")]
theorem wire_orders_match_the_exports :
    engineIds = ["claude-agent-sdk", "openai-agents", "pi", "mastra"] ∧
    wireProtocols = ["anthropic-messages", "openai-responses", "openai-chat-completions"] ∧
    limitEnforcements = ["native", "adapter"] ∧
    budgetEnforcements = ["native", "adapter", "none"] := by decide

/-- The engine vocabulary and the **model** provider vocabulary share no spelling, so no field can
be read as either. This is the whole reason ADR-0065 gave the engine its own field name. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#ENGINE_IDS")
  (ts := "packages/contracts/src/runs.ts#MODEL_PROVIDERS")]
theorem engine_ids_are_not_model_providers :
    engineIds.all (fun id => !(["anthropic", "anthropic-compatible", "openai", "azure-openai",
      "openai-compatible"].contains id)) = true := by decide

/-! ## The schemas -/

private def capabilities : JValue := .obj
  [("mcp", .bool true), ("skills", .bool true), ("subagents", .bool false), ("resume", .bool true),
   ("fork", .bool false), ("interrupt", .bool true), ("streamingText", .bool false),
   ("reasoning", .bool true),
   ("maxTurns", .str "native"), ("maxBudget", .str "native"),
   ("wireProtocols", .arr [.str "anthropic-messages"])]

private def descriptor : JValue := .obj
  [("id", .str "claude-agent-sdk"), ("displayName", .str "Claude Agent SDK"),
   ("version", .str "0.3.278"), ("capabilities", capabilities), ("installed", .bool true)]

private def replaceField (j : JValue) (name : String) (value : JValue) : JValue :=
  match j with
  | .obj fs => .obj (fs.map fun (key, prior) =>
      if key == name then (key, value) else (key, prior))
  | _ => j

/-- Valid capability sets survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#EngineCapabilitiesSchema")]
theorem capabilities_roundtrip (j : JValue) (h : engineCapabilities j = true) :
    engineCapabilitiesCodec.decode (engineCapabilitiesCodec.encode j) = some j :=
  engineCapabilitiesCodec.decode_encode j h

/-- Valid descriptors survive decoding and encoding unchanged. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#EngineDescriptorSchema")]
theorem descriptor_roundtrip (j : JValue) (h : engineDescriptor j = true) :
    engineDescriptorCodec.decode (engineDescriptorCodec.encode j) = some j :=
  engineDescriptorCodec.decode_encode j h

/-- The capability set is strict: an unknown key is refused rather than dropped. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#EngineCapabilitiesSchema")]
theorem capabilities_refuse_unknown_key :
    engineCapabilities capabilities = true ∧
    engineCapabilities (.obj [("hitl", .bool true)]) = false := by decide

/-- An engine that can reach no gateway ingress is refused: `[]` is not read as "any". -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#EngineCapabilitiesSchema")]
theorem capabilities_require_a_protocol :
    engineCapabilities (replaceField capabilities "wireProtocols" (.arr [])) = false ∧
    engineCapabilities (replaceField capabilities "wireProtocols"
      (.arr [.str "telepathy"])) = false := by decide

/-- `none` is a budget answer only: a turn cap is always enforceable somewhere. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#EngineCapabilitiesSchema")]
theorem max_turns_is_never_unenforceable :
    engineCapabilities (replaceField capabilities "maxBudget" (.str "none")) = true ∧
    engineCapabilities (replaceField capabilities "maxTurns" (.str "none")) = false := by decide

/-- A descriptor refuses an unknown key, an empty display name and an engine outside the
catalogue. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#EngineDescriptorSchema")]
theorem descriptor_is_strict :
    engineDescriptor descriptor = true ∧
    engineDescriptor (replaceField descriptor "displayName" (.str "")) = false ∧
    engineDescriptor (replaceField descriptor "id" (.str "acp")) = false := by decide

/-- `installed` is a stated fact, never an absent one: a descriptor without it is refused rather
than read as installed. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/engines.ts#EngineDescriptorSchema")]
theorem descriptor_requires_installed :
    engineDescriptor (.obj [("id", .str "claude-agent-sdk"),
      ("displayName", .str "Claude Agent SDK"), ("version", .str "0.3.278"),
      ("capabilities", capabilities)]) = false := by decide

end AgentWorkspace.Theorems.WellFormed.ContractsEngines
