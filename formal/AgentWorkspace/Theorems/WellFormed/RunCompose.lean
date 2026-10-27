import AgentWorkspace.Behaviour.RunCompose

namespace AgentWorkspace.Theorems.WellFormed.RunCompose

open AgentWorkspace AgentWorkspace.Behaviour.RunCompose

/-- The server parser rejects an unrecognised start-body key. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/runs/api.ts#parseStartRunBody")]
theorem server_parser_refuses_unknown_key :
    parseStartRunBody (.obj [("prompt", .str "go"), ("extra", .bool true)]) =
      .rejected .unknownKey := by decide +kernel

/-- The server parser rejects a whitespace-only prompt. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/runs/api.ts#parseStartRunBody")]
theorem server_parser_refuses_blank_prompt :
    parseStartRunBody (.obj [("prompt", .str " \t")]) = .rejected .promptBlank := by decide +kernel

/-- Explicit null model fields are accepted as an absent override. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/runs/api.ts#parseStartRunBody")]
theorem server_parser_accepts_null_pair :
    parseStartRunBody (.obj [("prompt", .str "go"),
      ("modelConnectionId", .null), ("model", .null)]) =
      .ok { prompt := "go", sessionId := none, modelConnectionId := none, model := none } := by decide +kernel

/-- Disabling every agent permission denies each named SDK tool group.

ENG-04b (#325) moved the table this cites. It was `apps/web/server/compose/run-request.ts`'s
`toolPolicyFor`; it is now `packages/contracts/src/agents.ts`' `claudeDeniedToolsFor`, which both the
Claude adapter's compile and `GET /api/agents/:id/policy` read — one spelling of one security
decision. The mapping itself is unchanged, which is what
`Theorems/Refinement/EngineToolPolicy.lean` states. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/agents.ts#claudeDeniedToolsFor")
  (ts := "packages/engine-claude-agent-sdk/src/tools.ts#compileClaudeToolPolicy")]
theorem no_permissions_deny_every_named_tool :
    toolDeny { readFiles := false, writeFiles := false, runCommands := false, unrestrictedNetwork := false } =
      ["Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit", "Bash", "BashOutput",
       "KillShell", "WebFetch", "WebSearch"] := by decide +kernel

/-- Sandbox derivation rejects traversal and accepts a safe session segment.

The triple is composed by two modules since ENG-04b (#325): `sandboxFor` answers the sandbox root
and the tenant namespace, and the engine's own adapter derives the configuration directory from the
first of them (`claudeSessionScope`). The string is the same one compose used to send. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/compose/run-request.ts#sandboxFor")
  (ts := "packages/engine-claude-agent-sdk/src/scope.ts#claudeSessionScope")]
theorem sandbox_path_rejects_escape :
    sandboxFor "/workspace" "workspace" "../other" = none ∧
    sandboxFor "/workspace" "workspace" "valid-session_1" =
      some ("/workspace/workspace/valid-session_1", "workspace",
        "/workspace/workspace/valid-session_1/.claude") := by decide +kernel

/-- New work requires an existing workspace that is not archived. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/workspaces/run-gate.ts#isWorkspaceUsableForRuns")]
theorem workspace_gate :
    workspaceUsable true false = true ∧ workspaceUsable true true = false ∧
    workspaceUsable false false = false := by decide +kernel

/-- A project association permits new work only while its project exists and is active. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/projects/archive-gate.ts#isProjectUsableForNewWork")]
theorem project_gate :
    projectUsable false false false = true ∧ projectUsable true true false = true ∧
    projectUsable true true true = false ∧ projectUsable true false false = false := by decide +kernel

/-- Existing-session acceptance requires both the exact owner and a usable project. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/composition/wiring/run-api.ts#openSession")]
theorem existing_session_checks_owner_and_project :
    let valid : ExistingSession :=
      { found := true, agentMatches := true, ownerMatches := true, projectUsable := true, active := true, engineSessionIdKnown := true }
    openSessionCurrent true true valid = true ∧
    openSessionCurrent true true { valid with ownerMatches := false } = false ∧
    openSessionCurrent true true { valid with projectUsable := false } = false := by decide +kernel

end AgentWorkspace.Theorems.WellFormed.RunCompose
