import AgentWorkspace.Behaviour.EnginePort

/-!
# T1 — the protocol check is sound (ENG-04, #303)

Compose accepts a run **exactly when** the gateway serves one of the engine's wire protocols for
the model connection's provider, and otherwise answers `engine_model_protocol_unsupported`. The
theorems below are the two directions of that sentence plus the two facts that make it usable:
the resolved protocol is one both sides really offer, and the answer is the engine's preference
rather than the gateway's.
-/

namespace AgentWorkspace.Theorems.Normative.EnginePort

open AgentWorkspace.Behaviour.EnginePort

/-- Compose accepts a pair exactly when some protocol is in both lists. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/building/extending-the-platform.mdx#the-protocol-check")
  (ts := "apps/web/server/engines/protocol.ts#resolveWireProtocol")]
theorem compose_accepts_iff_overlap (engineProtocols : List String) (provider : String) :
    composeAccepts engineProtocols provider = true ↔
      ∃ p ∈ engineProtocols, p ∈ gatewayProtocolsFor provider := by
  simp [composeAccepts, resolveWireProtocol, List.find?_isSome]

/-- A resolved protocol is one the **engine** declared. Not implied by the acceptance above: a
resolver that answered with the gateway's first dialect would satisfy it and would compose a run
on a protocol the engine cannot speak. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/engines/protocol.ts#resolveWireProtocol")]
theorem resolved_protocol_is_the_engines (engineProtocols : List String) (provider p : String)
    (h : resolveWireProtocol engineProtocols provider = some p) : p ∈ engineProtocols := by
  exact List.mem_of_find?_eq_some h

/-- A resolved protocol is one the **gateway** serves for that provider. The other half: together
the two say the answer lies in the intersection, which is what "servable" means. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/engines/protocol.ts#resolveWireProtocol")]
theorem resolved_protocol_is_served (engineProtocols : List String) (provider p : String)
    (h : resolveWireProtocol engineProtocols provider = some p) :
    p ∈ gatewayProtocolsFor provider := by
  have := List.find?_some h
  simpa using this

/-- The refusal arm: no overlap, no run. `engine_model_protocol_unsupported` is the only answer,
because a run composed anyway would fail at its first model call with a provider error. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/compose/run-request.ts#buildRunRequestFor")]
theorem no_overlap_is_refused (engineProtocols : List String) (provider : String)
    (h : ∀ p ∈ engineProtocols, p ∉ gatewayProtocolsFor provider) :
    composeAccepts engineProtocols provider = false := by
  simp only [composeAccepts, Option.isSome_eq_false_iff, Option.isNone_iff_eq_none]
  simp only [resolveWireProtocol, List.find?_eq_none]
  intro p hp
  simpa using h p hp

/-- The positive witness: today's only engine reaches today's every provider, because every
provider answers the gateway's own Anthropic Messages shape. -/
@[aw_spec (tier := T1) (ts := "packages/engine-claude-agent-sdk/src/engine.ts#CLAUDE_AGENT_SDK_CAPABILITIES")]
theorem claude_reaches_every_provider :
    composeAccepts claudeAgentSdkCapabilities.wireProtocols "anthropic" = true ∧
    composeAccepts claudeAgentSdkCapabilities.wireProtocols "openai" = true ∧
    composeAccepts claudeAgentSdkCapabilities.wireProtocols "azure-openai" = true ∧
    composeAccepts claudeAgentSdkCapabilities.wireProtocols "openai-compatible" = true := by
  decide

/-- The negative witness, which is the case the check exists for: a Responses-only engine pointed
at an Anthropic connection the gateway will not forward an OpenAI body to. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/engines/protocol.ts#resolveWireProtocol")]
theorem responses_only_engine_cannot_reach_anthropic :
    composeAccepts ["openai-responses"] "anthropic" = false := by decide

end AgentWorkspace.Theorems.Normative.EnginePort
