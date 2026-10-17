import AgentWorkspace.Contracts.Runs
import AgentWorkspace.Concepts.PolicyCeiling

/-! Pure decisions at the web run-composition boundary. The HTTP parser is transcribed from
`apps/web/server/runs/api.ts`, independently of the published StartRunRequest schema. -/

namespace AgentWorkspace.Behaviour.RunCompose

open AgentWorkspace AgentWorkspace.Contracts.Runs

inductive StartReject where
  | notObject
  | unknownKey
  | promptType
  | promptBlank
  | promptLong
  | connectionId
  | modelType
  | modelBlank
  | modelPair
  | sessionId
  deriving DecidableEq, Repr

structure StartBody where
  prompt : String
  sessionId : Option String
  modelConnectionId : Option String
  model : Option String
  deriving DecidableEq, Repr

inductive StartVerdict where
  | ok (body : StartBody)
  | rejected (reason : StartReject)
  deriving DecidableEq, Repr

def optionalNullableString (fs : JValue.Fields) (key : String) : Option (Option String) :=
  match JValue.lookup key fs with
  | none | some .null => some none
  | some (.str s) => some (some s)
  | _ => none

/-- Exact evaluation order of `parseStartRunBody`. -/
def parseStartRunBody : JValue → StartVerdict
  | .obj fs =>
    if !Obj.onlyKeys ["prompt", "sessionId", "modelConnectionId", "model"] fs then
      .rejected .unknownKey
    else match JValue.lookup "prompt" fs with
      | some (.str prompt) =>
        if Text.isBlank prompt then .rejected .promptBlank
        else if Text.utf16Length prompt > maxPromptChars then .rejected .promptLong
        else match optionalNullableString fs "modelConnectionId" with
          | none => .rejected .connectionId
          | some connection =>
            if connection.any (fun s => !AgentWorkspace.Contracts.Identifiers.isUuidCurrent s) then
              .rejected .connectionId
            else match optionalNullableString fs "model" with
              | none => .rejected .modelType
              | some model =>
                if model.any (fun s => s.isEmpty) then .rejected .modelBlank
                else if connection.isSome != model.isSome then .rejected .modelPair
                else match optionalNullableString fs "sessionId" with
                  | none => .rejected .sessionId
                  | some session =>
                    if session.any (fun s => !AgentWorkspace.Contracts.Identifiers.isUuidCurrent s) then
                      .rejected .sessionId
                    else .ok { prompt := prompt, sessionId := session, modelConnectionId := connection, model := model }
      | _ => .rejected .promptType
  | _ => .rejected .notObject

/-- An existing session is accepted after its workspace, owner, agent, status and project checks. -/
structure ExistingSession where
  found : Bool
  agentMatches : Bool
  ownerMatches : Bool
  projectUsable : Bool
  active : Bool
  engineSessionIdKnown : Bool
  deriving DecidableEq, Repr

def openSessionCurrent (workspaceUsable scopeFound : Bool) (session : ExistingSession) : Bool :=
  workspaceUsable && scopeFound && session.found && session.agentMatches &&
    session.ownerMatches && session.active && session.projectUsable

def openSessionTarget (workspaceUsable scopeFound : Bool) (session : ExistingSession) : Bool :=
  openSessionCurrent workspaceUsable scopeFound session

/-- `sessionForLaunch` chooses resume solely from the presence of the SDK session id. -/
def sessionForLaunchResume (session : ExistingSession) : Bool := session.engineSessionIdKnown

def workspaceUsable (found archived : Bool) : Bool := found && !archived
def projectUsable (hasProject found archived : Bool) : Bool :=
  !hasProject || (found && !archived)

inductive ModelLayer where
  | run | agent | project | workspace | deployment
  deriving DecidableEq, Repr

structure ModelChoice where
  connectionId : String
  model : String
  existsInWorkspace : Bool
  ready : Bool
  credentialReadable : Bool
  discoverySucceeded : Bool
  modelDiscovered : Bool
  deriving DecidableEq, Repr

