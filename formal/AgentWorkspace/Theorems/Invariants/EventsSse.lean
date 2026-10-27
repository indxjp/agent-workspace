import AgentWorkspace.Events.RunLog
import AgentWorkspace.Events.Resume

namespace AgentWorkspace.Theorems.Invariants.EventsSse

open AgentWorkspace AgentWorkspace.Events

/-- Every successful append allocates the next sequence number, independent of retention. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")
  (ts := "apps/web/server/runs/memory-store.ts#RunEventLog")]
theorem append_allocates_next_id (limit : Nat) (log next : RunLog.Log) (event : RunLog.Event)
    (name : String) (data : JValue)
    (h : RunLog.append limit log name data = some (next, event)) :
    event.id = log.lastId + 1 ∧ next.lastId = event.id := by
  unfold RunLog.append at h
  split at h
  · cases h
  · cases h
    exact ⟨rfl, rfl⟩

/-- Successful append keeps exactly the newest `limit` rows of the previous retained log plus
the new event. This states the retention suffix, not merely its size. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/memory-store.ts#RunEventLog")]
theorem append_retains_newest_suffix (limit : Nat) (log next : RunLog.Log)
    (event : RunLog.Event) (name : String) (data : JValue)
    (h : RunLog.append limit log name data = some (next, event)) :
    next.retained = (log.retained ++ [event]).drop ((log.retained.length + 1) - limit) := by
  unfold RunLog.append at h
  split at h
  · cases h
  · cases h
    rfl

/-- A closed event log refuses every subsequent append. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")
  (ts := "apps/web/server/runs/memory-store.ts#RunEventLog")]
theorem closed_log_refuses_append (limit : Nat) (log : RunLog.Log) (name : String)
    (data : JValue) : RunLog.append limit (RunLog.close log) name data = none := by
  simp [RunLog.append, RunLog.close]

/-- Resume selects only retained events strictly later than the cursor. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#resuming")
  (ts := "apps/web/server/runs/memory-store.ts#RunEventLog")]
theorem pending_is_strictly_after (log : RunLog.Log) (cursor : Nat)
    (event : RunLog.Event) (h : event ∈ RunLog.pending log cursor) :
    event.id > cursor := by
  simpa using (List.mem_filter.mp h).2

/-- The in-memory stream cannot end before its cursor reaches the latest produced event. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")
  (ts := "apps/web/server/runs/memory-store.ts#RunEventLog")]
theorem memory_follow_does_not_skip_tail (log : RunLog.Log) (cursor : Nat)
    (h : RunLog.memoryMayEnd log cursor = true) : cursor ≥ log.lastId := by
  by_cases hc : cursor ≥ log.lastId
  · exact hc
  · simp [RunLog.memoryMayEnd, hc] at h

/-- Catching up to the latest id is insufficient while the run remains open. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/memory-store.ts#RunEventLog")]
theorem memory_follow_waits_for_terminal (log : RunLog.Log) (cursor : Nat)
    (h : RunLog.memoryMayEnd log cursor = true) : log.closed = true := by
  by_cases hc : log.closed = true
  · exact hc
  · simp [RunLog.memoryMayEnd, hc] at h

/-- An invalid present header cannot be replaced by a valid query cursor. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/cursor.ts#readResumeCursor")]
theorem invalid_header_blocks_query_fallback (header query : String)
    (h : Resume.parseFrameId header = none) :
    Resume.readResumeCursor (some header) (some query) = .invalid .header := by
  simp [Resume.readResumeCursor, h]

example : ∃ next event, RunLog.append 2 RunLog.empty "system" (.obj []) = some (next, event) :=
  ⟨_, _, rfl⟩

example : RunLog.pending ⟨2, [⟨1, "system", .null⟩, ⟨2, "result", .null⟩], true⟩ 1 =
    [⟨2, "result", .null⟩] := by decide +kernel

end AgentWorkspace.Theorems.Invariants.EventsSse
