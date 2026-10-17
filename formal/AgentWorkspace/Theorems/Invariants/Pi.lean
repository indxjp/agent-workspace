import AgentWorkspace.Behaviour.Engines.Pi

/-!
# T2 — the pi event mapping, turn limit and session (ENG-08, #307)

* **Nothing is dropped.** Every pi event becomes at least one frame, and every frame is in the
  closed `agent.*` vocabulary — a neutral frame, `agent.native` or `agent.malformed`.
* **Tool pairing.** In every mapped stream, every `agent.tool.result` names a call an earlier
  `agent.tool.call` announced and no earlier result answered.
* **The turn limit.** The adapter stops at or before `limits.maxTurns`; a `max_turns` stop is at
  the limit; and a run that keeps running tools up to the limit is cut short there and ends with
  `agent.result {stopReason: 'max_turns'}`.
* **The session.** Mirroring a readable pi JSONL tree into the store, a prefix at a time as the
  adapter does at each `turn_end`, rebuilds exactly the file, and importing it back gives the same
  `id`/`parentId` tree.
-/

namespace AgentWorkspace.Theorems.Invariants.Pi

open AgentWorkspace AgentWorkspace.Events.AgentFrames AgentWorkspace.Behaviour.Engines.Pi

/-- Every frame the mapper can produce is in the closed vocabulary. -/
private theorem every_frame_is_neutral (f : Frame) :
    Behaviour.Engines.OpenAiAgents.isNeutral f = true := by
  cases f <;>
    simp [Behaviour.Engines.OpenAiAgents.isNeutral, Behaviour.Engines.OpenAiAgents.frameNames,
      Frame.name]

/-- The mapping never drops an event: each one becomes at least one frame, and every frame is a
neutral frame, `agent.native` or `agent.malformed`. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-pi.md#events")
  (ts := "packages/engine-pi/src/frames.ts#createPiFrameMapper")]
theorem the_mapping_never_drops_an_event (announced : List String) (e : Event) :
    (step announced e).2 ≠ [] ∧
      ∀ f ∈ (step announced e).2, Behaviour.Engines.OpenAiAgents.isNeutral f = true := by
  refine ⟨?_, fun f _ => every_frame_is_neutral f⟩
  cases e with
  | toolStart callId name => cases callId <;> cases name <;> simp [step]
  | toolEnd callId output isError =>
    cases callId <;> cases output <;> simp only [step] <;> (try split) <;> simp
  | assistantEnd id blocks => cases blocks <;> simp [step]
  | completed stop turns usage => simp [step]
  | _ => simp [step]

