import AgentWorkspace.Behaviour.Runs

namespace AgentWorkspace.Theorems.Normative.BehaviourRuns

open AgentWorkspace.Behaviour.Runs

def owner : Principal :=
  { id := "owner", workspaceId := "w1", role := "owner" }

def builder : Principal :=
  { owner with role := "builder" }

def queued : RunRow :=
  { id := "run", workspaceId := "w1", ownerId := "owner", sessionId := "se1" }

def fixture : State := { runs := [queued] }

def request (route : Route) : Request := { route, id := "run" }

/-- R-1 accepts a run into the queue and returns the events location. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#startRun")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
theorem start_accepted :
    (step fixture owner (request .start)).reply =
      { status := 202, bodyKind := "start" } := by decide +kernel

/-- R-2 returns the list envelope, with a mandatory owner filter for an own grant. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#listRuns")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
theorem list_forces_owner :
    (step fixture builder (request .list)).reply.ownerFilter = some "owner" := by decide +kernel

/-- R-3 conceals a run in another workspace as `run_not_found`. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#readRun")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
theorem read_foreign_is_not_found :
    (step fixture { owner with workspaceId := "other" } (request .read)).reply =
      problem 404 "run_not_found" := by decide +kernel

/-- R-4 and R-5 share the same revocation handler and outcome. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#revokeRunTokens")]
theorem revoke_alias_agrees :
    (step fixture owner (request .revokeAlias)).reply =
      (step fixture owner (request .revoke)).reply := by decide +kernel

/-- R-6 rejects an invalid resume cursor before exposing row existence. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#streamRunEvents")]
theorem stream_cursor_precedes_lookup :
    (step {} owner { (request .stream) with id := "missing", cursorValid := false }).reply =
      problem 400 "invalid_resume_cursor" := by decide +kernel

/-- R-7 rejects an already terminal run. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#interruptRun")]
theorem terminal_interrupt_conflicts :
    (step { runs := [{ queued with lifecycle := { status := .completed } }] }
      owner (request .interrupt)).reply = problem 409 "run_not_interruptible" := by decide +kernel

/-- The list parser checks limit before cursor and the remaining filters in their source order. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/list-query.ts#parseRunListQuery")]
theorem list_limit_precedes_cursor :
    listQueryError { (request .list) with limitValid := false, listCursorValid := false }
      owner = some (problem 400 "invalid_limit") := by decide +kernel

/-- A caller with an own grant cannot request another user's runs even when the UUID is valid. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/list-query.ts#parseRunListQuery")]
theorem list_user_filter_denied :
    listQueryError { (request .list) with userFilter := true } builder =
      some (problem 403 "user_filter_forbidden") := by decide +kernel

/-- The handler's bespoke gate admits Admin revocation without a `decide()` call. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#revokeRunTokens")]
theorem admin_revoke_allowed :
    (step fixture { owner with role := "admin" } (request .revoke)).reply.status = 200 := by decide +kernel

/-- Configuration and authentication checks precede all route-specific validation. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#startRun")
  (ts := "apps/web/server/runs/api.ts#readRun")]
theorem common_problem_precedence :
    (step fixture owner { (request .start) with configured := false, authenticated := false, pathValid := false }).reply =
        problem 503 "run_api_not_configured" ∧
    (step fixture owner { (request .read) with authenticated := false, pathValid := false }).reply = problem 401 "unauthenticated" := by decide +kernel

/-- R-1 validates the path before role permission, then body, scope, agent and session. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#startRun")]
theorem start_problem_codes :
    (step fixture { owner with role := "viewer" }
      { (request .start) with ownership := .other }).reply = problem 403 "forbidden" ∧
    (step fixture { owner with role := "builder" }
      { (request .start) with pathValid := false }).reply = problem 400 "invalid_agent_id" ∧
    (step fixture { owner with role := "viewer" }
      { (request .start) with pathValid := false }).reply = problem 400 "invalid_agent_id" ∧
    (step fixture owner { (request .start) with pathValid := false, bodyValid := false }).reply = problem 400 "invalid_agent_id" ∧
    (step fixture owner { (request .start) with bodyValid := false, agentFound := false }).reply = problem 400 "invalid_body" ∧
    (step fixture owner { (request .start) with agentFound := false, sessionUsable := false }).reply = problem 404 "agent_not_found" ∧
    (step fixture owner { (request .start) with sessionUsable := false }).reply =
      problem 409 "session_not_usable" := by decide +kernel

/-- R-2 exposes every ordered query-parser error and the user-filter gate. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/list-query.ts#parseRunListQuery")]
theorem list_problem_codes :
    listQueryError { (request .list) with limitValid := false } owner =
      some (problem 400 "invalid_limit") ∧
    listQueryError { (request .list) with listCursorValid := false } owner =
      some (problem 400 "invalid_cursor") ∧
    listQueryError { (request .list) with statusValid := false } owner =
      some (problem 400 "invalid_status") ∧
    listQueryError { (request .list) with agentValid := false } owner =
      some (problem 400 "invalid_agent") ∧
    listQueryError { (request .list) with projectValid := false } owner =
      some (problem 400 "invalid_project") ∧
    listQueryError { (request .list) with providerValid := false } owner =
      some (problem 400 "invalid_provider") ∧
    listQueryError { (request .list) with modelValid := false } owner =
      some (problem 400 "invalid_model") ∧
    listQueryError { (request .list) with fromValid := false } owner =
      some (problem 400 "invalid_from") ∧
    listQueryError { (request .list) with toValid := false } owner =
      some (problem 400 "invalid_to") ∧
    listQueryError { (request .list) with dateRangeValid := false } owner =
      some (problem 400 "invalid_date_range") ∧
    listQueryError { (request .list) with userFilter := true, userValid := false } builder = some (problem 403 "user_filter_forbidden") ∧
    listQueryError { (request .list) with userFilter := true, userValid := false } owner = some (problem 400 "invalid_user") := by decide +kernel

