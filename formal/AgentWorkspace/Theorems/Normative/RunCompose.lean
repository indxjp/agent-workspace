import AgentWorkspace.Theorems.Refinement.RunCompose

namespace AgentWorkspace.Theorems.Normative.RunCompose

open AgentWorkspace AgentWorkspace.Behaviour.RunCompose

private def readyChoice : ModelChoice :=
  { connectionId := "connection", model := "model", existsInWorkspace := true, ready := true, credentialReadable := true, discoverySucceeded := true, modelDiscovered := true }

/-- The first non-null selection wins; an unready run override is a refusal at run, with no
fallback to the ready workspace default. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/compose/run-request.ts#resolveModelForRun")]
theorem model_resolution_does_not_fallback :
    resolveModelForRun { run := some { readyChoice with ready := false }, workspace := some readyChoice } = .rejected .run := by decide

/-- A selected connection with unreadable credentials is refused without falling back. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/compose/run-request.ts#resolveModelForRun")]
theorem model_resolution_requires_readable_credential :
    resolveModelForRun { run := some readyChoice } = .ok .run readyChoice ∧
    resolveModelForRun { run := some { readyChoice with credentialReadable := false }, workspace := some readyChoice } = .rejected .run := by decide

/-- Model selection uses the first configured run, agent, project, workspace, or deployment
layer; the deployment default is the last layer (see `model_resolution_deployment_is_last`). -/
@[aw_spec (tier := T1) (ts := "apps/web/server/compose/run-request.ts#resolveModelForRun")]
theorem model_resolution_precedence :
    resolveModelForRun { agent := some readyChoice, project := some readyChoice, workspace := some readyChoice } = .ok .agent readyChoice ∧
    resolveModelForRun { workspace := some readyChoice } = .ok .workspace readyChoice ∧
    resolveModelForRun {} = .rejected .workspace := by decide

private def readyDeployment : DeploymentChoice :=
  { connection := readyChoice, defaultConfigured := true }

/-- The deployment default is the last layer: a workspace default, or an agent selection, wins
over it. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/compose/run-request.ts#resolveModelForRun")]
theorem model_resolution_deployment_is_last :
    resolveModelForRun { workspace := some readyChoice, deployment := some readyDeployment } = .ok .workspace readyChoice ∧
    resolveModelForRun { agent := some readyChoice, deployment := some readyDeployment } = .ok .agent readyChoice ∧
    resolveModelForRun { project := some readyChoice, deployment := some readyDeployment } = .ok .project readyChoice := by decide

/-- With no other layer, a configured deployment default on a ready connection resolves at the
deployment layer. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/compose/run-request.ts#resolveModelForRun")]
theorem model_resolution_deployment_applies :
    resolveModelForRun { deployment := some readyDeployment } = .ok .deployment readyChoice := by decide

/-- A deployment layer with no configured default, an unready connection, or no connection at all
(the agent names none and the workspace has none named `default`) is refused at the deployment
layer, never silently skipped. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/compose/run-request.ts#resolveModelForRun")]
theorem model_resolution_deployment_unconfigured_refused :
    resolveModelForRun { deployment := some { readyDeployment with defaultConfigured := false } } = .rejected .deployment ∧
    resolveModelForRun { deployment := some { readyDeployment with connection := { readyChoice with ready := false } } } = .rejected .deployment ∧
    resolveModelForRun { deployment := some { readyDeployment with connection := { readyChoice with existsInWorkspace := false } } } = .rejected .deployment := by decide

/-- Compiled subprocess variables include the caller's values and four derived identity values. -/
@[aw_spec (tier := T1) (ts := "packages/engine-claude-agent-sdk/src/compile.ts#compileRunRequest")]
theorem environment_derives_scope_and_identity :
    compiledEnvironment [("CUSTOM", "value")] "run" "session" "workspace" "/cwd/.claude" =
      some [("CUSTOM", "value"), ("CLAUDE_CONFIG_DIR", "/cwd/.claude"),
        ("CLAUDE_CODE_PROJECT_DIR_NAME", "workspace"),
        ("AGENT_WORKSPACE_RUN_ID", "run"),
        ("AGENT_WORKSPACE_SESSION_ID", "session")] := by decide

/-- A mixed-case provider master-key variable prevents compilation. -/
@[aw_spec (tier := T1) (ts := "packages/engine-claude-agent-sdk/src/compile.ts#compileRunRequest")]
theorem environment_refuses_master_key_in_any_case :
    compiledEnvironment [("Anthropic_Api_Key", "secret")] "r" "s" "w" "c" = none := by decide

end AgentWorkspace.Theorems.Normative.RunCompose
