import AgentWorkspace.Theorems.WellFormed.RunCompose

namespace AgentWorkspace.Theorems.Refinement.RunCompose

open AgentWorkspace AgentWorkspace.Behaviour.RunCompose

private def archived : ExistingSession :=
  { found := true, agentMatches := true, ownerMatches := true, projectUsable := true,
    active := false, engineSessionIdKnown := true }

/-- The repaired composition root agrees with the target on existing-session acceptance. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/composition/register.ts#openSession")]
theorem target_agrees_with_current (w s : Bool) (session : ExistingSession) :
    openSessionTarget w s session = openSessionCurrent w s session := by
  rfl

/-- An archived session is refused before its saved SDK id can select a resumed launch. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/composition/register.ts#openSession")]
theorem archived_session_reuse_refused :
    openSessionCurrent true true archived = false ∧
    openSessionTarget true true archived = false ∧
    sessionForLaunchResume archived = true := by decide

/-- The server parser and published contract both reject an empty paired model. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/runs/api.ts#parseStartRunBody")]
theorem server_rejects_empty_model_with_contract :
    (match parseStartRunBody (.obj [("prompt", .str "go"),
      ("modelConnectionId", .str "123e4567-e89b-42d3-a456-426614174000"),
      ("model", .str "")]) with
      | .ok _ => true
      | .rejected _ => false) = false ∧
    AgentWorkspace.Contracts.Runs.startRunRequest (.obj [("prompt", .str "go"),
      ("modelConnectionId", .str "123e4567-e89b-42d3-a456-426614174000"),
      ("model", .str "")]) = false := by decide

end AgentWorkspace.Theorems.Refinement.RunCompose
