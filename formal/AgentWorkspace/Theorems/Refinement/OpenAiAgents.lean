import AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-!
# T4 — the adapter's `Session` refines the engine-scoped store (ENG-09, #308)

The OpenAI Agents SDK's `Session` is, semantically, a list of items: `getItems` reads it,
`addItems` appends, `popItem` removes and returns the last, `clearSession` empties it. The adapter
implements it over the store's four operations — list, append, delete-last and replace-all — with
every item wrapped under its own entry type. The refinement: on a stream the adapter wrote, each
session operation is exactly the list operation, through the abstraction that unwraps the entries.
-/

namespace AgentWorkspace.Theorems.Refinement.OpenAiAgents

open AgentWorkspace AgentWorkspace.Behaviour.Engines.OpenAiAgents

private theorem mapM_unwrap {α : Type} (s : List (Entry α)) (h : adapterWritten s) :
    s.mapM unwrap = some (s.map Entry.item) := by
  induction s with
  | nil => rfl
  | cons e rest ih =>
    have he : e.type = entryType := h e (by simp)
    have hr : adapterWritten rest := fun x hx => h x (by simp [hx])
    simp [List.mapM_cons, unwrap, he, ih hr]

private theorem written_append {α : Type} (s : List (Entry α)) (items : List α)
    (h : adapterWritten s) : adapterWritten (s ++ items.map wrap) := by
  intro e he
  simp only [List.mem_append, List.mem_map] at he
  rcases he with he | ⟨a, _, rfl⟩
  · exact h e he
  · rfl

/-- The adapter's `Session` refines the store: on a stream it wrote, `getItems` lists the items,
`addItems` appends them, `popItem` returns and removes the last, and `clearSession` replaces the
stream with nothing — each through the store's list, append, delete-last and replace-all. -/
@[aw_spec (tier := T4) (doc := "docs/formal/units/engine-openai-agents.md#session")
  (ts := "packages/engine-openai-agents/src/session.ts#EngineStoreSession")
  (ts := "packages/engine/src/port.ts#EngineSessionStore")]
theorem the_session_refines_the_store {α : Type} (s : List (Entry α)) (items : List α)
    (h : adapterWritten s) :
    getItems s none = some (abstraction s).items ∧
      (abstraction (addItems s items)).items = (abstraction s).items ++ items ∧
      adapterWritten (addItems s items) ∧
      (popItem s).1 = (abstraction s).items.getLast? ∧
      (abstraction (popItem s).2).items = (abstraction s).items.dropLast ∧
      (abstraction (clearSession s)).items = [] := by
  have hget : getItems s none = some (s.map Entry.item) := by
    simp [getItems, Store.list, mapM_unwrap s h]
  refine ⟨hget, ?_, ?_, ?_, ?_, rfl⟩
  · unfold addItems
    split
    · rename_i hi
      simp [List.isEmpty_iff.mp hi, abstraction]
    · simp [Store.append, abstraction, List.map_map, Function.comp_def, wrap]
  · unfold addItems
    split
    · exact h
    · exact written_append s items h
  · unfold popItem
    rw [hget]
    simp only [Option.bind_some, abstraction]
    split
    · simp_all
    · rename_i last heq
      simp only [List.getLast?_map] at heq ⊢
      exact heq.symm
  · unfold popItem
    rw [hget]
    simp only [Option.bind_some, abstraction]
    split
    · rename_i hnone
      have : s = [] := by
        have := List.getLast?_eq_none_iff.mp hnone
        simpa using this
      simp [this]
    · simp [Store.deleteLast, List.map_dropLast]

/-- Witness: two runs on one stream — the second run's `getItems` sees the first run's items. -/
example :
    let first := addItems ([] : List (Entry String)) ["user: read a.md", "assistant: done"]
    getItems (addItems first ["user: again"]) none =
      some ["user: read a.md", "assistant: done", "user: again"] := by decide

end AgentWorkspace.Theorems.Refinement.OpenAiAgents