/-- R-3 reads only workspace-visible rows and checks a malformed id first. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#readRun")]
theorem read_problem_codes :
    (step fixture owner { (request .read) with pathValid := false }).reply =
      problem 400 "invalid_run_id" ∧
    (step fixture owner { (request .read) with id := "missing" }).reply =
      problem 404 "run_not_found" ∧
    (step fixture { owner with role := "viewer" }
      { (request .read) with ownership := .other }).reply = problem 403 "forbidden" := by decide +kernel

/-- R-5's independent role gate precedes path and body parsing. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#revokeRunTokens")]
theorem revoke_problem_codes :
    (step fixture builder { (request .revoke) with pathValid := false }).reply =
      problem 403 "run_token_revoke_forbidden" ∧
    (step fixture owner { (request .revoke) with pathValid := false }).reply =
      problem 400 "invalid_run_id" ∧
    (step fixture owner { (request .revoke) with id := "missing" }).reply =
      problem 404 "run_not_found" ∧
    (step fixture owner { (request .revoke) with bodyValid := false, tokenIdValid := false }).reply = problem 400 "invalid_body" ∧
    (step fixture owner { (request .revoke) with tokenIdValid := false }).reply =
      problem 400 "invalid_token_id" := by decide +kernel

/-- R-6's cursor error is evaluated before lookup, and a missing subscription is 404. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#streamRunEvents")]
theorem stream_problem_codes :
    (step fixture owner { (request .stream) with pathValid := false, cursorValid := false }).reply = problem 400 "invalid_run_id" ∧
    (step fixture owner { (request .stream) with cursorValid := false, id := "missing" }).reply = problem 400 "invalid_resume_cursor" ∧
    (step fixture owner { (request .stream) with streamOpens := false }).reply =
      problem 404 "run_not_found" := by decide +kernel

/-- R-7 rejects invalid ids, absent runs and terminal runs before effect execution. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#interruptRun")]
theorem interrupt_problem_codes :
    (step fixture owner { (request .interrupt) with pathValid := false }).reply =
      problem 400 "invalid_run_id" ∧
    (step fixture owner { (request .interrupt) with id := "missing" }).reply =
      problem 404 "run_not_found" ∧
    (step fixture { owner with role := "viewer" }
      { (request .interrupt) with ownership := .other }).reply = problem 403 "forbidden" := by decide +kernel

/-- Scope refusal is observable before row effects and uses the same stable problem code. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#requireSessionScopeMatch")
  (ts := "apps/web/server/runs/api.ts#revokeRunTokens")]
theorem scoped_problem_codes :
    (step fixture { owner with scope := some (.run ⟨"run"⟩) } (request .start)).reply =
      problem 403 "token_out_of_scope" ∧
    (step fixture { owner with scope := some (.session ⟨"other"⟩) }
      (request .read)).reply = problem 403 "token_out_of_scope" ∧
    (step fixture { owner with scope := some (.run ⟨"run"⟩) }
      (request .revoke)).reply = problem 403 "token_out_of_scope" ∧
    (step fixture { owner with scope := some (.run ⟨"run"⟩) }
      (request .interrupt)).reply = problem 403 "token_out_of_scope" := by decide +kernel

/-- The all-token callback reports the three documented outcomes without changing the envelope. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#revokeRunTokens")
  (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")]
theorem revoke_outcomes :
    (step fixture owner (request .revoke)).reply.revokeOutcome = some "revoked" ∧
    (step fixture owner { (request .revoke) with revokeCount := 0 }).reply.revokeOutcome =
      some "already-revoked" ∧
    (step fixture owner { (request .revoke) with tokenFound := false, revokeCount := 0 }).reply.revokeOutcome =
      some "not-found" := by decide +kernel

/-- A successful interrupt changes the same row the response re-reads to cancelled. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#interruptRun")
  (ts := "apps/web/server/runs/api.ts#renderRun")]
theorem interrupt_success_poststate :
    ((step fixture owner (request .interrupt)).state.runs.head?.map
      (fun row => row.lifecycle.status)) = some .cancelled ∧
    ((step fixture owner (request .interrupt)).state.runs.head?.map
      (fun row => row.lifecycle.runTokenRevoked)) = some true ∧
    ((step fixture owner (request .interrupt)).state.runs.head?.map
      (fun row => row.lifecycle.browserTokenRevoked)) = some true := by decide +kernel

/-- Storage and control-plane callback failures reach the route adapter's 500 boundary. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#startRun")
  (ts := "apps/web/server/runs/api.ts#listRuns")
  (ts := "apps/web/server/runs/api.ts#revokeRunTokens")
  (ts := "apps/web/server/runs/api.ts#streamRunEvents")
  (ts := "apps/web/server/runs/api.ts#interruptRun")]
theorem effect_failures_map_to_internal_error :
    (step fixture owner { (request .start) with effectFails := true }).reply =
      problem 500 "internal_error" ∧
    (step fixture owner { (request .list) with effectFails := true }).reply =
      problem 500 "internal_error" ∧
    (step fixture owner { (request .revoke) with effectFails := true }).reply =
      problem 500 "internal_error" ∧
    (step fixture owner { (request .stream) with effectFails := true }).reply =
      problem 500 "internal_error" ∧
    (step fixture owner { (request .interrupt) with effectFails := true }).reply =
      problem 500 "internal_error" := by decide +kernel

end AgentWorkspace.Theorems.Normative.BehaviourRuns
