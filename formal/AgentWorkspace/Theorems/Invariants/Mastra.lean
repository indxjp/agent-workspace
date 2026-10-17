import AgentWorkspace.Behaviour.Engines.Mastra

/-!
# T2 — the Mastra event mapping, step limit and memory (ENG-10, #309)

* **Nothing is dropped.** Every raw `fullStream` chunk the boundary reads is represented among
  the events it yields — `finish` by the terminal event, or by itself after an `error` — every
  event becomes at least one frame, and every frame is in the closed `agent.*` vocabulary: a
  neutral frame, `agent.native` or `agent.malformed`.
* **Tool pairing.** In every mapped stream, every `agent.tool.result` names a call an earlier
  `agent.tool.call` announced and no earlier result answered; so the stream is `paired` in the
  sense of `Events/AgentFrames.lean`.
* **The step limit.** Compile hands Mastra `limits.maxTurns` as `maxSteps`. The adapter stops at or
  before it; a `max_turns` stop is at the limit; a run that keeps asking for tools up to the limit
  is cut short there and ends with `agent.result {stopReason: 'max_turns'}`; and the boundary's
  verdict (`mastraStopReason`) puts the budget cap before an interrupt before the step limit, and
  says `max_turns` exactly when the last allowed step still asked for tools.
* **Memory.** A thread's messages journalled into the platform's store stream read back as the
  same messages, in order — the round trip that lets a second run recall the first.
-/

namespace AgentWorkspace.Theorems.Invariants.Mastra

open AgentWorkspace AgentWorkspace.Events.AgentFrames AgentWorkspace.Behaviour.Engines.Mastra

/-- Every frame the mapper can produce is in the closed vocabulary. -/
private theorem every_frame_is_neutral (f : Frame) :
    Behaviour.Engines.OpenAiAgents.isNeutral f = true := by
  cases f <;>
    simp [Behaviour.Engines.OpenAiAgents.isNeutral, Behaviour.Engines.OpenAiAgents.frameNames,
      Frame.name]

/-- The mapping never drops a chunk: each one becomes at least one frame, and every frame is a
neutral frame, `agent.native` or `agent.malformed`. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-mastra.md#events")
  (ts := "packages/engine-mastra/src/frames.ts#createMastraFrameMapper")]
theorem the_mapping_never_drops_an_event (connectors : List String) (s : MapState) (e : Chunk) :
    (step connectors s e).2 ≠ [] ∧
      ∀ f ∈ (step connectors s e).2, Behaviour.Engines.OpenAiAgents.isNeutral f = true := by
  refine ⟨?_, fun f _ => every_frame_is_neutral f⟩
  cases e with
  | textDelta id text => cases id <;> cases text <;> simp [step, deltaStep]
  | reasoningDelta id text => cases id <;> cases text <;> simp [step, deltaStep]
  | textEnd id => cases id <;> simp [step, endStep]
  | reasoningEnd id => cases id <;> simp [step, endStep]
  | toolCall callId name => cases callId <;> cases name <;> simp [step]
  | toolResult callId output isError =>
    cases callId <;> simp only [step, answerStep] <;> (try split) <;> simp
  | toolError callId message =>
    cases callId <;> simp only [step, answerStep] <;> (try split) <;> simp
  | completed stop steps usage => simp [step]
  | _ => simp [step]

/-- Every raw chunk the boundary reads is represented among the events it yields: a chunk other
than `finish` is forwarded as itself, and `finish` becomes the adapter's terminal event — or, after
an `error` chunk, which no second result may follow, is forwarded as a native chunk. With
`the_mapping_never_drops_an_event`, each of those events becomes at least one frame. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-mastra.md#events")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")
  (ts := "packages/engine-mastra/src/frames.ts#createMastraFrameMapper")]