/-- One event keeps the pairing scan ahead of the mapper: if every call id the mapper holds open
is open in the scan too, and the mapper holds each id once, the same holds after the event, and the
event's frames pass the scan. The scan counts a repeated start twice where the mapper's `Set`
counts it once, so the scan's list is a superset rather than an equal. -/
private theorem paired_step (announced open_ : List String) (e : Event) (rest : List Frame)
    (hnd : announced.Nodup) (hsub : ∀ x ∈ announced, x ∈ open_) :
    ∃ open', (step announced e).1.Nodup ∧ (∀ x ∈ (step announced e).1, x ∈ open') ∧
      Behaviour.Engines.OpenAiAgents.pairedFrom open_ ((step announced e).2 ++ rest) =
        Behaviour.Engines.OpenAiAgents.pairedFrom open' rest := by
  cases e with
  | toolStart callId name =>
    cases callId with
    | none => exact ⟨open_, hnd, hsub, by simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
    | some id =>
      cases name with
      | none =>
        exact ⟨open_, hnd, hsub, by simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
      | some nm =>
        refine ⟨open_ ++ [id], ?_, ?_, ?_⟩
        · simp only [step]
          split
          · exact hnd
          · rename_i hc
            have hnot : id ∉ announced := by simpa using hc
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
  | toolEnd callId output isError =>
    cases callId with
    | none => exact ⟨open_, hnd, hsub, by simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
    | some id =>
      by_cases hmem : id ∈ announced
      · cases output with
        | none =>
          exact ⟨open_, by simpa [step, hmem] using hnd, by simpa [step, hmem] using hsub,
            by simp [step, hmem, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
        | some text =>
          refine ⟨open_.erase id, ?_, ?_, ?_⟩
          · simpa [step, hmem] using hnd.erase id
          · intro x hx
            simp only [step, List.contains_iff_mem, hmem, ↓reduceIte] at hx
            obtain ⟨hne, hx'⟩ := (List.Nodup.mem_erase_iff hnd).mp hx
            exact (List.mem_erase_of_ne hne).mpr (hsub x hx')
          · simp [step, hmem, Behaviour.Engines.OpenAiAgents.pairedFrom, hsub id hmem]
      · exact ⟨open_, by simpa [step, hmem] using hnd, by simpa [step, hmem] using hsub,
          by simp [step, hmem, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
  | assistantEnd id blocks =>
    cases blocks <;>
      exact ⟨open_, hnd, hsub, by simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
  | completed stop turns usage =>
    cases usage <;>
      exact ⟨open_, hnd, hsub, by simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩
  | _ => exact ⟨open_, hnd, hsub, by simp [step, Behaviour.Engines.OpenAiAgents.pairedFrom]⟩

private theorem paired_from (events : List Event) :
    ∀ announced open_, announced.Nodup → (∀ x ∈ announced, x ∈ open_) →
      Behaviour.Engines.OpenAiAgents.pairedFrom open_ (mapFrom announced events) = true := by
  induction events with
  | nil =>
    intro announced open_ _ _
    rw [mapFrom_nil]
    exact Behaviour.Engines.OpenAiAgents.pairedFrom_nil open_
  | cons e rest ih =>
    intro announced open_ hnd hsub
    simp only [mapFrom]
    obtain ⟨open', hnd', hsub', heq⟩ := paired_step announced open_ e (mapFrom _ rest) hnd hsub
    rw [heq]
    exact ih _ open' hnd' hsub'

/-- Tool pairing holds on every mapped stream: every `agent.tool.result` answers a call an earlier
`agent.tool.call` announced and no earlier result answered. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-pi.md#events")
  (ts := "packages/engine-pi/src/frames.ts#createPiFrameMapper")]
theorem tool_pairing_holds (events : List Event) :
    Behaviour.Engines.OpenAiAgents.pairedFrom [] (mapAll events) = true :=
  paired_from events [] [] List.nodup_nil (fun _ h => h)

/-- Witness: a tool result whose call was never announced is `agent.malformed`, not a result; a
blocked call's result is `failed`; a call started twice is answered once, as the TypeScript `Set`
answers it. -/
example :
    mapAll [.toolEnd (some "call_9") (some "x") false] =
        [.malformed "a tool result for a call no tool execution announced"] ∧
      mapAll [.toolStart (some "c1") (some "write"), .toolEnd (some "c1") (some "blocked") true] =
        [.toolCall "c1" "write" .edit .null, .toolResult "c1" .failed "blocked" true] ∧
      mapAll [.toolStart (some "c1") (some "read"), .toolStart (some "c1") (some "read"),
          .toolEnd (some "c1") (some "x") false, .toolEnd (some "c1") (some "x") false] =
        [.toolCall "c1" "read" .read .null, .toolCall "c1" "read" .read .null,
         .toolResult "c1" .completed "x" false,
         .malformed "a tool result for a call no tool execution announced"] := by
  decide

/-! ## The turn limit -/

/-- The adapter never takes more than `limits.maxTurns` turns. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-pi.md#turns")
  (ts := "packages/engine-pi/src/boundary.ts#startPiRun")]
theorem the_run_stops_at_or_before_max_turns (m : Nat) :
    ∀ (turns : List Bool) (n : Nat), n < m → (turnRun (some m) n turns).1 ≤ m := by
  intro turns
  induction turns with
  | nil => intro n hn; simp [turnRun]; all_goals omega
  | cons c rest ih =>
    intro n hn
    cases c
    · simp [turnRun]; all_goals omega
    · by_cases hm : m ≤ n + 1
      · simp [turnRun, hm]; all_goals omega
      · simp only [turnRun, Bool.not_true, Bool.false_eq_true, ↓reduceIte, hm]
        exact ih (n + 1) (by omega)

/-- A run the limit cut short ends `max_turns` exactly at the limit: a `max_turns` stop is never
reported for a run that stopped early. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-pi.md#turns")
  (ts := "packages/engine-pi/src/boundary.ts#startPiRun")
  (ts := "packages/engine-pi/src/frames.ts#createPiFrameMapper")]
