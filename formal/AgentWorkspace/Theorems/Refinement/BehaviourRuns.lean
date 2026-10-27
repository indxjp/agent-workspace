import AgentWorkspace.Theorems.Normative.BehaviourRuns

namespace AgentWorkspace.Theorems.Refinement.BehaviourRuns

open AgentWorkspace AgentWorkspace.Behaviour.Runs
  AgentWorkspace.Behaviour.RunCompose
open AgentWorkspace.Theorems.Normative.BehaviourRuns

/-- The server and published contract both reject a paired empty model. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/runs/api.ts#parseStartRunBody")
  (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem empty_model_request_agrees :
    (match parseStartRunBody (.obj [("prompt", .str "go"),
      ("modelConnectionId", .str "123e4567-e89b-42d3-a456-426614174000"),
      ("model", .str "")]) with
      | .ok _ => true | .rejected _ => false) = false ∧
    AgentWorkspace.Contracts.Runs.startRunRequest (.obj [("prompt", .str "go"),
      ("modelConnectionId", .str "123e4567-e89b-42d3-a456-426614174000"),
      ("model", .str "")]) = false ∧
    (step fixture owner { request .start with bodyValid := false }).reply.status = 400 := by decide +kernel

/-- The handler and the dedicated decision both admit Admin revocation. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/runs/api.ts#revokeRunTokens")
  (ts := "apps/web/server/rbac/decide.ts#decide")]
theorem admin_revoke_handler_and_decide_agree :
    (step fixture { owner with role := "admin" } (request .revoke)).reply.status = 200 ∧
    (AgentWorkspace.Authz.Decide.decideAuth
      { role := "admin", method := "POST", path := "/api/runs/:id/revoke-tokens",
        ownership := .own, scope := none }).effect = .allow := by decide +kernel

end AgentWorkspace.Theorems.Refinement.BehaviourRuns
