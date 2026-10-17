import AgentWorkspace.Theorems.Normative.RunCompose

namespace AgentWorkspace.Theorems.Adversarial.RunCompose

open AgentWorkspace.Behaviour.RunCompose

/-- Selected skills are exactly the requested names that remain assigned to the agent. -/
@[aw_spec (tier := T3)
  (ts := "apps/web/server/compose/run-request.ts#portableAgentConfigFor")]
theorem selected_skill_is_assigned (assigned requested : List String) (name : String) :
    name ∈ selectedSkills assigned requested ↔
      name ∈ requested ∧ name ∈ assigned := by
  simp [selectedSkills]

/-- Stored policy cannot drop a checkbox-derived denial.

The union moved into the Claude adapter with ENG-04b (#325); the rule did not.
`Theorems/Refinement/EngineToolPolicy.lean` states that the two produce the same lists. -/
@[aw_spec (tier := T3)
  (ts := "packages/engine-claude-agent-sdk/src/tools.ts#compileClaudeToolPolicy")]
theorem policy_keeps_read_denials :
    "Read" ∈ agentDeny { readFiles := false, writeFiles := true, runCommands := true, unrestrictedNetwork := true } [] := by decide

/-- A stored tool denial survives union with checkbox-derived denials. -/
@[aw_spec (tier := T3)
  (ts := "packages/engine-claude-agent-sdk/src/tools.ts#compileClaudeToolPolicy")]
theorem stored_policy_denial_survives :
    let all : Permissions :=
      { readFiles := true, writeFiles := true, runCommands := true, unrestrictedNetwork := true }
    agentDeny all ["WebFetch"] = ["WebFetch"] := by decide

/-- A read-only file grant removes write tools on that path and shell execution. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/compose/run-request.ts#applyFileGrantPolicy")]
theorem read_only_file_denies_writes_and_shell :
    "Edit(//cwd/readme.txt)" ∈ fileGrantDeny [] "/cwd" [("readme.txt", false)] ∧
    "Bash" ∈ fileGrantDeny [] "/cwd" [("readme.txt", false)] ∧
    "KillShell" ∈ fileGrantDeny [] "/cwd" [("readme.txt", false)] := by decide

/-- The compiler refuses a provider master key instead of emitting an environment containing it. -/
@[aw_spec (tier := T3) (ts := "packages/engine-claude-agent-sdk/src/compile.ts#compileRunRequest")]
theorem master_key_never_compiles :
    compiledEnvironment [("ANTHROPIC_API_KEY", "provider-master-key")]
      "r" "s" "w" "c" = none := by decide

/-- An assigned requested skill remains selected while an unassigned request is removed. -/
@[aw_spec (tier := T3)
  (ts := "apps/web/server/compose/run-request.ts#portableAgentConfigFor")]
theorem selected_skill_has_positive_witness :
    selectedSkills ["assigned"] ["assigned", "unassigned"] = ["assigned"] := by decide

/-- A run that wins the session lock first prevents a later project reassignment. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/repositories/projects.ts#moveSession")
  (ts := "packages/core/src/db/repositories/runs.ts#create")]
theorem run_before_project_move_keeps_attribution (source target : String) :
    (moveSessionProject (createRunInSession { projectId := source }) target).projectId =
      source := by
  simp [moveSessionProject, createRunInSession]

/-- A move that wins first leaves the new project attached when the next run is created. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/repositories/projects.ts#moveSession")
  (ts := "packages/core/src/db/repositories/runs.ts#create")]
theorem project_move_before_run_uses_new_attribution (source target : String) :
    (createRunInSession (moveSessionProject { projectId := source } target)).projectId =
      target := by
  simp [moveSessionProject, createRunInSession]

end AgentWorkspace.Theorems.Adversarial.RunCompose
