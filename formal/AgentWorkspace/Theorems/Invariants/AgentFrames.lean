import AgentWorkspace.Events.AgentFrames

/-!
# T2 — the invariants of the neutral event stream (ENG-03, #302)

Three, and each is a promise a consumer is allowed to rely on:

1. **nothing is dropped** — every engine message reaches at least one frame;
2. **tool results are paired** — a result frame only ever answers a call the stream already
   announced;
3. **resume is exact** — the `(sequence, sub-index)` ids are strictly increasing, and resuming at one
   of them neither loses a frame nor repeats one.
-/

namespace AgentWorkspace.Theorems.Invariants.AgentFrames

open AgentWorkspace AgentWorkspace.Events.AgentFrames

/-! ## 1. Nothing is dropped -/

/-- The fallback is what makes the guarantee structural rather than a property of nine branches. -/
private theorem nonEmptyOr_ne_nil (fallback : Frame) (frames : List Frame) :
    nonEmptyOr fallback frames ≠ [] := by
  cases frames with
  | nil => simp [nonEmptyOr]
  | cons _ _ => simp [nonEmptyOr]

/-- **Every classified engine message maps to at least one neutral frame.**

There is no input for which `toAgentFrames` answers nothing: a message the neutral vocabulary cannot
express becomes `agent.native`, and one that could not be parsed becomes `agent.malformed`. This is
the guarantee the runner's writer relies on without re-checking, and the reason the closed frame set
is safe to close. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#63-the-neutral-event-vocabulary")
  (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
theorem never_drops_an_engine_message (classified : Classified) :
    toAgentFrames classified ≠ [] :=
  nonEmptyOr_ne_nil _ _

/-- The fallback of an unmapped message names the engine's own message, so nothing is lost when the
neutral vocabulary has nothing to say about it. -/
@[aw_spec (tier := T2) (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
theorem unmapped_message_is_carried_natively (classified : Classified)
    (h : mappedFrames classified = []) :
    toAgentFrames classified = [fallbackFrame classified] := by
  simp [toAgentFrames, h, nonEmptyOr]

/-- Witnesses: a `system` subtype with no neutral meaning, an unrecognised top-level type and a
message that carried neither prose nor a tool block all reach `agent.native`; an unparseable event
reaches `agent.malformed`. -/
example :
    toAgentFrames (.system "status" (.obj [("type", .str "system")])) =
      [.native "system/status" (.obj [("type", .str "system")])] ∧
    toAgentFrames (.unknown "telepathy" (.obj [("type", .str "telepathy")])) =
      [.native "telepathy" (.obj [("type", .str "telepathy")])] ∧
    toAgentFrames (.event "user"
      (.obj [("message", .obj [("content", .arr [.obj [("type", .str "image")]])])])) =
      [.native "user"
        (.obj [("message", .obj [("content", .arr [.obj [("type", .str "image")]])])])] ∧
    toAgentFrames (.malformed "an SDK event must be an object; got the string \"nope\""
        (.str "nope")) =
      [.malformed "an SDK event must be an object; got the string \"nope\""] := by decide +kernel

/-! ## 2. Tool results are paired -/

private theorem mapped_calls_are_calls (xs : List (String × String × JValue)) :
    (xs.map callFrame).all Frame.isToolCall = true := by
  induction xs with
  | nil => simp
  | cons _ _ ih => simp [callFrame, Frame.isToolCall, ih]

private theorem mapped_results_are_results (xs : List (String × String × Bool)) :
    (xs.map resultFrame).all Frame.isToolResult = true := by
  induction xs with
  | nil => simp
  | cons _ _ ih => simp [resultFrame, Frame.isToolResult, ih]

/-- **A call frame can only come from an assistant turn, and a result frame only from a user turn.**

This is what makes the pairing invariant hold across a whole run without the mapping remembering
anything: the Claude Agent SDK carries a `tool_use` block on the assistant's message and the matching
`tool_result` on the *following* user message, so the frame announcing a `toolCallId` is always
emitted before the frame answering it. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#63-the-neutral-event-vocabulary")
  (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
theorem tool_frames_follow_the_turn_that_can_carry_them (items : List JValue) :
    (toolFrames "assistant" (some (.arr items))).all Frame.isToolCall = true ∧
    (toolFrames "user" (some (.arr items))).all Frame.isToolResult = true := by
  refine ⟨?_, ?_⟩
  · simpa [toolFrames] using mapped_calls_are_calls (items.filterMap toolCallData)
  · simpa [toolFrames] using mapped_results_are_results (items.filterMap toolResultData)

/-- A turn that is neither the assistant's nor the user's carries no tool frame at all. -/
@[aw_spec (tier := T2) (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
theorem no_tool_frames_from_another_role (items : List JValue) :
    toolFrames "system" (some (.arr items)) = [] := by
  simp [toolFrames]

/-- The witness the invariant is about: one real exchange — an assistant turn making two calls, then
the user turn answering one of them — maps to a **paired** sequence. -/
example :
    paired (toAgentFrames (.event "assistant"
        (.obj [("message", .obj [("id", .str "msg_1"),
          ("content", .arr [
            .obj [("type", .str "text"), ("text", .str "Reading.")],
            .obj [("type", .str "tool_use"), ("id", .str "tool_1"), ("name", .str "Read")],
            .obj [("type", .str "tool_use"), ("id", .str "tool_2"), ("name", .str "Bash")]])])])) ++
      toAgentFrames (.event "user"
        (.obj [("uuid", .str "u-1"),
          ("message", .obj [("content", .arr [
            .obj [("type", .str "tool_result"), ("tool_use_id", .str "tool_1"),
              ("content", .str "ok")]])])]))) = true := by decide +kernel

/-- And the checker is not vacuous: a result whose call was never announced is **not** paired. -/
example : paired [.toolResult "tool_9" .completed "ok" false] = false := by decide +kernel

/-! ## 3. Resume is exact -/

/-- **Resuming inside a row neither loses a frame nor repeats one.**

A client that last saw `<sequence>.<i>` is re-served that whole row — the store seeks by row and
cannot deliver half of one — and given only the frames after `i`. Concatenating what it already had
with what it is served back reconstructs the row exactly once. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/site/guides/streaming.mdx#resuming-with-after-and-last-event-id")
  (ts := "apps/web/server/runs/agent-frames.ts#upgradeEventStream")]
theorem resume_within_row_loses_and_repeats_nothing {α : Type} (sequence i : Nat)
    (served : List α) :
    served.take (i + 1) ++ resumeWithinRow (some (sequence, i)) sequence true served = served := by
  simp [resumeWithinRow]

/-- A cursor naming another row's sequence serves that row whole: a cursor into a row the store can
no longer retain has already produced a `stream-reset`, and the oldest retained row is then new to
the client in its entirety. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/agent-frames.ts#upgradeEventStream")]
theorem resume_serves_a_different_row_whole {α : Type} (cursorSequence i sequence : Nat)
    (subIndexed : Bool) (served : List α) (h : ¬ cursorSequence = sequence) :
    resumeWithinRow (some (cursorSequence, i)) sequence subIndexed served = served := by
  simp [resumeWithinRow, h]

/-- A sub-indexed cursor naming a row that was served **one-to-one** serves that row whole.

The server never writes such an id — only an upgraded legacy row is served in parts — so the cursor
is stale or forged; the row is delivered rather than dropped on the strength of a position it does
not have, the same "reported, not guessed" answer the rest of the read path gives. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/agent-frames.ts#upgradeEventStream")]
theorem resume_serves_a_one_to_one_row_whole {α : Type} (sequence i : Nat) (served : List α) :
    resumeWithinRow (some (sequence, i)) sequence false served = served := by
  simp [resumeWithinRow]

/-- The positions a row's frames are served under are `0, 1, …`, so the ids inside one row are
strictly increasing by construction. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/agent-frames.ts#wireEventId")]
theorem row_positions_are_a_range {α : Type} (xs : List α) :
    (indexed xs).map Prod.fst = List.range xs.length := by
  rw [indexed, List.map_fst_zip]
  simp

private theorem idsIncreasing_range' (s : Nat) :
    ∀ (n k : Nat), idsIncreasing ((List.range' k n).map fun i => (s, some i)) = true
  | 0, _ => rfl
  | 1, _ => rfl
  | n + 2, k => by
    have ih := idsIncreasing_range' s (n + 1) (k + 1)
    simp only [List.range'_succ, List.map_cons] at ih ⊢
    show (idBefore (s, some k) (s, some (k + 1)) && idsIncreasing _) = true
    rw [ih]
    simp [idBefore]

/-- **A row's frames are served in the order the mapping emitted them, under ascending ids.**

The served frames are exactly the frames `toAgentFrames` produced (capped at the grammar's bound),
in its order; the sub-indices are `0, 1, …` in that same order; and the ids are strictly increasing.
This is the general form of `engine_message_fans_out_in_order`. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/agent-frames.ts#upgradeStoredEvent")
  (ts := "apps/web/server/runs/agent-frames.ts#wireEventId")]
theorem served_frames_keep_emission_order (systemSubtypes resultSubtypes eventTypes : List String)
    (sequence : Nat) (data : JValue) :
    (serveLegacyRow systemSubtypes resultSubtypes eventTypes sequence data).map Prod.snd =
      capRowFrames (upgradeLegacy systemSubtypes resultSubtypes eventTypes data) ∧
    (serveLegacyRow systemSubtypes resultSubtypes eventTypes sequence data).map Prod.fst =
      (List.range (capRowFrames
        (upgradeLegacy systemSubtypes resultSubtypes eventTypes data)).length).map
        (fun i => (sequence, some i)) ∧
    idsIncreasing
      ((serveLegacyRow systemSubtypes resultSubtypes eventTypes sequence data).map Prod.fst) =
      true := by
  have hsnd : ∀ (xs : List Frame),
      ((indexed xs).map fun (p : Nat × Frame) => ((sequence, some p.1), p.2)).map Prod.snd =
        xs := by
    intro xs
    simp [indexed, List.map_map, Function.comp_def, List.map_snd_zip]
  have hfst : ∀ (xs : List Frame),
      ((indexed xs).map fun (p : Nat × Frame) => ((sequence, some p.1), p.2)).map Prod.fst =
        (List.range xs.length).map (fun i => (sequence, some i)) := by
    intro xs
    have h := row_positions_are_a_range xs
    rw [← h, List.map_map, List.map_map]
    rfl
  refine ⟨hsnd _, hfst _, ?_⟩
  rw [serveLegacyRow, hfst, List.range_eq_range']
  exact idsIncreasing_range' sequence _ 0

/-- **Every served id fits the documented grammar**: a row serves at most `maxFramesPerRow` frames,
so a sub-index never needs a fourth digit, whatever a tenant's agent put in one turn. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/agent-frames.ts#MAX_FRAMES_PER_ROW")]
theorem a_row_serves_at_most_the_grammar_bound (frames : List Frame) :
    (capRowFrames frames).length ≤ maxFramesPerRow ∧
    (frames.length ≤ maxFramesPerRow → capRowFrames frames = frames) := by
  refine ⟨?_, fun h => by simp [capRowFrames, h]⟩
  unfold capRowFrames
  split
  · assumption
  · simp only [List.length_append, List.length_take, List.length_singleton, maxFramesPerRow]
    omega

/-- A mixed log — the platform's own event, an upgraded legacy row serving three frames, then a frame
a post-ENG-03 run wrote — is served under strictly increasing `(sequence, sub-index)` ids. -/
example :
    idsIncreasing [(1, none), (2, some 0), (2, some 1), (2, some 2), (3, none)] = true ∧
    idsIncreasing [(2, some 1), (2, some 0)] = false ∧
    idsIncreasing [(3, none), (2, some 0)] = false := by decide +kernel

/-- And the ids are rendered under the documented grammar. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/agent-frames.ts#wireEventId")]
theorem wire_ids_follow_the_documented_grammar :
    wireEventId 41 none = "41" ∧
    wireEventId 41 (some 0) = "41.0" ∧
    wireEventId 41 (some 7) = "41.7" := by decide +kernel

end AgentWorkspace.Theorems.Invariants.AgentFrames
