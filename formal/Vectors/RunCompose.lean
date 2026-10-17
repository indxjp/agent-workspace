import AgentWorkspace.Theorems.Adversarial.RunCompose
import AgentWorkspace.Theorems.Adversarial.PolicyCeiling
import AgentWorkspace.Theorems.Refinement.EngineToolPolicy
import Vectors.Common

namespace Vectors.RunCompose

open Lean AgentWorkspace AgentWorkspace.Behaviour.RunCompose

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".RunCompose." ++ name

private def parserVector (id : String) (body : JValue) : Vector :=
  let verdict := parseStartRunBody body
  let result := match verdict with
    | .ok _ => "ok"
    | .rejected .notObject => "not-object"
    | .rejected .unknownKey => "unknown-key"
    | .rejected .promptType => "prompt-type"
    | .rejected .promptBlank => "prompt-blank"
    | .rejected .promptLong => "prompt-long"
    | .rejected .connectionId => "connection-id"
    | .rejected .modelType => "model-type"
    | .rejected .modelBlank => "model-blank"
    | .rejected .modelPair => "model-pair"
    | .rejected .sessionId => "session-id"
  { id, input := body.toJson, expected := Json.mkObj [("result", toJson result)],
    witnesses := [t "WellFormed" "server_parser_refuses_unknown_key"] }

private def uuid : JValue := .str "123e4567-e89b-42d3-a456-426614174000"

def parserVectors : List Vector :=
  [parserVector "minimal" (.obj [("prompt", .str "go")]),
   parserVector "not-object" (.arr []),
   parserVector "unknown-key-first" (.obj [("extra", .null)]),
   parserVector "prompt-missing" (.obj []),
   parserVector "prompt-blank" (.obj [("prompt", .str " \t")]),
   parserVector "connection-invalid" (.obj [("prompt", .str "go"),
     ("modelConnectionId", .str "bad")]),
   parserVector "model-type" (.obj [("prompt", .str "go"), ("model", .num 1 0)]),
   parserVector "model-unpaired" (.obj [("prompt", .str "go"), ("model", .str "m")]),
   parserVector "empty-paired-model" (.obj [("prompt", .str "go"),
     ("modelConnectionId", uuid), ("model", .str "")]),
   parserVector "session-invalid" (.obj [("prompt", .str "go"), ("sessionId", .str "bad")]),
   parserVector "session-valid" (.obj [("prompt", .str "go"), ("sessionId", uuid)])]

private def sessionVector (id : String) (session : ExistingSession) : Vector :=
  { id, input := Json.mkObj [("found", toJson session.found),
      ("agentMatches", toJson session.agentMatches),
      ("ownerMatches", toJson session.ownerMatches),
      ("projectUsable", toJson session.projectUsable),
      ("active", toJson session.active),
      ("engineSessionIdKnown", toJson session.engineSessionIdKnown)],
    expected := Json.mkObj [("current", toJson (openSessionCurrent true true session)),
      ("target", toJson (openSessionTarget true true session)),
      ("resume", toJson (sessionForLaunchResume session))],
    witnesses := [t "Refinement" "archived_session_reuse_refused"] }

def sessionVectors : List Vector :=
  let active : ExistingSession :=
    { found := true, agentMatches := true, ownerMatches := true, projectUsable := true,
      active := true, engineSessionIdKnown := true }
  [sessionVector "active" active,
   sessionVector "archived" { active with active := false },
   sessionVector "other-owner" { active with ownerMatches := false },
   sessionVector "other-agent" { active with agentMatches := false },
   sessionVector "archived-project" { active with projectUsable := false },
   sessionVector "no-sdk-id" { active with engineSessionIdKnown := false }]

private def permissionsJson (p : Permissions) : Json := Json.mkObj
  [("readFiles", toJson p.readFiles), ("writeFiles", toJson p.writeFiles),
   ("runCommands", toJson p.runCommands),
   ("unrestrictedNetwork", toJson p.unrestrictedNetwork)]

private def toolVector (id : String) (p : Permissions) : Vector :=
  { id, input := permissionsJson p,
    expected := Json.mkObj [("deny", toJson (toolDeny p))],
    witnesses := [t "WellFormed" "no_permissions_deny_every_named_tool"] }