/-- The deployment default layer of an agent that names no model: the agent's connection, or the
workspace's connection named `default` when the agent names none (C7, bound in this layer only),
paired with the deployment's per-provider default model id. When neither connection exists the
TypeScript layer carries none, modelled as a `connection` that does not exist in the workspace.
`defaultConfigured` is whether the deployment sets an id for that connection's provider. This is
the one named exception to never mixing a connection from one level with a model from another. -/
structure DeploymentChoice where
  connection : ModelChoice
  defaultConfigured : Bool
  deriving DecidableEq, Repr

structure ModelLayers where
  run : Option ModelChoice := none
  agent : Option ModelChoice := none
  project : Option ModelChoice := none
  workspace : Option ModelChoice := none
  deployment : Option DeploymentChoice := none
  deriving DecidableEq, Repr

inductive ModelResolution where
  | ok (layer : ModelLayer) (choice : ModelChoice)
  | rejected (layer : ModelLayer)
  deriving DecidableEq, Repr

def modelChoiceRunnable (choice : ModelChoice) : Bool :=
  choice.existsInWorkspace && choice.ready && choice.credentialReadable &&
    choice.discoverySucceeded && choice.modelDiscovered

/-- The first non-null layer of run > agent > project > workspace > deployment wins outright. The
deployment layer is tried only when the other four are all absent; with no deployment layer the
refusal stays at the workspace layer. -/
def resolveModelForRun (layers : ModelLayers) : ModelResolution :=
  let first : ModelLayer × Option ModelChoice :=
    if layers.run.isSome then (.run, layers.run)
    else if layers.agent.isSome then (.agent, layers.agent)
    else if layers.project.isSome then (.project, layers.project)
    else (.workspace, layers.workspace)
  match first, layers.deployment with
  | (.workspace, none), some d =>
    if d.defaultConfigured && modelChoiceRunnable d.connection then .ok .deployment d.connection
    else .rejected .deployment
  | (layer, none), _ => .rejected layer
  | (layer, some choice), _ =>
    if modelChoiceRunnable choice then .ok layer choice
    else .rejected layer

structure Permissions where
  readFiles : Bool
  writeFiles : Bool
  runCommands : Bool
  unrestrictedNetwork : Bool
  deriving DecidableEq, Repr

def toolDeny (p : Permissions) : List String :=
  (if p.readFiles then [] else ["Read", "Glob", "Grep"]) ++
  (if p.writeFiles then [] else ["Write", "Edit", "NotebookEdit"]) ++
  (if p.runCommands then [] else ["Bash", "BashOutput", "KillShell"]) ++
  (if p.unrestrictedNetwork then [] else ["WebFetch", "WebSearch"])

/-- Stored policy denials add to, rather than replace, permission denials. -/
def agentDeny (permissions : Permissions) (storedDeny : List String) : List String :=
  (storedDeny ++ toolDeny permissions).eraseDups

/-- A project may select only skills already assigned to the agent. -/
def selectedSkills (assigned requested : List String) : List String :=
  requested.filter assigned.contains

def fileGrantDeny (existing : List String) (cwd : String)
    (readOnlyPaths : List (String × Bool)) : List String :=
  if readOnlyPaths.isEmpty then existing
  else
    let pathDenials := readOnlyPaths.flatMap fun (path, isDirectory) =>
      let full := cwd ++ "/" ++ path ++ (if isDirectory then "/**" else "")
      ["Edit(/" ++ full ++ ")"]
    (existing ++ pathDenials ++ ["Bash", "BashOutput", "KillShell"]).eraseDups

def safePathSegment (s : String) : Bool :=
  let alphaNum (c : Char) : Bool :=
    ('A' ≤ c && c ≤ 'Z') || ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9')
  match s.toList with
  | [] => false
  | first :: rest =>
    alphaNum first && rest.all (fun c => alphaNum c || c == '_' || c == '-')

def sandboxFor (workspaceRoot workspaceId sessionId : String) : Option (String × String × String) :=
  if safePathSegment sessionId then
    let cwd := workspaceRoot ++ "/" ++ workspaceId ++ "/" ++ sessionId
    some (cwd, workspaceId, cwd ++ "/.claude")
  else none

