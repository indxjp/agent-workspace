import AgentWorkspace.Behaviour.GatewayIngress
import AgentWorkspace.Trace.Spec

/-!
T2 for `gateway-ingress`: what the recorded usage row is a function of.

The three properties the unit requires of every extractor are proved here for all three: the
recorded usage **equals** the extraction applied to the frames, the extraction is **monotone** under
prefix truncation, and it **invents nothing** — the empty sequence measures zero, and a sequence
carrying no usage frame measures no tokens however long it is.

The monotonicity proofs go through `MLe`, a `Prop`-valued spelling of `Measurement.le` that `omega`
can reason about, and one `growsOver` lemma per extractor: a fold of monotone steps is monotone, so
every prefix of a frame sequence measures no more than the whole.
-/

namespace AgentWorkspace.Theorems.Invariants.GatewayIngress

open AgentWorkspace AgentWorkspace.Behaviour.GatewayIngress
open AgentWorkspace.Concepts.Usage

/-! ## `Measurement.le`, as a proposition -/

/-- `Measurement.le` spelled as a conjunction of `Nat` inequalities, which `omega` can close. -/
private def MLe (a b : Measurement) : Prop :=
  a.counters.inputTokens ≤ b.counters.inputTokens ∧
    a.counters.outputTokens ≤ b.counters.outputTokens ∧
    a.counters.cacheReadInputTokens ≤ b.counters.cacheReadInputTokens ∧
    a.counters.cacheCreationInputTokens ≤ b.counters.cacheCreationInputTokens ∧
    a.counters.toolCalls ≤ b.counters.toolCalls

private theorem mle_to_le {a b : Measurement} (h : MLe a b) : a.le b = true := by
  obtain ⟨h1, h2, h3, h4, h5⟩ := h
  simp only [Measurement.le, Bool.and_eq_true, decide_eq_true_eq]
  omega

private theorem mle_rfl (m : Measurement) : MLe m m := by simp only [MLe]; omega

private theorem mle_trans {a b c : Measurement} (hab : MLe a b) (hbc : MLe b c) : MLe a c := by
  obtain ⟨a1, a2, a3, a4, a5⟩ := hab
  obtain ⟨b1, b2, b3, b4, b5⟩ := hbc
  simp only [MLe]
  omega

/-- Nothing measured and nothing finished settles as a failure on every dialect. -/
private theorem settle_failed {protocol : WireProtocol} {m : Measurement} (h1 : m.metered = false)
    (h2 : m.completed = false) : settle protocol m = .failed := by simp [settle, h1, h2]

/-! ## Anthropic Messages -/

private theorem step_anthropic_grows (m : Measurement) (f : AnthropicFrame) :
    MLe m (stepAnthropic m f) := by
  cases f <;> simp only [MLe, stepAnthropic] <;> omega

private theorem fold_anthropic_grows (m : Measurement) (frames : List AnthropicFrame) :
    MLe m (frames.foldl stepAnthropic m) := by
  induction frames generalizing m with
  | nil => exact mle_rfl m
  | cons f rest ih => exact mle_trans (step_anthropic_grows m f) (ih (stepAnthropic m f))

private theorem anthropic_grows_over_suffix (a b : List AnthropicFrame) :
    MLe (extractAnthropic a) (extractAnthropic (a ++ b)) := by
  simp only [extractAnthropic, List.foldl_append]
  exact fold_anthropic_grows _ b