theorem every_raw_chunk_is_represented (raws : List Raw)
    (terminal : StopReason × Nat × Option Usage) :
    (∀ c, Raw.chunk c ∈ raws → c ∈ boundaryEvents raws terminal) ∧
      (Raw.finish ∈ raws →
        Chunk.other "finish" ∈ boundaryEvents raws terminal ∨
          Chunk.completed terminal.1 terminal.2.1 terminal.2.2 ∈ boundaryEvents raws terminal) ∧
      ∀ connectors (s : MapState) e, e ∈ boundaryEvents raws terminal →
        (step connectors s e).2 ≠ [] := by
  have hfwd : ∀ c, Raw.chunk c ∈ raws → c ∈ forwarded raws := by
    intro c hc
    induction raws with
    | nil => simp at hc
    | cons x rest ih =>
      rcases List.mem_cons.mp hc with h | h
      · subst h; simp [forwarded]
      · cases x with
        | chunk d => simp only [forwarded, List.mem_cons]; exact Or.inr (ih h)
        | finish => simp only [forwarded]; exact ih h
  refine ⟨fun c hc => ?_, fun hf => ?_, fun connectors s e _ =>
    (the_mapping_never_drops_an_event connectors s e).1⟩
  · unfold boundaryEvents
    split <;> exact List.mem_append_left _ (hfwd c hc)
  · unfold boundaryEvents
    split
    · left
      have hfin : raws.contains Raw.finish = true := by simpa using hf
      rw [hfin]
      exact List.mem_append_right _ (List.mem_singleton_self _)
    · right
      simp

