import AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-!
# T2 — the OpenAI Agents event mapping and turn limit (ENG-09, #308)

* **Nothing is dropped.** Every SDK event becomes at least one frame, and every frame is in the
  closed `agent.*` vocabulary — a neutral frame, `agent.native` or `agent.malformed`.
* **Tool pairing.** In every mapped stream, every `agent.tool.result` names a call an earlier
  `agent.tool.call` announced and no earlier result answered.
* **The turn limit.** Under the SDK's native `maxTurns` contract (a hypothesis), a run stops at or
  before the limit, and one that was cut short ends with `agent.result {stopReason: 'max_turns'}`.
-/

namespace AgentWorkspace.Theorems.Invariants.OpenAiAgents

open AgentWorkspace AgentWorkspace.Events.AgentFrames AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-- Every frame the mapper can produce is in the closed vocabulary. -/
private theorem every_frame_is_neutral (f : Frame) : isNeutral f = true := by
  cases f <;> simp [isNeutral, frameNames, Frame.name]

/-- The mapping never drops an event: each one becomes at least one frame, and every frame is a
neutral frame, `agent.native` or `agent.malformed`. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-openai-agents.md#events")
  (ts := "packages/engine-openai-agents/src/frames.ts#createOpenAiAgentsFrameMapper")]
theorem the_mapping_never_drops_an_event (ctx : FrameContext) (announced : List String)
    (e : Event) :
    (step ctx announced e).2 ≠ [] ∧ ∀ f ∈ (step ctx announced e).2, isNeutral f = true := by
  refine ⟨?_, fun f _ => every_frame_is_neutral f⟩
  cases e with
  | toolCalled isFunction callId name =>
    cases isFunction <;> cases callId <;> cases name <;> simp [step]
  | toolOutput isFunctionResult callId output incomplete =>
    cases isFunctionResult <;> cases callId <;> simp [step] <;> split <;> simp
  | messageCreated id texts => cases texts <;> simp [step]
  | reasoningCreated id text => cases text <;> simp [step]
  | completed stop turns usage => simp [step]
  | _ => simp [step]

/-- One event's frames advance the pairing scan exactly as the mapper advances its announced
list. -/
private theorem paired_step (ctx : FrameContext) (announced : List String) (e : Event)
    (rest : List Frame) :
    pairedFrom announced ((step ctx announced e).2 ++ rest) =
      pairedFrom (step ctx announced e).1 rest := by
  cases e with
  | toolCalled isFunction callId name =>
    cases isFunction <;> cases callId <;> cases name <;> simp [step, pairedFrom]
  | toolOutput isFunctionResult callId output incomplete =>
    cases isFunctionResult <;> cases callId <;> simp [step, pairedFrom]
    split <;> simp [pairedFrom, *]
  | messageCreated id texts => cases texts <;> simp [step, pairedFrom]
  | reasoningCreated id text => cases text <;> simp [step, pairedFrom]
  | completed stop turns usage => cases usage <;> simp [step, pairedFrom]
  | _ => simp [step, pairedFrom]

private theorem paired_from (ctx : FrameContext) (events : List Event) :
    ∀ announced, pairedFrom announced (mapFrom ctx announced events) = true := by
  induction events with
  | nil => intro announced; simp [mapFrom, pairedFrom]
  | cons e rest ih =>
    intro announced
    simp only [mapFrom]
    rw [paired_step]
    exact ih _

/-- Tool pairing holds on every mapped stream: every `agent.tool.result` answers a call an earlier
`agent.tool.call` announced and no earlier result answered. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-openai-agents.md#events")
  (ts := "packages/engine-openai-agents/src/frames.ts#createOpenAiAgentsFrameMapper")]
theorem tool_pairing_holds (ctx : FrameContext) (events : List Event) :
    pairedFrom [] (mapAll ctx events) = true :=
  paired_from ctx events []

/-- Witness: an output whose call was never announced is `agent.malformed`, not a result. -/
example :
    mapAll { localTools := ["read_file"], hasMcp := false }
        [.toolOutput true (some "call_9") "x" false] =
      [.malformed "a tool output for a call no tool call announced"] := by decide +kernel

/-- The adapter stops at or before `limits.maxTurns`, and a run the limit cut short ends with
`agent.result {stopReason: 'max_turns'}` carrying the turns it took. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-openai-agents.md#turns")
  (ts := "packages/engine-openai-agents/src/boundary.ts#startOpenAiAgentsRun")
  (ts := "packages/engine-openai-agents/src/frames.ts#createOpenAiAgentsFrameMapper")]
theorem the_run_stops_at_or_before_max_turns (ctx : FrameContext) (announced : List String)
    (limit wanted : Nat) (usage : Option Usage) :
    (runOutcome (some limit) wanted).1 ≤ limit ∧
      ((runOutcome (some limit) wanted).2 = .maxTurns ↔ limit < wanted) ∧
      (limit < wanted →
        (step ctx announced
            (.completed (runOutcome (some limit) wanted).2 (some (runOutcome (some limit) wanted).1)
              usage)).2.getLast? =
          some (.result .maxTurns (some limit) none)) := by
  unfold runOutcome
  by_cases hw : wanted ≤ limit
  · simp [hw]
    omega
  · have hlt : limit < wanted := by omega
    simp [hw, hlt, step]
    try (cases usage <;> simp)

/-- Witness: `maxTurns: 2` over a looping agent ends after two turns with `max_turns`. -/
example :
    runOutcome (some 2) 5 = (2, .maxTurns) ∧ runOutcome (some 2) 1 = (1, .endTurn) := by decide +kernel

end AgentWorkspace.Theorems.Invariants.OpenAiAgents