def toolVectors : List Vector :=
  let all : Permissions :=
    { readFiles := true, writeFiles := true, runCommands := true, unrestrictedNetwork := true }
  [toolVector "all" all,
   toolVector "none" { readFiles := false, writeFiles := false, runCommands := false, unrestrictedNetwork := false },
   toolVector "no-read" { all with readFiles := false },
   toolVector "no-write" { all with writeFiles := false },
   toolVector "no-shell" { all with runCommands := false },
   toolVector "no-network" { all with unrestrictedNetwork := false }]

private def sandboxVector (id sessionId : String) : Vector :=
  let result := sandboxFor "/workspace" "workspace-a" sessionId
  let rendered := result.map fun (cwd, projectKey, configDir) =>
    Json.mkObj [("cwd", toJson cwd), ("projectKey", toJson projectKey),
      ("configDir", toJson configDir)]
  { id, input := Json.mkObj [("sessionId", toJson sessionId)],
    expected := Json.mkObj [("result", rendered.getD Json.null)],
    witnesses := [t "WellFormed" "sandbox_path_rejects_escape"] }

def sandboxVectors : List Vector :=
  [sandboxVector "safe" "valid-session_1",
   sandboxVector "traversal" "../other",
   sandboxVector "empty" "",
   sandboxVector "leading-hyphen" "-bad"]