theorem a_max_turns_stop_is_at_the_limit (m : Nat) :
    ∀ (turns : List Bool) (n : Nat), n < m →
      (turnRun (some m) n turns).2 = .maxTurns → (turnRun (some m) n turns).1 = m := by
  intro turns
  induction turns with
  | nil => intro n _ h; simp [turnRun] at h
  | cons c rest ih =>
    intro n hn h
    cases c
    · simp [turnRun] at h
    · by_cases hm : m ≤ n + 1
      · simp [turnRun, hm]; all_goals omega
      · simp only [turnRun, Bool.not_true, Bool.false_eq_true, ↓reduceIte, hm] at h ⊢
        exact ih (n + 1) (by omega) h

/-- The converse: a run whose model keeps running tools for every turn up to the limit is cut
short exactly at `limits.maxTurns` and ends `max_turns`, and its terminal event maps to
`agent.result {stopReason: 'max_turns', turns: m}` after the usage. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-pi.md#turns")
  (ts := "packages/engine-pi/src/boundary.ts#startPiRun")
  (ts := "packages/engine-pi/src/frames.ts#createPiFrameMapper")]
theorem a_run_the_limit_cuts_short_ends_max_turns (m : Nat) :
    ∀ (turns : List Bool) (n : Nat), n < m → m - n ≤ turns.length →
      (∀ c ∈ turns.take (m - n), c = true) →
        turnRun (some m) n turns = (m, .maxTurns) ∧
          ∀ (announced : List String) (usage : Option Usage),
            (step announced (.completed (turnRun (some m) n turns).2
                (turnRun (some m) n turns).1 usage)).2 =
              (usage.map Frame.usage).toList ++ [.result .maxTurns (some m) none] := by
  intro turns
  induction turns with
  | nil => intro n hn hlen; simp at hlen; omega
  | cons c rest ih =>
    intro n hn hlen hall
    have hrun : turnRun (some m) n (c :: rest) = (m, .maxTurns) := by
      have hk : m - n = (m - (n + 1)) + 1 := by omega
      rw [hk, List.take_succ_cons] at hall
      have hc : c = true := hall c (List.mem_cons_self ..)
      subst hc
      by_cases hm : m ≤ n + 1
      · have hm' : n + 1 = m := by omega
        simp [turnRun, hm']
      · simp only [turnRun, Bool.not_true, Bool.false_eq_true, ↓reduceIte, hm]
        refine (ih (n + 1) (by omega) ?_ ?_).1
        · simp only [List.length_cons] at hlen; omega
        · exact fun c hc => hall c (List.mem_cons_of_mem _ hc)
    refine ⟨hrun, fun announced usage => ?_⟩
    rw [hrun]
    rfl

/-- Witness: `maxTurns: 2` over an agent that would loop ends after two turns with `max_turns`,
and the terminal event maps to `agent.result {stopReason: 'max_turns', turns: 2}`; an agent that
finishes in one turn ends `end_turn`. -/
example :
    turnRun (some 2) 0 [true, true, true, false] = (2, .maxTurns) ∧
      turnRun (some 2) 0 [false] = (1, .endTurn) ∧
      (step [] (.completed .maxTurns 2 none)).2 = [.result .maxTurns (some 2) none] := by
  decide

/-! ## The session -/

/-- A tree over `a ++ b` is a tree over `a`, then a tree over `b` with `a`'s ids seen. -/
private theorem treeFrom_append (a b : List Line) :
    ∀ seen, treeFrom seen (a ++ b) = (treeFrom seen a && treeFrom (seen ++ a.map Line.id) b) := by
  induction a with
  | nil => intro seen; simp [treeFrom_nil]
  | cons l rest ih =>
    intro seen
    simp only [List.cons_append, treeFrom, ih, List.map_cons, List.append_assoc,
      List.nil_append, Bool.and_assoc]

/-- No line of a tree reuses an id it has already seen. -/
private theorem treeFrom_fresh :
    ∀ (ls : List Line) (seen : List String), treeFrom seen ls = true → ∀ l ∈ ls, l.id ∉ seen := by
  intro ls
  induction ls with
  | nil => intro _ _ l hl; simp at hl
  | cons x rest ih =>
    intro seen h l hl
    simp only [treeFrom, Bool.and_eq_true, Bool.not_eq_true'] at h
    rcases List.mem_cons.mp hl with rfl | hl
    · simpa using h.1.1
    · have := ih _ h.2 l hl
      simp only [List.mem_append, not_or] at this
      exact this.1

/-- The ids of a readable stream never repeat across a split: every line after a prefix of it has
an id no line of the prefix has. -/
private theorem readable_suffix_is_fresh {sid : String} {f₁ f₂ : List Line}
    (hread : readStream sid (f₁ ++ f₂) = some (f₁ ++ f₂)) :
    ∀ l ∈ f₂, l.id ∉ f₁.map Line.id := by
  cases f₁ with
  | nil => intro _ _; simp
  | cons h rest =>
    simp only [List.cons_append, readStream] at hread
    split at hread
    · rename_i hc
      simp only [Bool.and_eq_true, beq_iff_eq] at hc
      obtain ⟨⟨_, hid⟩, ht⟩ := hc
      rw [treeFrom_append] at ht
      simp only [Bool.and_eq_true] at ht
      intro l hl hmem
      have hfresh := treeFrom_fresh f₂ _ ht.2 l hl
      simp only [List.map_cons, List.mem_cons] at hmem
      simp only [List.singleton_append, List.mem_cons, not_or] at hfresh
      rcases hmem with heq | hin
      · exact hfresh.1 (heq.trans hid)
      · exact hfresh.2 hin
    · cases hread

/-- The adapter's session round trip, as it runs: a readable pi session file is mirrored into an
empty store stream by one `persist` of a prefix of it (an earlier `turn_end`) and a second of the
whole grown file, which rebuilds exactly the file — only the new lines are appended — and reading
the stream back gives the same `id`/`parentId` tree. -/
@[aw_spec (tier := T2) (doc := "docs/formal/units/engine-pi.md#session")
  (ts := "packages/engine-pi/src/session.ts#PiSessionMirror")
  (ts := "packages/engine-pi/src/session.ts#readPiStream")]
theorem the_session_tree_round_trips (sid : String) (file f₁ : List Line)
    (hread : readStream sid file = some file) (hpre : f₁ <+: file) :
    persist (persist [] f₁) file = file ∧
      readStream sid (persist (persist [] f₁) file) = some file := by
  have hp : persist (persist [] f₁) file = file := by
    obtain ⟨f₂, rfl⟩ := hpre
    have hfresh := readable_suffix_is_fresh hread
    have h0 : persist [] f₁ = f₁ := by simp [persist]
    rw [h0]
    simp only [persist, List.filter_append]
    have hdrop : f₁.filter (fun l => !(f₁.map Line.id).contains l.id) = [] := by
      rw [List.filter_eq_nil_iff]
      intro l hl
      simpa using List.mem_map_of_mem (f := Line.id) hl
    have hkeep : f₂.filter (fun l => !(f₁.map Line.id).contains l.id) = f₂ := by
      rw [List.filter_eq_self]
      intro l hl
      simpa using hfresh l hl
    rw [hdrop, hkeep, List.nil_append]
  exact ⟨hp, by rw [hp, hread]⟩

/-- Witness: a branched tree (`a → b`, `a → c`) round-trips and reads back; a second persist of the
grown file appends only the new line; a stream with a dangling parent is refused. -/
example :
    let header : Line := ⟨"session", "s1", none⟩
    let a : Line := ⟨"model_change", "a", none⟩
    let b : Line := ⟨"message", "b", some "a"⟩
    let c : Line := ⟨"message", "c", some "a"⟩
    let d : Line := ⟨"message", "d", some "c"⟩
    readStream "s1" (persist [] [header, a, b, c]) = some [header, a, b, c] ∧
      persist [header, a, b, c] [header, a, b, c, d] = [header, a, b, c, d] ∧
      readStream "s1" [header, ⟨"message", "z", some "nowhere"⟩] = none ∧
      readStream "s2" [header, a] = none := by
  decide

end AgentWorkspace.Theorems.Invariants.Pi
