import AgentWorkspace.Concepts.Engine

namespace AgentWorkspace.Theorems.Normative.Engine

open AgentWorkspace AgentWorkspace.Concepts.Engine

/-! ## Refuse, never ignore (ADR-0065 D3 and D4) -/

/-- Composing an agent with an engine either accepts with every portable requirement honoured, or
refuses naming at least one requirement the engine does not support; it never accepts while
dropping one. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d3--what-the-platform-refuses-to-own")
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d4--the-portable-core-every-engine-honours")
  (ts := "packages/contracts/src/agents.ts#AgentPolicySchema")]
theorem compose_refuses_rather_than_dropping_a_requirement
    (need : AgentRequirements) (cap : EngineCapabilities) :
    (compose need cap = .accepted ∧ ∀ c ∈ need.required, cap.supports c = true) ∨
      (∃ missing, compose need cap = .refused missing ∧
        ∃ c, c ∈ missing ∧ c ∈ need.required ∧ cap.supports c = false) := by
  unfold compose
  cases hu : unsupported need cap with
  | nil =>
    refine Or.inl ⟨rfl, ?_⟩
    intro c hc
    cases hs : cap.supports c with
    | true => rfl
    | false =>
      have hmem : c ∈ unsupported need cap :=
        List.mem_filter.mpr ⟨hc, by simp [hs]⟩
      rw [hu] at hmem
      simp at hmem
  | cons c rest =>
    refine Or.inr ⟨c :: rest, rfl, c, by simp, ?_⟩
    have hmem : c ∈ unsupported need cap := by rw [hu]; simp
    have hfilter := List.mem_filter.mp hmem
    exact ⟨hfilter.1, by simpa using hfilter.2⟩

/-- Witness: an engine without MCP refuses an agent that uses connectors, naming `connectors`,
while the same engine accepts the same agent without them. -/
private def piLike : EngineCapabilities :=
  { engine := .pi
    supports := fun c => c != .connectors
    speaks := fun p => p == .anthropicMessages }

example :
    compose ⟨[.instructions, .connectors, .limits], .anthropicMessages⟩ piLike
      = .refused [.connectors] := by decide +kernel

example :
    compose ⟨[.instructions, .limits], .anthropicMessages⟩ piLike = .accepted := by decide +kernel

/-! ## Billing independence (ADR-0065 D6) -/

/-- A run's billed usage is the sum of the gateway's ledger rows alone: two runs with the same
ledger bill the same, and changing what the engine reported about itself changes nothing. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d6--billing-is-always-gateway-metered")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")]
theorem billed_usage_is_a_function_of_the_gateway_ledger :
    (∀ a b : RunBilling, a.gatewayLedger = b.gatewayLedger → billed a = billed b) ∧
      (∀ (b : RunBilling) (reported : Concepts.Usage.Counters),
        billed { b with engineReported := reported } = billed b) := by
  refine ⟨?_, ?_⟩
  · intro a b h
    unfold billed
    rw [h]
  · intro b reported
    rfl

/-- Witness: the same ledger under two different engines, each lying differently about its own
usage, bills the same amount. -/
example :
    billed ⟨.claudeAgentSdk, [⟨3, 5, 0, 0, 1⟩, ⟨1, 1, 0, 0, 0⟩], ⟨999, 999, 9, 9, 9⟩⟩
      = billed ⟨.openaiAgents, [⟨3, 5, 0, 0, 1⟩, ⟨1, 1, 0, 0, 0⟩], Concepts.Usage.Counters.zero⟩ := by
  decide +kernel

end AgentWorkspace.Theorems.Normative.Engine