/-- The caller's environment is the whole subprocess environment, not a merge with the host.
The four derived keys are appended last, overriding any earlier values of those exact names. -/
def compiledEnvironment (source : List (String × String)) (runId sessionId projectKey configDir : String) :
    Option (List (String × String)) :=
  let derived := [("CLAUDE_CONFIG_DIR", configDir),
    ("CLAUDE_CODE_PROJECT_DIR_NAME", projectKey),
    ("AGENT_WORKSPACE_RUN_ID", runId), ("AGENT_WORKSPACE_SESSION_ID", sessionId)]
  let env := source.filter (fun kv => !(derived.map Prod.fst).contains kv.1) ++ derived
  if env.any (fun kv => AgentWorkspace.Contracts.Identifiers.lowerAscii kv.1 == "anthropic_api_key") then none
  else some env

/-- Run creation and project reassignment share one session lock. Each commit observes a complete
state: a move after any run exists is refused, and a run created after a move inherits the new
project through its session. -/
structure SessionProjectState where
  projectId : String
  runCount : Nat := 0
  deriving DecidableEq, Repr

@[aw_spec (ts := "packages/core/src/db/repositories/runs.ts#create")]
def createRunInSession (s : SessionProjectState) : SessionProjectState :=
  { s with runCount := s.runCount + 1 }

@[aw_spec (ts := "packages/core/src/db/repositories/projects.ts#moveSession")]
def moveSessionProject (s : SessionProjectState) (target : String) : SessionProjectState :=
  if s.runCount == 0 then { s with projectId := target } else s

/-! ## The deployment's policy ceiling at compose (S2-04c, ADR-0102 SD6, C14, C16)

Compose meets every run with the ceiling after the withholding arm, using S2-04b's `meet` and
`violations` unchanged. The meet narrows permissions, limits and connector names; the engine and
the resolved model it cannot narrow, so whatever `violations` still names after the meet refuses
the run with `403 policy_cannot_widen` before anything reaches the runner. -/

/-- §17 Step 4's switches, as the ceiling judges them. -/
def Permissions.toAgent (p : Permissions) : AgentWorkspace.Concepts.Agent.Permissions :=
  ⟨p.readFiles, p.writeFiles, p.runCommands, p.unrestrictedNetwork⟩

/-- §17 Step 4's switches, as compose and the Claude adapter read them. -/
def Permissions.ofAgent (p : AgentWorkspace.Concepts.Agent.Permissions) : Permissions :=
  ⟨p.readFiles, p.writeFiles, p.runCommands, p.unrestrictedNetwork⟩

/-- What compose holds for one run when it meets the ceiling: the permissions after the withheld
narrowing, the stored limits (`none` is `null`), the engine, the model the S1-23 ladder resolved,
the names of the connectors the loader returned, and the stored Claude arm's `deny`. -/
structure StoredRun where
  permissions : Permissions
  maxTurns : Option Nat
  maxBudget : Option Nat
  engine : String
  model : Option String
  connectorNames : List String
  storedDeny : List String
  deriving DecidableEq, Repr

/-- The run as the `EffectivePolicyConfiguration` the ceiling judges. -/
def StoredRun.config (s : StoredRun) : AgentWorkspace.Concepts.PolicyCeiling.Config :=
  { permissions := s.permissions.toAgent, maxTurns := s.maxTurns, maxBudget := s.maxBudget,
    engine := s.engine, model := s.model, tools := s.connectorNames }

/-- Compose's answer under a ceiling: the met configuration, or the `policy_cannot_widen` details. -/
inductive ComposeVerdict where
  | ok (met : AgentWorkspace.Concepts.PolicyCeiling.Config)
  | refused (details : List String)
  deriving DecidableEq, Repr

/-- `meetRunCeiling` with the connector meet: meet the stored run with the ceiling, then refuse it
when anything is still wider than the ceiling (only an engine or a model can be). -/
@[aw_spec (ts := "apps/web/server/compose/run-request.ts#meetRunCeiling")
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")]
def composeWithCeiling (s : StoredRun)
    (c : Option AgentWorkspace.Concepts.PolicyCeiling.Ceiling) : ComposeVerdict :=
  match AgentWorkspace.Concepts.PolicyCeiling.violations
      (AgentWorkspace.Concepts.PolicyCeiling.meet s.config c) c with
  | [] => .ok (AgentWorkspace.Concepts.PolicyCeiling.meet s.config c)
  | details => .refused details

end AgentWorkspace.Behaviour.RunCompose
