import AgentWorkspace.Theorems.Refinement.BehaviourRuns

namespace AgentWorkspace.Theorems.Invariants.BehaviourRuns

open AgentWorkspace.Behaviour.Runs

/-- The modeled run projection is exactly the current ER run table joined to its surrounding
rows. It cannot drift into an unrelated, independently carried run list. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/runs.ts#runs")]
theorem er_run_projection (s : State) :
    s.er AgentWorkspace.Er.Core.TableName.runs =
      s.erBase AgentWorkspace.Er.Core.TableName.runs ++ s.runs.map RunRow.toErRow := by
  simp [State.er]

/-- A created run names the authenticated workspace, leaving every foreign projected row alone. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/api.ts#startRun")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
theorem start_preserves_foreign (s : State) (p : Principal) (r : Request) :
    (startState s p r).foreignRuns p.workspaceId = s.foreignRuns p.workspaceId := by
  simp [startState, State.foreignRuns]

/-- The inserted row is attributed to the authenticated principal and to the session returned
by the session-resolution seam, not to an arbitrary owner or the raw agent id. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/api.ts#startRun")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
theorem start_records_owner_and_session (s : State) (p : Principal) (r : Request) :
    ((startState s p r).runs.head?.map (fun row => (row.ownerId, row.sessionId))) =
      some (p.id, r.newSessionId) := by
  simp [startState]

/-- The interrupt update checks both run identity and workspace. Even an abstract state with
same-id rows from two workspaces leaves the foreign row unchanged. -/
private theorem map_interrupt_preserves_foreign (xs : List RunRow) (id ws : String)
    (changed : RunRow) (hchanged : changed.workspaceId = ws) :
    (xs.map (fun x => if x.id == id && x.workspaceId == ws then changed else x)).filter
      (fun x => x.workspaceId != ws) = xs.filter (fun x => x.workspaceId != ws) := by
  induction xs with
  | nil => rfl
  | cons x rest ih =>
    by_cases hws : x.workspaceId = ws
    · by_cases hid : x.id = id
      · simpa [List.map_cons, List.filter_cons, hws, hid, hchanged] using ih
      · simpa [List.map_cons, List.filter_cons, hws, hid] using ih
    · simpa [List.map_cons, List.filter_cons, hws] using ih

/-- Interrupt changes only a run in the caller's workspace, including when abstract rows reuse an id. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/api.ts#interruptRun")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
theorem interrupt_preserves_foreign (s : State) (p : Principal) (row : RunRow)
    (hrow : row.workspaceId = p.workspaceId) :
    (interruptState s p row).foreignRuns p.workspaceId = s.foreignRuns p.workspaceId := by
  let lifecycle := AgentWorkspace.Lifecycle.runActions row.lifecycle
    (AgentWorkspace.Lifecycle.interruptActions 1)
  let changed : RunRow := { row with lifecycle }
  have hc : changed.workspaceId = p.workspaceId := by simp [changed, hrow]
  simpa [interruptState, State.foreignRuns, changed] using
    (map_interrupt_preserves_foreign s.runs row.id p.workspaceId changed hc)

private theorem found_workspace (s : State) (p : Principal) (id : String) (row : RunRow)
    (h : found s p id = some row) : row.workspaceId = p.workspaceId := by
  have hp := List.find?_some (show s.runs.find?
    (fun r => r.id == id && r.workspaceId == p.workspaceId) = some row from h)
  simp at hp
  exact hp.2

/-- Each of the seven route branches either leaves the run projection alone, creates a run in
the caller's workspace, or interrupts a row established by the workspace-filtered lookup. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/api.ts#startRun")
  (ts := "apps/web/server/runs/api.ts#findRunForPrincipal")
  (ts := "apps/web/server/runs/api.ts#interruptRun")]
theorem every_route_preserves_foreign (s : State) (p : Principal) (r : Request) :
    (step s p r).state.foreignRuns p.workspaceId = s.foreignRuns p.workspaceId := by
  simp only [step, Id.run, pure, finishReply]
  repeat (first | split | simp_all [start_preserves_foreign])
  all_goals first
    | (apply interrupt_preserves_foreign; apply found_workspace; assumption)
    | simp_all

/-- Current-schema transactions either pass every constraint or leave a consistent pre-state
unchanged. The repository applies this check at write/commit, not after a read or stream. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/repositories/runs.ts#finish")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem committed_run_write_preserves_er (s : State)
    (tx : List AgentWorkspace.Er.Current.Stmt)
    (h : AgentWorkspace.Er.Current.consistent s.er = true) :
    AgentWorkspace.Er.Current.consistent
      (AgentWorkspace.Er.Current.commit AgentWorkspace.Er.Current.consistent s.er tx) = true := by
  unfold AgentWorkspace.Er.Current.commit
  split <;> simp_all

/-- The HTTP envelope does not contain gateway or browser credential keys. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/api.ts#renderRun")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
theorem response_excludes_credential_keys (reply : Reply) :
    "tokenSecret" ∉ reply.allKeys ∧ "tokenHash" ∉ reply.allKeys := by
  simp [Reply.allKeys, Reply.publicKeys, runResourceKeys]
  split <;> decide

end AgentWorkspace.Theorems.Invariants.BehaviourRuns