/-- A tool's answer keeps the pairing scan ahead of the mapper. -/
private theorem paired_answer (s : MapState) (open_ : List String) (callId : Option String)
    (output : String) (isError : Bool) (rest : List Frame)
    (hnd : s.announced.Nodup) (hsub : ∀ x ∈ s.announced, x ∈ open_) :
    ∃ open', (answerStep s callId output isError).1.announced.Nodup ∧
      (∀ x ∈ (answerStep s callId output isError).1.announced, x ∈ open') ∧
      Behaviour.Engines.OpenAiAgents.pairedFrom open_
          ((answerStep s callId output isError).2 ++ rest) =
        Behaviour.Engines.OpenAiAgents.pairedFrom open' rest := by
  cases callId with
  | none =>
    exact ⟨open_, by simpa [answerStep] using hnd, by simpa [answerStep] using hsub,
      by simp [answerStep, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
  | some id =>
    by_cases hmem : id ∈ s.announced
    · refine ⟨open_.erase id, ?_, ?_, ?_⟩
      · simpa [answerStep, hmem] using hnd.erase id
      · intro x hx
        simp only [answerStep, List.contains_iff_mem, hmem, ↓reduceIte] at hx
        obtain ⟨hne, hx'⟩ := (List.Nodup.mem_erase_iff hnd).mp hx
        exact (List.mem_erase_of_ne hne).mpr (hsub x hx')
      · simp [answerStep, hmem, Behaviour.Engines.OpenAiAgents.pairedFrom, hsub id hmem]
    · exact ⟨open_, by simpa [answerStep, hmem] using hnd, by simpa [answerStep, hmem] using hsub,
        by simp [answerStep, hmem, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩

/-- One chunk keeps the pairing scan ahead of the mapper: if every call id the mapper holds open is
open in the scan too, and the mapper holds each id once, the same holds after the chunk, and the
chunk's frames pass the scan. -/
private theorem paired_step (connectors : List String) (s : MapState) (open_ : List String)
    (e : Chunk) (rest : List Frame)
    (hnd : s.announced.Nodup) (hsub : ∀ x ∈ s.announced, x ∈ open_) :
    ∃ open', (step connectors s e).1.announced.Nodup ∧
      (∀ x ∈ (step connectors s e).1.announced, x ∈ open') ∧
      Behaviour.Engines.OpenAiAgents.pairedFrom open_ ((step connectors s e).2 ++ rest) =
        Behaviour.Engines.OpenAiAgents.pairedFrom open' rest := by
  cases e with
  | toolCall callId name =>
    cases callId with
    | none =>
      exact ⟨open_, by simpa [step] using hnd, by simpa [step] using hsub,
        by simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
    | some id =>
      cases name with
      | none =>
        exact ⟨open_, by simpa [step] using hnd, by simpa [step] using hsub,
          by simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
      | some nm =>
        refine ⟨open_ ++ [id], ?_, ?_, ?_⟩
        · simp only [step]
          split
          · exact hnd
          · rename_i hc
            have hnot : id ∉ s.announced := by simpa using hc
            simp only [List.nodup_append, hnd, List.nodup_cons, List.not_mem_nil,
              not_false_eq_true, List.nodup_nil, and_self, List.mem_singleton, true_and]
            rintro a ha b rfl rfl
            exact hnot ha
        · intro x hx
          simp only [step] at hx
          split at hx
          · exact List.mem_append_left _ (hsub x hx)
          · rcases List.mem_append.mp hx with h | h
            · exact List.mem_append_left _ (hsub x h)
            · exact List.mem_append_right _ h
        · simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]
  | toolResult callId output isError => exact paired_answer s open_ callId output isError rest hnd hsub
  | toolError callId message => exact paired_answer s open_ callId message true rest hnd hsub
  | textDelta id text =>
    cases id <;> cases text <;>
      exact ⟨open_, by simpa [step, deltaStep] using hnd, by simpa [step, deltaStep] using hsub,
        by simp [step, deltaStep, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
  | reasoningDelta id text =>
    cases id <;> cases text <;>
      exact ⟨open_, by simpa [step, deltaStep] using hnd, by simpa [step, deltaStep] using hsub,
        by simp [step, deltaStep, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
  | textEnd id =>
    cases id <;>
      exact ⟨open_, by simpa [step, endStep] using hnd, by simpa [step, endStep] using hsub,
        by simp [step, endStep, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
  | reasoningEnd id =>
    cases id <;>
      exact ⟨open_, by simpa [step, endStep] using hnd, by simpa [step, endStep] using hsub,
        by simp [step, endStep, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
  | completed stop steps usage =>
    cases usage <;>
      exact ⟨open_, hnd, hsub, by simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
  | _ =>
    exact ⟨open_, by simpa [step] using hnd, by simpa [step] using hsub,
      by simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩

private theorem paired_from (connectors : List String) (chunks : List Chunk) :
    ∀ s open_, s.announced.Nodup → (∀ x ∈ s.announced, x ∈ open_) →
      Behaviour.Engines.OpenAiAgents.pairedFrom open_ (mapFrom connectors s chunks) = true := by
  induction chunks with
  | nil =>
    intro s open_ _ _
    rw [mapFrom_nil]
    exact Behaviour.Engines.OpenAiAgents.pairedFrom_nil open_
  | cons e rest ih =>
    intro s open_ hnd hsub
    simp only [mapFrom]
    obtain ⟨open', hnd', hsub', heq⟩ :=
      paired_step connectors s open_ e (mapFrom connectors _ rest) hnd hsub
    rw [heq]
    exact ih _ open' hnd' hsub'

/-- Tool pairing holds on every mapped stream: every `agent.tool.result` answers a call an earlier
`agent.tool.call` announced and no earlier result answered. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-mastra.md#events")
  (ts := "packages/engine-mastra/src/frames.ts#createMastraFrameMapper")]
theorem tool_pairing_holds (connectors : List String) (chunks : List Chunk) :
    Behaviour.Engines.OpenAiAgents.pairedFrom [] (mapAll connectors chunks) = true :=
  paired_from connectors chunks MapState.empty [] List.nodup_nil (fun _ h => h)

/-- The engine's pairing scan, which also forgets an answered id, accepts only streams whose every
result names an id an earlier call announced. -/
private theorem results_follow_calls (fs : List Frame) :
    ∀ open_, Behaviour.Engines.OpenAiAgents.pairedFrom open_ fs = true →
      ∀ pre id st out err rest, fs = pre ++ .toolResult id st out err :: rest →
        id ∈ open_ ∨ id ∈ callIds pre := by
  induction fs with
  | nil => intro _ _ pre id st out err rest he; simp at he
  | cons f fs ih =>
    intro open_ hp pre id st out err rest he
    cases pre with
    | nil =>
      simp only [List.nil_append, List.cons.injEq] at he
      obtain ⟨rfl, rfl⟩ := he
      simp only [Behaviour.Engines.OpenAiAgents.pairedFrom, Bool.and_eq_true,
        List.contains_iff_mem] at hp
      exact Or.inl hp.1
    | cons g pre =>
      simp only [List.cons_append, List.cons.injEq] at he
      obtain ⟨rfl, rfl⟩ := he
      cases f with
      | toolCall cid n k i =>
        simp only [Behaviour.Engines.OpenAiAgents.pairedFrom] at hp
        rcases ih _ hp pre id st out err rest rfl with h | h
        · rcases List.mem_append.mp h with h | h
          · exact Or.inl h
          · simp only [List.mem_singleton] at h
            subst h
            simp [callIds]
        · exact Or.inr (by simp [callIds, h])
      | toolResult rid rst rout rerr =>
        simp only [Behaviour.Engines.OpenAiAgents.pairedFrom, Bool.and_eq_true] at hp
        rcases ih _ hp.2 pre id st out err rest rfl with h | h
        · exact Or.inl (List.mem_of_mem_erase h)
        · exact Or.inr (by simpa [callIds] using h)
      | _ =>
        simp only [Behaviour.Engines.OpenAiAgents.pairedFrom] at hp
        rcases ih _ hp pre id st out err rest rfl with h | h
        · exact Or.inl h
        · exact Or.inr (by simpa [callIds] using h)

/-- Every mapped stream — the boundary's events included — is `paired` in the sense of
`Events/AgentFrames.lean`: each `agent.tool.result` names an id an earlier `agent.tool.call`
announced. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-mastra.md#events")
  (ts := "packages/engine-mastra/src/frames.ts#createMastraFrameMapper")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
theorem every_mapped_stream_is_paired (connectors : List String) (chunks : List Chunk) :
    paired (mapAll connectors chunks) = true := by
  apply paired_of_results_follow_calls
  intro pre id st out err rest he
  rcases results_follow_calls _ [] (tool_pairing_holds connectors chunks) pre id st out err rest he
    with h | h
  · simp at h
  · exact h

/-- Witness: a stray result is `agent.malformed`, a refused write is a `failed` result, an MCP
tool is `mcp`, a text part's deltas are joined into its message, and an `error` chunk is the run's
`agent.result {stopReason: 'error'}`. -/
example :
    mapAll [] [.toolResult (some "call_9") "x" false] =
        [.malformed "a tool result for a call no tool call announced"] ∧
      mapAll ["docs"] [.toolCall (some "c1") (some "docs_search"),
          .toolError (some "c1") "write refused"] =
        [.toolCall "c1" "docs_search" .mcp .null, .toolResult "c1" .failed "write refused" true] ∧
      mapAll [] [.textDelta (some "t") (some "Hel"), .textDelta (some "t") (some "lo"),
          .textEnd (some "t")] =
        [.delta (some "t") .text "Hel", .delta (some "t") .text "lo",
         .message (some "t") .assistant [.text "Hello"]] ∧
      mapAll [] [.stepFinish, .error] = [.native "step-finish" .null, .result .error (some 1) none] := by
  decide

/-! ## The step limit -/

/-- Compile hands Mastra the portable `limits.maxTurns` as its native `maxSteps`, unchanged. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-mastra.md#steps")
  (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")]
theorem the_step_limit_is_max_turns {r : Request} {c : Compiled} (h : compile r = .ok c) :
    c.maxSteps = r.maxTurns := by
  obtain ⟨grants, b, t, w, p, names, tid, _, _, _, _, _, _, _, rfl⟩ := compile_ok_shape h
  rfl

/-- The boundary's verdict on a drained run: the budget cap wins over everything, an interrupt over
the step limit, and otherwise the run ends `max_turns` exactly when it reached `maxSteps` with its
last step still asking for tools — so a run that used exactly `maxSteps` steps and stopped on its
own ends `end_turn` — and `end_turn` with no limit. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-mastra.md#steps")
  (ts := "packages/engine-mastra/src/boundary.ts#mastraStopReason")]
theorem the_stop_reason_follows_the_precedence (steps : Nat) (last : Option String)
    (maxSteps : Option Nat) (interrupted : Bool) :
    stopReason steps last maxSteps true interrupted = .maxBudget ∧
      stopReason steps last maxSteps false true = .cancelled ∧
      stopReason steps last none false false = .endTurn ∧
      ∀ m, (stopReason steps last (some m) false false = .maxTurns ↔
        m ≤ steps ∧ last = some "tool-calls") ∧
        (stopReason steps last (some m) false false = .endTurn ↔
          ¬(m ≤ steps ∧ last = some "tool-calls")) := by
  refine ⟨rfl, rfl, rfl, fun m => ⟨?_, ?_⟩⟩
  · unfold stopReason
    by_cases hm : m ≤ steps <;> by_cases hl : last = some "tool-calls" <;> simp [hm, hl]
  · unfold stopReason
    by_cases hm : m ≤ steps <;> by_cases hl : last = some "tool-calls" <;> simp [hm, hl]

/-- Witness: at the limit, a last step that asked for tools is `max_turns` and one that stopped on
its own is `end_turn`; below the limit a tool step is `end_turn`; the cap and an interrupt win. -/
example :
    stopReason 2 (some "tool-calls") (some 2) false false = .maxTurns ∧
      stopReason 2 (some "stop") (some 2) false false = .endTurn ∧
      stopReason 1 (some "tool-calls") (some 2) false false = .endTurn ∧
      stopReason 2 (some "tool-calls") (some 2) true true = .maxBudget ∧
      stopReason 2 (some "tool-calls") (some 2) false true = .cancelled := by
  decide

/-- The adapter never takes more than `limits.maxTurns` steps. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-mastra.md#steps")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
theorem the_run_stops_at_or_before_max_turns (m : Nat) :
    ∀ (steps : List Bool) (n : Nat), n < m → (stepRun (some m) n steps).1 ≤ m := by
  intro steps
  induction steps with
  | nil => intro n hn; simp [stepRun]; all_goals omega
  | cons c rest ih =>
    intro n hn
    cases c
    · simp [stepRun]; all_goals omega
    · by_cases hm : m ≤ n + 1
      · simp [stepRun, hm]; all_goals omega
      · simp only [stepRun, Bool.not_true, Bool.false_eq_true, ↓reduceIte, hm]
        exact ih (n + 1) (by omega)

/-- A run the limit cut short ends `max_turns` exactly at the limit. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-mastra.md#steps")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
theorem a_max_turns_stop_is_at_the_limit (m : Nat) :
    ∀ (steps : List Bool) (n : Nat), n < m →
      (stepRun (some m) n steps).2 = .maxTurns → (stepRun (some m) n steps).1 = m := by
  intro steps
  induction steps with
  | nil => intro n _ h; simp [stepRun] at h
  | cons c rest ih =>
    intro n hn h
    cases c
    · simp [stepRun] at h
    · by_cases hm : m ≤ n + 1
      · simp [stepRun, hm]; all_goals omega
      · simp only [stepRun, Bool.not_true, Bool.false_eq_true, ↓reduceIte, hm] at h ⊢
        exact ih (n + 1) (by omega) h

/-- The converse: a run whose model keeps asking for tools at every step up to the limit is cut
short exactly at `limits.maxTurns` and ends `max_turns`, and its terminal event maps to
`agent.result {stopReason: 'max_turns', turns: m}` after the usage. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-mastra.md#steps")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")
  (ts := "packages/engine-mastra/src/frames.ts#createMastraFrameMapper")]
theorem a_run_the_limit_cuts_short_ends_max_turns (m : Nat) :
    ∀ (steps : List Bool) (n : Nat), n < m → m - n ≤ steps.length →
      (∀ c ∈ steps.take (m - n), c = true) →
        stepRun (some m) n steps = (m, .maxTurns) ∧
          ∀ (connectors : List String) (s : MapState) (usage : Option Usage),
            (step connectors s (.completed (stepRun (some m) n steps).2
                (stepRun (some m) n steps).1 usage)).2 =
              (usage.map Frame.usage).toList ++ [.result .maxTurns (some m) none] := by
  intro steps
  induction steps with
  | nil => intro n hn hlen; simp at hlen; omega
  | cons c rest ih =>
    intro n hn hlen hall
    have hrun : stepRun (some m) n (c :: rest) = (m, .maxTurns) := by
      have hk : m - n = (m - (n + 1)) + 1 := by omega
      rw [hk, List.take_succ_cons] at hall
      have hc : c = true := hall c (List.mem_cons_self ..)
      subst hc
      by_cases hm : m ≤ n + 1
      · have hm' : n + 1 = m := by omega
        simp [stepRun, hm']
      · simp only [stepRun, Bool.not_true, Bool.false_eq_true, ↓reduceIte, hm]
        refine (ih (n + 1) (by omega) ?_ ?_).1
        · simp only [List.length_cons] at hlen; omega
        · exact fun c hc => hall c (List.mem_cons_of_mem _ hc)
    refine ⟨hrun, fun connectors s usage => ?_⟩
    rw [hrun]
    rfl

/-- Witness: `maxTurns: 2` over an agent that would keep calling tools ends after two steps with
`max_turns`; an agent that answers in one step ends `end_turn`. -/
example :
    stepRun (some 2) 0 [true, true, true, false] = (2, .maxTurns) ∧
      stepRun (some 2) 0 [false] = (1, .endTurn) ∧
      (step [] MapState.empty (.completed .maxTurns 2 none)).2 =
        [.result .maxTurns (some 2) none] := by
  decide

/-! ## Memory -/

/-- Upserting a message whose id the list does not hold appends it. -/
private theorem upsert_fresh (m : Message) :
    ∀ acc : List Message, m.id ∉ acc.map Message.id → upsert m acc = acc ++ [m] := by
  intro acc
  induction acc with
  | nil => intro _; simp [upsert]
  | cons x xs ih =>
    intro h
    simp only [List.map_cons, List.mem_cons, not_or] at h
    have hne : x.id ≠ m.id := fun e => h.1 e.symm
    simp [upsert, hne, ih h.2]

/-- Folding a thread's own messages, each id new, appends them in order. -/
private theorem fold_messages (tid : String) :
    ∀ (msgs acc : List Message) (th : Option String), (msgs.map Message.id).Nodup →
      (∀ m ∈ msgs, m.id ∉ acc.map Message.id) → (∀ m ∈ msgs, m.threadId = tid) →
      fold tid th acc (msgs.map .message) = some (th, acc ++ msgs) := by
  intro msgs
  induction msgs with
  | nil => intro acc th _ _ _; simp [fold]
  | cons m rest ih =>
    intro acc th hnd hfresh hth
    simp only [List.map_cons, List.nodup_cons, List.mem_map, not_exists, not_and] at hnd
    have htm : (m.threadId == tid) = true := by simp [hth m (List.mem_cons_self ..)]
    have hup : upsert m acc = acc ++ [m] := upsert_fresh m acc (hfresh m (List.mem_cons_self ..))
    simp only [List.map_cons, fold, htm, ↓reduceIte, hup]
    have hrest := ih (acc ++ [m]) th (by simpa using hnd.2)
      (fun m' hm' => by
        simp only [List.map_append, List.map_cons, List.map_nil, List.mem_append,
          List.mem_singleton, not_or]
        exact ⟨hfresh m' (List.mem_cons_of_mem _ hm'), fun e => hnd.1 m' hm' e⟩)
      (fun m' hm' => hth m' (List.mem_cons_of_mem _ hm'))
    rw [hrest]
    simp

/-- A thread's messages, each with its own id and all of that thread, journalled into the store
read back as exactly those messages, in order: the round trip a second run's recall rests on. The
store is the platform's engine-scoped stream; no database is involved. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-mastra.md#memory")
  (ts := "packages/engine-mastra/src/session.ts#MastraMemoryJournal")
  (ts := "packages/engine-mastra/src/session.ts#readMastraThread")]
theorem the_thread_round_trips (tid : String) (msgs : List Message)
    (hnd : (msgs.map Message.id).Nodup) (hth : ∀ m ∈ msgs, m.threadId = tid) :
    readThread tid (journal tid msgs) = some msgs := by
  unfold readThread journal
  simp only [fold]
  rw [fold_messages tid msgs [] (some tid) hnd (fun _ _ => by simp) hth]
  simp

/-- Witness: an updated message replaces its first entry; a stream holding another thread's
message, or no record of the thread, is refused. -/
example :
    let m1 : Message := ⟨"m1", "t", "draft"⟩
    let m1' : Message := ⟨"m1", "t", "final"⟩
    let m2 : Message := ⟨"m2", "t", "b"⟩
    readThread "t" (journal "t" [m1, m2] ++ [.message m1']) = some [m1', m2] ∧
      readThread "t" (journal "t" [m1, ⟨"x", "other", "y"⟩]) = none ∧
      readThread "t" [.message m1] = none ∧
      readThread "t" (journal "t" [m1] ++ [.foreign]) = none := by
  decide

end AgentWorkspace.Theorems.Invariants.Mastra