/-- Anthropic extraction never shrinks as more frames arrive: a truncated stream is charged no
more than the whole one. -/
@[aw_spec (tier := T2)
  (ts := "packages/gateway/src/usage/anthropic.ts#createAnthropicUsageAccumulator")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")]
theorem anthropic_extraction_is_prefix_monotone (frames : List AnthropicFrame) (n : Nat) :
    (extractAnthropic (frames.take n)).le (extractAnthropic frames) = true := by
  have h := anthropic_grows_over_suffix (frames.take n) (frames.drop n)
  rw [List.take_append_drop] at h
  exact mle_to_le h

/-- A sequence with no `usage` snapshot measures no tokens, however many other frames it carries:
the extractor never invents a count. -/
@[aw_spec (tier := T2)
  (ts := "packages/gateway/src/usage/anthropic.ts#createAnthropicUsageAccumulator")]
theorem anthropic_without_a_usage_frame_measures_no_tokens (frames : List AnthropicFrame)
    (h : frames.all (fun f => match f with | .usageSnapshot .. => false | _ => true) = true) :
    (extractAnthropic frames).metered = false ∧
      (extractAnthropic frames).counters.inputTokens = 0 ∧
      (extractAnthropic frames).counters.outputTokens = 0 := by
  suffices hgen : ∀ m : Measurement,
      m.metered = false → m.counters.inputTokens = 0 → m.counters.outputTokens = 0 →
      (frames.foldl stepAnthropic m).metered = false ∧
        (frames.foldl stepAnthropic m).counters.inputTokens = 0 ∧
        (frames.foldl stepAnthropic m).counters.outputTokens = 0 from
    hgen Measurement.zero rfl rfl rfl
  induction frames with
  | nil => intro m h1 h2 h3; exact ⟨h1, h2, h3⟩
  | cons f rest ih =>
    simp only [List.all_cons, Bool.and_eq_true] at h
    intro m h1 h2 h3
    refine ih h.2 (stepAnthropic m f) ?_ ?_ ?_ <;> cases f <;> simp_all [stepAnthropic]

/-! ## The OpenAI Responses API -/

/-- `ResponsesState` order: the measurement grows and the identity list only gets longer. -/
private def RLe (a b : ResponsesState) : Prop :=
  MLe a.measurement b.measurement ∧ a.functionCalls.length ≤ b.functionCalls.length

private theorem note_identity_grows (seen : List String) (id : String) :
    seen.length ≤ (noteIdentity seen id).length := by
  unfold noteIdentity; split <;> simp

private theorem note_identities_grow (seen ids : List String) :
    seen.length ≤ (noteIdentities seen ids).length := by
  unfold noteIdentities
  induction ids generalizing seen with
  | nil => simp
  | cons id rest ih =>
    exact Nat.le_trans (note_identity_grows seen id) (ih (noteIdentity seen id))

private theorem step_responses_grows (s : ResponsesState) (f : ResponsesFrame) :
    RLe s (stepResponses s f) := by
  cases f with
  | created => exact ⟨mle_rfl _, Nat.le_refl _⟩
  | functionCallDone id => exact ⟨mle_rfl _, note_identity_grows _ _⟩
  | terminal i o cached items =>
    refine ⟨?_, note_identities_grow _ _⟩
    simp only [MLe, stepResponses]
    omega

private theorem rle_trans {a b c : ResponsesState} (hab : RLe a b) (hbc : RLe b c) : RLe a c :=
  ⟨mle_trans hab.1 hbc.1, Nat.le_trans hab.2 hbc.2⟩

private theorem fold_responses_grows (s : ResponsesState) (frames : List ResponsesFrame) :
    RLe s (frames.foldl stepResponses s) := by
  induction frames generalizing s with
  | nil => exact ⟨mle_rfl _, Nat.le_refl _⟩
  | cons f rest ih => exact rle_trans (step_responses_grows s f) (ih (stepResponses s f))

/-- Responses extraction never shrinks as more frames arrive, counters and tool calls alike. -/
@[aw_spec (tier := T2)
  (ts := "packages/gateway/src/usage/responses.ts#createResponsesUsageAccumulator")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")]
theorem responses_extraction_is_prefix_monotone (frames : List ResponsesFrame) (n : Nat) :
    (extractResponses (frames.take n)).le (extractResponses frames) = true := by
  have h : RLe ((frames.take n).foldl stepResponses ResponsesState.zero)
      ((frames.take n ++ frames.drop n).foldl stepResponses ResponsesState.zero) := by
    rw [List.foldl_append]
    exact fold_responses_grows _ _
  rw [List.take_append_drop] at h
  obtain ⟨⟨h1, h2, h3, h4, _⟩, hlen⟩ := h
  exact mle_to_le ⟨h1, h2, h3, h4, hlen⟩

/-- A Responses sequence with no terminal frame measures no tokens and is neither metered nor
complete, so it settles as a failure rather than as a measured zero. -/
@[aw_spec (tier := T2)
  (ts := "packages/gateway/src/usage/responses.ts#createResponsesUsageAccumulator")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d9--no-sixth-accounting-state-is-invented")]
theorem responses_without_a_terminal_frame_is_a_failure (frames : List ResponsesFrame)
    (h : frames.all (fun f => match f with | .terminal .. => false | _ => true) = true) :
    (extractResponses frames).metered = false ∧
      (extractResponses frames).completed = false ∧
      (extractResponses frames).counters.inputTokens = 0 ∧
      (extractResponses frames).counters.outputTokens = 0 ∧
      settle .openaiResponses (extractResponses frames) = .failed := by
  suffices hgen : ∀ s : ResponsesState, (frames.foldl stepResponses s).measurement = s.measurement by
    have hz := hgen ResponsesState.zero
    have hm : (extractResponses frames).metered = false := by
      show (frames.foldl stepResponses ResponsesState.zero).measurement.metered = false
      rw [hz]; rfl
    have hc : (extractResponses frames).completed = false := by
      show (frames.foldl stepResponses ResponsesState.zero).measurement.completed = false
      rw [hz]; rfl
    refine ⟨hm, hc, ?_, ?_, settle_failed hm hc⟩
    · show (frames.foldl stepResponses ResponsesState.zero).measurement.counters.inputTokens = 0
      rw [hz]; rfl
    · show (frames.foldl stepResponses ResponsesState.zero).measurement.counters.outputTokens = 0
      rw [hz]; rfl
  induction frames with
  | nil => intro s; rfl
  | cons f rest ih =>
    simp only [List.all_cons, Bool.and_eq_true] at h
    intro s
    rw [List.foldl_cons, ih h.2]
    cases f with
    | created => rfl
    | functionCallDone _ => rfl
    | terminal i o cached items => simp at h

/-- The cached prefix is subtracted from the reported input and reported as a cache read instead:
the two are additive in the price table, so relaying the raw figure would bill it twice. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")
  (ts := "packages/gateway/src/usage/responses.ts#createResponsesUsageAccumulator")]
theorem responses_cached_prefix_is_charged_once (i o cached : Nat) :
    let m := extractResponses [.terminal i o cached []]
    m.counters.inputTokens + m.counters.cacheReadInputTokens = max i cached ∧
      m.counters.outputTokens = o := by
  simp only [extractResponses, stepResponses, ResponsesState.zero, Measurement.zero, Counters.zero,
    List.foldl_cons, List.foldl_nil, noteIdentities]
  omega

/-- Counting distinct item identities is what stops a repeated `function_call` inflating the row:
the stream and the terminal snapshot both name the same item, and it is charged once. -/
@[aw_spec (tier := T2) (ts := "packages/gateway/src/usage/responses.ts#itemIdentity")]
theorem a_repeated_function_call_is_counted_once :
    (extractResponses
      [.functionCallDone "fc_1", .functionCallDone "fc_1",
        .terminal 1 1 0 ["fc_1"]]).counters.toolCalls = 1 ∧
    (extractResponses
      [.functionCallDone "fc_1", .functionCallDone "fc_2",
        .terminal 1 1 0 ["fc_1", "fc_2"]]).counters.toolCalls = 2 := by decide

/-! ## OpenAI Chat Completions -/

/-- `ChatState` order: the measurement grows and the `(choice, index)` list only gets longer. -/
private def CLe (a b : ChatState) : Prop :=
  MLe a.measurement b.measurement ∧ a.toolCalls.length ≤ b.toolCalls.length

private theorem note_pair_grows (seen : List (Nat × Nat)) (pair : Nat × Nat) :
    seen.length ≤ (notePair seen pair).length := by
  unfold notePair; split <;> simp

private theorem step_chat_grows (s : ChatState) (f : ChatFrame) : CLe s (stepChat s f) := by
  cases f with
  | toolCallDelta choice call => exact ⟨mle_rfl _, note_pair_grows _ _⟩
  | finish => exact ⟨mle_rfl _, Nat.le_refl _⟩
  | usage prompt completion cached =>
    refine ⟨?_, Nat.le_refl _⟩
    simp only [MLe, stepChat]
    omega

private theorem cle_trans {a b c : ChatState} (hab : CLe a b) (hbc : CLe b c) : CLe a c :=
  ⟨mle_trans hab.1 hbc.1, Nat.le_trans hab.2 hbc.2⟩

private theorem fold_chat_grows (s : ChatState) (frames : List ChatFrame) :
    CLe s (frames.foldl stepChat s) := by
  induction frames generalizing s with
  | nil => exact ⟨mle_rfl _, Nat.le_refl _⟩
  | cons f rest ih => exact cle_trans (step_chat_grows s f) (ih (stepChat s f))

/-- Chat Completions extraction never shrinks as more chunks arrive. -/
@[aw_spec (tier := T2)
  (ts := "packages/gateway/src/usage/chat-completions.ts#createChatCompletionsUsageAccumulator")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")]
theorem chat_extraction_is_prefix_monotone (frames : List ChatFrame) (n : Nat) :
    (extractChat (frames.take n)).le (extractChat frames) = true := by
  have h : CLe ((frames.take n).foldl stepChat ChatState.zero)
      ((frames.take n ++ frames.drop n).foldl stepChat ChatState.zero) := by
    rw [List.foldl_append]
    exact fold_chat_grows _ _
  rw [List.take_append_drop] at h
  obtain ⟨⟨h1, h2, h3, h4, _⟩, hlen⟩ := h
  exact mle_to_le ⟨h1, h2, h3, h4, hlen⟩

/-- A Chat Completions sequence with no `usage` chunk measures no tokens, whatever else it carries.
This is the `openai-compatible` upstream that does not honour `stream_options.include_usage`: its
row is zeros that were never measured, never fabricated counts. -/
@[aw_spec (tier := T2)
  (ts := "packages/gateway/src/usage/chat-completions.ts#createChatCompletionsUsageAccumulator")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d9--no-sixth-accounting-state-is-invented")]
theorem chat_without_a_usage_chunk_measures_no_tokens (frames : List ChatFrame)
    (h : frames.all (fun f => match f with | .usage .. => false | _ => true) = true) :
    (extractChat frames).metered = false ∧
      (extractChat frames).counters.inputTokens = 0 ∧
      (extractChat frames).counters.outputTokens = 0 ∧
      (extractChat frames).counters.cacheReadInputTokens = 0 := by
  suffices hgen : ∀ s : ChatState,
      s.measurement.metered = false →
      s.measurement.counters.inputTokens = 0 →
      s.measurement.counters.outputTokens = 0 →
      s.measurement.counters.cacheReadInputTokens = 0 →
      (frames.foldl stepChat s).measurement.metered = false ∧
        (frames.foldl stepChat s).measurement.counters.inputTokens = 0 ∧
        (frames.foldl stepChat s).measurement.counters.outputTokens = 0 ∧
        (frames.foldl stepChat s).measurement.counters.cacheReadInputTokens = 0 from
    hgen ChatState.zero rfl rfl rfl rfl
  induction frames with
  | nil => intro s h1 h2 h3 h4; exact ⟨h1, h2, h3, h4⟩
  | cons f rest ih =>
    simp only [List.all_cons, Bool.and_eq_true] at h
    intro s h1 h2 h3 h4
    refine ih h.2 (stepChat s f) ?_ ?_ ?_ ?_ <;> cases f <;> simp_all [stepChat]

/-- One tool call whose arguments fragment across many chunks is charged once, because the deltas
all repeat the same `(choice, index)` pair; three distinct pairs are three calls. -/
@[aw_spec (tier := T2) (ts := "packages/gateway/src/usage/chat-completions.ts#toolCallIdentity")]
theorem a_fragmented_tool_call_is_counted_once :
    (extractChat [.toolCallDelta 0 0, .toolCallDelta 0 0, .toolCallDelta 0 0,
      .finish, .usage 1 1 0]).counters.toolCalls = 1 ∧
    (extractChat [.toolCallDelta 0 0, .toolCallDelta 0 1, .toolCallDelta 1 0,
      .finish, .usage 1 1 0]).counters.toolCalls = 3 := by decide

/-- `prompt_tokens` includes the cached prefix here too, and is split the same way. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")
  (ts := "packages/gateway/src/usage/chat-completions.ts#createChatCompletionsUsageAccumulator")]
theorem chat_cached_prefix_is_charged_once (prompt completion cached : Nat) :
    let m := extractChat [.usage prompt completion cached]
    m.counters.inputTokens + m.counters.cacheReadInputTokens = max prompt cached ∧
      m.counters.outputTokens = completion := by
  simp only [extractChat, stepChat, ChatState.zero, Measurement.zero, Counters.zero,
    List.foldl_cons, List.foldl_nil]
  omega

/-! ## The recorded row is the extraction -/

/-- The recorded usage is exactly the extraction applied to the frames: the settlement adds nothing
of its own beyond choosing between a row and a failure. Stated for all three dialects. -/
@[aw_spec (tier := T2) (ts := "packages/gateway/src/auth.ts#recordResponseUsage")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")]
theorem recorded_usage_is_the_extraction (protocol : WireProtocol) (m : Measurement) (c : Counters)
    (b : Bool) (h : settle protocol m = .recorded c b) : c = m.counters ∧ b = m.metered := by
  unfold settle at h
  split at h
  · cases h; exact ⟨rfl, rfl⟩
  · cases h

/-- A witness: a complete Responses stream with one tool call, its cached prefix split off, records
exactly what the frames said. -/
@[aw_spec (tier := T2) (ts := "packages/gateway/src/auth.ts#recordResponseUsage")]
theorem responses_settlement_has_a_measured_witness :
    settle .openaiResponses (extractResponses
      [.created, .functionCallDone "fc_1", .terminal 100 40 30 ["fc_1"]]) =
      .recorded ⟨70, 40, 30, 0, 1⟩ true := by decide

/-- And a witness for the unmetered-but-finished case: a compatible upstream that never reported
usage records measured-nothing and settles `unavailable`. -/
@[aw_spec (tier := T2) (ts := "packages/gateway/src/auth.ts#recordResponseUsage")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d9--no-sixth-accounting-state-is-invented")]
theorem chat_unmetered_settlement_has_a_witness :
    settle .openaiChatCompletions (extractChat [.toolCallDelta 0 0, .finish]) =
        .recorded ⟨0, 0, 0, 0, 1⟩ false ∧
      settledAccounting
          (settle .openaiChatCompletions (extractChat [.toolCallDelta 0 0, .finish])) =
        .unavailable := by
  decide

end AgentWorkspace.Theorems.Invariants.GatewayIngress