/-- The sandbox root these vectors compile in. ENG-04b (#325): the Claude adapter *derives*
`CLAUDE_CONFIG_DIR` as `cwd ++ "/.claude"` rather than receiving it on the private `/run` contract,
so the vector names the root and the derivation supplies the rest — exactly what
`tests/formal/run-compose.test.ts` replays against `compileRunRequest`. -/
private def environmentCwd : String := "/run/claude/tenant-a"

private def environmentVector (id : String) (source : List (String × String)) : Vector :=
  let compiled := compiledEnvironment source "6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b"
    "2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e" "tenant-a" (environmentCwd ++ "/.claude")
  let rendered := compiled.map fun fields => Json.mkObj (fields.map fun (k, v) => (k, toJson v))
  { id, input := Json.mkObj (source.map fun (k, v) => (k, toJson v)),
    expected := Json.mkObj [("env", rendered.getD Json.null)],
    witnesses := [t "Normative" "environment_derives_scope_and_identity",
      t "Adversarial" "master_key_never_compiles"] }

def environmentVectors : List Vector :=
  [environmentVector "empty" [],
   environmentVector "custom" [("CUSTOM", "value")],
   environmentVector "master-key" [("ANTHROPIC_API_KEY", "secret")],
   environmentVector "master-key-mixed-case" [("Anthropic_Api_Key", "secret")]]

/-! ## `ceiling.json`: compose meets the policy ceiling (S2-04c)

Replayed by `tests/formal/run-compose.test.ts` through `meetPolicyCeiling`, `policyWidenings` and
the Claude adapter's `compileClaudeToolPolicy` with the stored arm's `deny`. The met fields are the
meet's whether or not the run is refused, as `meetRunCeiling` returns both. -/

private def natJson : Option Nat → Json
  | some n => toJson n
  | none => Json.null

private def limitsJson (turns budget : Option Nat) : Json :=
  Json.mkObj [("maxTurns", natJson turns), ("maxBudgetUsd", natJson budget)]

private def ceilingJson : Option AgentWorkspace.Concepts.PolicyCeiling.Ceiling → Json
  | none => Json.null
  | some c =>
    let caps := AgentWorkspace.Concepts.Agent.permissionKeys.filter c.caps.contains
    let limits := (c.maxTurns.toList.map fun n => ("maxTurns", toJson n)) ++
      (c.maxBudget.toList.map fun n => ("maxBudgetUsd", toJson n))
    Json.mkObj <|
      (if caps.isEmpty then [] else [("permissions", Json.mkObj (caps.map (·, Json.bool false)))]) ++
      (if limits.isEmpty then [] else [("limits", Json.mkObj limits)]) ++
      (c.engines.toList.map fun l => ("engines", toJson l)) ++
      (c.models.toList.map fun l => ("models", toJson l)) ++
      (c.tools.toList.map fun l => ("tools", toJson l)) ++
      (c.minEvalScore.toList.map fun n => ("promotion", Json.mkObj [("minEvalScore", toJson n)]))

private def ceilingVector (id : String) (s : StoredRun)
    (c : Option AgentWorkspace.Concepts.PolicyCeiling.Ceiling) (witness : String) : Vector :=
  let met := AgentWorkspace.Concepts.PolicyCeiling.meet s.config c
  let metPermissions := Permissions.ofAgent met.permissions
  let (result, details) := match composeWithCeiling s c with
    | .ok _ => ("ok", ([] : List String))
    | .refused ds => ("refused", ds)
  { id,
    input := Json.mkObj [("permissions", permissionsJson s.permissions),
      ("limits", limitsJson s.maxTurns s.maxBudget), ("engine", toJson s.engine),
      ("model", match s.model with
        | some m => toJson m
        | none => Json.null),
      ("tools", toJson s.connectorNames), ("storedDeny", toJson s.storedDeny),
      ("ceiling", ceilingJson c)],
    expected := Json.mkObj [("result", toJson result), ("details", toJson details),
      ("permissions", permissionsJson metPermissions),
      ("limits", limitsJson met.maxTurns met.maxBudget), ("tools", toJson met.tools),
      ("deny", toJson (agentDeny metPermissions s.storedDeny))],
    witnesses := ["AgentWorkspace.Theorems.Adversarial.PolicyCeiling." ++ witness,
      "AgentWorkspace.Theorems.Refinement.EngineToolPolicy.the_meet_keeps_the_deny_byte_order"] }

def ceilingVectors : List Vector :=
  let stored : StoredRun :=
    { permissions :=
        { readFiles := true, writeFiles := true, runCommands := true, unrestrictedNetwork := true },
      maxTurns := none, maxBudget := none, engine := "claude-agent-sdk", model := some "claude-y",
      connectorNames := [], storedDeny := ["WebFetch"] }
  let uncapped : AgentWorkspace.Concepts.PolicyCeiling.Ceiling :=
    { caps := [], maxTurns := none, maxBudget := none, engines := none, models := none,
      tools := none, minEvalScore := none }
  let le := "composed_run_le_ceiling_for_any_stored_state"
  [ceilingVector "run-commands-capped" stored (some { uncapped with caps := ["runCommands"] }) le,
   ceilingVector "max-budget-capped" { stored with maxBudget := some 5 }
     (some { uncapped with maxBudget := some 2 }) le,
   ceilingVector "null-budget-composes-at-the-ceiling" stored
     (some { uncapped with maxBudget := some 2 }) le,
   ceilingVector "max-turns-capped" { stored with maxTurns := some 50 }
     (some { uncapped with maxTurns := some 10 }) le,
   ceilingVector "engine-outside" { stored with engine := "openai-agents" }
     (some { uncapped with engines := some ["claude-agent-sdk"] }) "composed_run_refuses_engine_outside",
   ceilingVector "model-outside" { stored with model := some "claude-x" }
     (some { uncapped with models := some ["claude-y"] })
     "composed_run_refuses_resolved_model_outside",
   ceilingVector "tool-outside-dropped" { stored with connectorNames := ["orders", "github"] }
     (some { uncapped with tools := some ["github"] }) "composed_tools_subset_ceiling",
   ceilingVector "no-ceiling-is-identity"
     { stored with maxTurns := some 50, maxBudget := some 5, connectorNames := ["orders"] } none le]

def files : List (String × Json) :=
  [("parser.json", file "run-compose" "Server start-body parser, independent of the contract"
      parserVectors),
   ("session.json", file "run-compose" "Existing-session acceptance and resume decision"
      sessionVectors),
   ("sandbox.json", file "run-compose" "Sandbox path and scope derivation" sandboxVectors),
   ("tools.json", file "run-compose" "Permission switches mapped to denied SDK tools"
      toolVectors),
   ("environment.json", file "run-compose" "Derived scope and identity, master-key refusal"
      environmentVectors),
   ("ceiling.json", file "run-compose" "Compose meets the policy ceiling" ceilingVectors)]

end Vectors.RunCompose
