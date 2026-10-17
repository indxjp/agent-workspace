import AgentWorkspace.Authz.PathGrant
import AgentWorkspace.Events.AgentFrames
import AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-!
# The Mastra adapter (ENG-10, #309)

`packages/engine-mastra` puts Mastra (`@mastra/core`) behind the engine port. This module models
the decisions the adapter owns, as pure functions over explicit inputs:

1. **compile** (`src/compile.ts#compileMastraRun`) — the portable core plus the `mastra` policy
   arm into a workspace tool set, a gateway connection, limits and a memory configuration, or a
   refusal naming the capability it could not honour;
2. **the tool plan** (`src/tools.ts#mastraToolPlan`) — the four permission switches into Mastra's
   workspace tools, with the command tools withheld under a read-only grant;
3. **the filesystem wrapper** (`src/workspace.ts#mastraWriteVerdict`) — which write the wrapped
   `LocalFilesystem` lets through, on the path a tool named;
4. **the connection** (`src/compile.ts#mastraModelConnection`) — an explicit AI SDK provider at
   the gateway, never a routed `"provider/model"` string;
5. **the event mapping** (`src/frames.ts#createMastraFrameMapper`) — Mastra's `fullStream` chunks
   into the neutral `agent.*` frames of `Events/AgentFrames.lean`;
6. **the step limit** (`src/boundary.ts#startMastraRun`) — Mastra's native `maxSteps`, and the
   adapter's `max_turns` verdict on a run it cut short;
7. **memory** (`src/session.ts#readMastraThread`) — one thread's records journalled into the
   platform's store stream and folded back by key.

The path rules are `Authz/PathGrant.lean`'s, the frames `Events/AgentFrames.lean`'s, and the
permission switches, refusal codes, protocols, the provisional price list, `isNeutral` and the
pairing scan are `Behaviour/Engines/OpenAiAgents.lean`'s; none is re-modelled here.

## What is a hypothesis rather than a theorem

Six things happen inside Mastra, the AI SDK providers or the kernel and cannot be proved in Lean.
Each is stated here, enforced by `packages/engine-mastra/src/boundary.test.ts` (real Mastra
against a scripted gateway that replaces the process's `fetch`, so it sees every request), and
listed under the unit's declared gaps:

* the AI SDK provider issues model requests only to its `baseURL` plus its method's path
  (`methodPath`), with the run token as `Authorization: Bearer` whether it is handed as
  `authToken` or `apiKey` (the suite records every request of every protocol);
* Mastra sends no telemetry and exports nothing when no `Mastra` instance exists and the process
  environment `installedEnvironment` computes is the one it reads when it loads (the suite asserts
  the gateway was the only destination of the whole run); that the boundary never constructs a
  `Mastra` instance is the suite's too;
* Mastra emits a `finish` chunk at the end of every stream, after an `error` chunk included (the
  suite scripts a gateway failure and finds the `finish` as `agent.native`);
* every workspace tool that writes goes through the `WorkspaceFilesystem` it is handed, and a
  write that throws leaves the file as it was (the suite writes into a read-only grant);
* Mastra stops its loop after `maxSteps` steps (the suite's `maxTurns` case sends no request past
  the limit);
* Mastra's memory reads and writes a thread only through the storage domain it is handed (the
  suite resumes a thread from the fake store and finds the first run's messages in the request).
-/

namespace AgentWorkspace.Behaviour.Engines.Mastra

open AgentWorkspace AgentWorkspace.Authz.PathGrant AgentWorkspace.Events.AgentFrames

/-! ## The tools -/

/-- Mastra's workspace tools the adapter can offer, in `MASTRA_TOOL_NAMES` order. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#MASTRA_TOOL_NAMES")]
inductive Tool where
  | readFile
  | listFiles
  | grep
  | fileStat
  | writeFile
  | editFile
  | mkdir
  | delete
  | executeCommand
  | getProcessOutput
  | killProcess
  deriving DecidableEq, Repr, Inhabited

namespace Tool

def all : List Tool :=
  [readFile, listFiles, grep, fileStat, writeFile, editFile, mkdir, delete, executeCommand,
   getProcessOutput, killProcess]

theorem all_complete (t : Tool) : t ∈ all := by cases t <;> decide

/-- Mastra's own name for the tool (`WORKSPACE_TOOLS`). -/
def name : Tool → String
  | readFile => "mastra_workspace_read_file"
  | listFiles => "mastra_workspace_list_files"
  | grep => "mastra_workspace_grep"
  | fileStat => "mastra_workspace_file_stat"
  | writeFile => "mastra_workspace_write_file"
  | editFile => "mastra_workspace_edit_file"
  | mkdir => "mastra_workspace_mkdir"
  | delete => "mastra_workspace_delete"
  | executeCommand => "mastra_workspace_execute_command"
  | getProcessOutput => "mastra_workspace_get_process_output"
  | killProcess => "mastra_workspace_kill_process"

/-- The neutral `agent.tool.call` kind (`MASTRA_TOOL_KIND`). -/
def kind : Tool → ToolKind
  | readFile | fileStat => .read
  | listFiles | grep => .search
  | writeFile | editFile | mkdir => .edit
  | delete => .delete
  | executeCommand | getProcessOutput | killProcess => .execute

def ofName? (s : String) : Option Tool := all.find? (fun t => t.name == s)

/-- A tool that runs or manages a subprocess: withheld while a read-only grant exists. -/
def isCommand : Tool → Bool
  | executeCommand | getProcessOutput | killProcess => true
  | _ => false

/-- Which switch grants each tool (`MASTRA_TOOL_PERMISSION`). -/
def permitted (p : OpenAiAgents.Permissions) : Tool → Bool
  | readFile | listFiles | grep | fileStat => p.readFiles
  | writeFile | editFile | mkdir | delete => p.writeFiles
  | executeCommand | getProcessOutput | killProcess => p.runCommands

end Tool

/-- The tool plan: every tool its switch allows, in order, with the command tools withheld while a
read-only grant exists (a redirect would write what the grant protects, and a subprocess's writes
never pass the filesystem wrapper). -/
@[aw_spec (ts := "packages/engine-mastra/src/tools.ts#mastraToolPlan")]
def toolPlan (p : OpenAiAgents.Permissions) (hasReadOnlyGrant : Bool) : List Tool :=
  Tool.all.filter fun t => t.permitted p && !(t.isCommand && hasReadOnlyGrant)

/-- The skill tools Mastra adds to a workspace that has skills (`MASTRA_SKILL_TOOL_NAMES`). -/
def skillToolNames : List String := ["skill", "skill_search", "skill_read"]

/-- The kind of a tool call by name: a workspace tool's own, `read` for a skill tool, `mcp` for a
name under one of the run's connectors (`<server>_<tool>`), and `other` otherwise. -/
@[aw_spec (ts := "packages/engine-mastra/src/tools.ts#mastraToolKind")]
def kindOf (connectors : List String) (name : String) : ToolKind :=
  match Tool.ofName? name with
  | some t => t.kind
  | none =>
    if skillToolNames.contains name then .read
    else if connectors.any (fun server => (server ++ "_").toList.isPrefixOf name.toList) then .mcp
    else .other

/-! ## The connection -/

/-- The AI SDK provider factory a protocol is reached through. -/
inductive Api where
  | anthropicMessages
  | openaiResponses
  | openaiChat
  deriving DecidableEq, Repr, Inhabited

def Api.toWire : Api → String
  | .anthropicMessages => "anthropic.messages"
  | .openaiResponses => "openai.responses"
  | .openaiChat => "openai.chat"

def apiFor : OpenAiAgents.Protocol → Api
  | .anthropicMessages => .anthropicMessages
  | .openaiResponses => .openaiResponses
  | .openaiChatCompletions => .openaiChat

/-- The compiled model connection (`mastraModelConnection`): the gateway's `/v1` prefix and the
run token as a bearer. -/
structure Connection where
  protocol : OpenAiAgents.Protocol
  api : Api
  baseUrl : String
  authorization : String
  deriving DecidableEq, Repr, Inhabited

@[aw_spec (ts := "packages/engine-mastra/src/compile.ts#mastraModelConnection")]
def connectionFor (protocol : OpenAiAgents.Protocol) (baseUrl token : String) : Connection :=
  { protocol, api := apiFor protocol,
    baseUrl := OpenAiAgents.stripTrailingSlashes baseUrl ++ "/v1",
    authorization := "Bearer " ++ token }

/-- The AI SDK factory a provider is built with. -/
inductive Factory where
  | createAnthropic
  | createOpenAI
  deriving DecidableEq, Repr, Inhabited

def Factory.toWire : Factory → String
  | .createAnthropic => "createAnthropic"
  | .createOpenAI => "createOpenAI"

/-- The factory option the run token is handed as. -/
inductive AuthOption where
  | authToken
  | apiKey
  deriving DecidableEq, Repr, Inhabited

def AuthOption.toWire : AuthOption → String
  | .authToken => "authToken"
  | .apiKey => "apiKey"

/-- The provider method that picks the dialect. -/
inductive Method where
  | messages
  | responses
  | chat
  deriving DecidableEq, Repr, Inhabited

def Method.toWire : Method → String
  | .messages => "messages"
  | .responses => "responses"
  | .chat => "chat"

/-- The path the AI SDK provider appends to its base URL for each method. A hypothesis about the
provider (see the module header), enforced by the boundary suite. -/
def methodPath : Method → String
  | .messages => "/messages"
  | .responses => "/responses"
  | .chat => "/chat/completions"

/-- The explicit provider `./boundary.ts#modelFor` builds (`MastraProviderSpec`). -/
structure ProviderSpec where
  factory : Factory
  option : AuthOption
  method : Method
  baseURL : String
  deriving DecidableEq, Repr, Inhabited

/-- `mastraProviderSpec`: the factory, token option and method each API is reached through, at the
connection's own base URL. -/
@[aw_spec (ts := "packages/engine-mastra/src/compile.ts#mastraProviderSpec")]
def providerSpec (c : Connection) : ProviderSpec :=
  match c.api with
  | .anthropicMessages =>
    { factory := .createAnthropic, option := .authToken, method := .messages, baseURL := c.baseUrl }
  | .openaiResponses =>
    { factory := .createOpenAI, option := .apiKey, method := .responses, baseURL := c.baseUrl }
  | .openaiChat =>
    { factory := .createOpenAI, option := .apiKey, method := .chat, baseURL := c.baseUrl }

/-- Every **model** request a compiled connection can issue: the provider `providerSpec` builds
appends its method's path to its base URL and sends the bearer. An HTTP connector's requests are
not model requests and are not listed here; they reach the connector's own host. -/
def modelRequests (c : Connection) : List (String × String) :=
  [((providerSpec c).baseURL ++ methodPath (providerSpec c).method, c.authorization)]

/-- How a model can be handed to Mastra: an explicit provider instance, or a `"provider/model"`
string Mastra's router resolves from provider keys in the environment. -/
inductive ModelSpec where
  | provider (spec : ProviderSpec)
  | routedString (id : String)
  deriving DecidableEq, Repr, Inhabited

/-- What `./boundary.ts#modelFor` hands the `Agent`: the provider `mastraProviderSpec` decides. -/
@[aw_spec (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")
  (ts := "packages/engine-mastra/src/compile.ts#mastraProviderSpec")]
def modelSpecOf (c : Connection) : ModelSpec := .provider (providerSpec c)

/-- The protocol list the engine advertises (`MASTRA_WIRE_PROTOCOLS`). -/
def engineProtocols : List String :=
  ["anthropic-messages", "openai-responses", "openai-chat-completions"]

/-! ## The request and compile -/

/-- One connector, as far as compile reads it. -/
structure Connector where
  name : String
  /-- A record this adapter can read (stdio or HTTP/SSE). -/
  readable : Bool
  /-- Some tool of it asks for a human approval. -/
  asksApproval : Bool
  deriving DecidableEq, Repr, Inhabited

inductive SessionMode where
  | fresh
  | resume (engineSessionId : String)
  | fork (engineSessionId : String)
  deriving DecidableEq, Repr, Inhabited

/-- The inputs of one compile. Strings stand for the parts compile reads and nothing more. -/
structure Request where
  /-- The sandbox root the run's paths resolve against (`request.cwd`). -/
  cwd : String
  /-- `sessions.id`. -/
  sessionId : String
  /-- The tenant namespace (`request.projectKey`), Mastra's memory resource. -/
  projectKey : String
  /-- The policy arm parsed as `MastraRunPolicy`. -/
  policyReadable : Bool
  permissions : OpenAiAgents.Permissions
  model : Option String
  /-- The skills the allow-list names (or, for `all`, every granted one). -/
  skills : List String
  session : SessionMode
  maxTurns : Option Nat
  /-- `limits.maxBudgetUsd` is set. -/
  budgetCap : Bool
  /-- `(baseUrl, token, protocol)`, or `none` for a request carrying no gateway. -/
  gateway : Option (String × String × String)
  /-- Spec A.11's verdict over the environment (`Behaviour/SandboxEnv.lean` decides it). -/
  environmentClean : Bool
  /-- The names of the run environment's variables (`request.env`'s keys). -/
  envNames : List String
  /-- `(directory, path, readOnly)` per file grant. -/
  grants : List (Bool × String × Bool)
  /-- The connectors, in record-key order. -/
  connectors : List Connector
  deriving DecidableEq, Repr, Inhabited

/-! ## Database connection variables -/

/-- `\w` in the `DATABASE_ENV` pattern: an ASCII letter, digit or `_`. -/
def isWordChar (c : Char) : Bool := c.isAlphanum || c == '_'

/-- A non-empty run of word characters (`\w+`). -/
def isWordRun (cs : List Char) : Bool := !cs.isEmpty && cs.all isWordChar

/-- libpq's connection variables, as `DATABASE_ENV` lists them. -/
def pgNames : List (List Char) :=
  ["PGHOST", "PGHOSTADDR", "PGPORT", "PGUSER", "PGPASSWORD", "PGPASSFILE", "PGDATABASE",
   "PGSERVICE"].map String.toList

/-- `cs` is `p` followed by a non-empty run of word characters. -/
def prefixedRun (p cs : List Char) : Bool := p.isPrefixOf cs && isWordRun (cs.drop p.length)

/-- The `DATABASE_ENV` pattern over an upper-cased name:
`^(?:(?:\w+_)?DATABASE_URL|PG(?:HOST|…|SERVICE)|(?:LIBSQL|TURSO)_\w+)$`. -/
def matchesDatabaseEnv (cs : List Char) : Bool :=
  cs == "DATABASE_URL".toList ||
    ("_DATABASE_URL".toList.isSuffixOf cs &&
      isWordRun (cs.take (cs.length - "_DATABASE_URL".length))) ||
    pgNames.contains cs || prefixedRun "LIBSQL_".toList cs || prefixedRun "TURSO_".toList cs

/-- Does a variable name carry a database connection? The name is upper-cased first, as
`databaseEnvName` does. `Char.toUpper` is ASCII-only while JavaScript's `toUpperCase` is not; a
name the model matches is all ASCII, where the two agree, so the TypeScript refuses at least every
name the model does. -/
@[aw_spec (ts := "packages/engine-mastra/src/compile.ts#databaseEnvName")]
def isDatabaseEnvName (name : String) : Bool := matchesDatabaseEnv (name.toList.map Char.toUpper)

/-- No variable of the environment carries a database connection (`databaseEnvName` is `null`). -/
def databaseEnvClean (names : List String) : Bool := !names.any isDatabaseEnvName

/-- The protected directory this adapter declares. -/
def protectedDirectory : String := ".mastra"

/-- Where the platform's skills are placed; the workspace discovers `SKILL.md` under it. -/
def skillsDirectory : String := ".mastra/skills"

/-- The model a run that names none is given, per protocol family (`MASTRA_DEFAULT_MODELS`). -/
def defaultModel : OpenAiAgents.Protocol → String
  | .anthropicMessages => "claude-sonnet-4-5"
  | _ => "gpt-5"

def modelOf (r : Request) (p : OpenAiAgents.Protocol) : String := r.model.getD (defaultModel p)

/-- Can a cap on this model be priced? The port's provisional table (`provisionalPriceFor`). -/
@[aw_spec (ts := "packages/engine/src/prices.ts#provisionalPriceFor")]
def priced (model : String) : Bool := OpenAiAgents.pricedModels.contains model

/-- `MASTRA_MEMORY_LAST_MESSAGES`. -/
def lastMessages : Nat := 40

/-- The memory configuration of a compiled run (`MastraCompiled.memory`). -/
structure Memory where
  threadId : String
  resourceId : String
  lastMessages : Nat
  semanticRecall : Bool
  workingMemory : Bool
  generateTitle : Bool
  deriving DecidableEq, Repr, Inhabited

/-- Telemetry and exporters (`MastraCompiled.observability`). -/
structure Observability where
  telemetry : Bool
  exporters : List String
  deriving DecidableEq, Repr, Inhabited

/-- The memory a thread runs under: recall, working memory and title generation off. -/
def memoryFor (threadId resourceId : String) : Memory :=
  { threadId, resourceId, lastMessages, semanticRecall := false, workingMemory := false,
    generateTitle := false }

def observabilityOff : Observability := { telemetry := false, exporters := [] }

/-! ## The process environment Mastra loads under -/

/-- `MASTRA_PROCESS_ENVIRONMENT`: the switches the boundary sets before Mastra loads. -/
@[aw_spec (ts := "packages/engine-mastra/src/boundary.ts#MASTRA_PROCESS_ENVIRONMENT")]
def processSwitches : List (String × String) :=
  [("MASTRA_TELEMETRY_DISABLED", "1"), ("MASTRA_OFFLINE", "1")]

/-- The provider base-URL variables an empty value of which is removed before the providers load. -/
def emptiedBaseUrls : List String := ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]

/-- Does the boundary keep this variable of the runner's environment as it was? Not a switch it
sets, and not an empty provider base URL. -/
def keptVariable (entry : String × String) : Bool :=
  !(processSwitches.map Prod.fst).contains entry.1 &&
    !(emptiedBaseUrls.contains entry.1 && entry.2 == "")

/-- `mastraInstalledEnvironment`: the environment Mastra sees when it loads, from whatever the
runner's process held — the switches set, an empty provider base URL removed, the rest kept. -/
@[aw_spec (ts := "packages/engine-mastra/src/boundary.ts#mastraInstalledEnvironment")]
def installedEnvironment (env : List (String × String)) : List (String × String) :=
  processSwitches ++ env.filter keptVariable

/-- Insert a skill name into a sorted list without repeats. -/
def insertSkill (name : String) : List String → List String
  | [] => [name]
  | x :: rest =>
    if name == x then x :: rest
    else if name < x then name :: x :: rest
    else x :: insertSkill name rest

/-- The skills a compile names: the request's names without repeats, sorted. -/
def skillSet (names : List String) : List String := names.foldr insertSkill []

/-- The compiled configuration, as far as the theorems read it. -/
structure Compiled where
  cwd : String
  tools : List Tool
  skillTools : Bool
  networkEgress : Bool
  connection : Connection
  model : String
  maxSteps : Option Nat
  budgetCap : Bool
  grants : List Grant
  skills : List String
  connectors : List String
  memory : Memory
  observability : Observability
  deriving DecidableEq, Repr, Inhabited

inductive Outcome where
  | ok (compiled : Compiled)
  | refused (refusal : OpenAiAgents.Refusal)
  deriving DecidableEq, Repr, Inhabited

/-- The connectors compile hands `MCPClient`, in order; an unreadable record is refused
`engine_policy_invalid`, a tool asking for an approval `engine_capability_unsupported`. -/
@[aw_spec (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")]
def compileConnectors : List Connector → Except OpenAiAgents.Refusal (List String)
  | [] => .ok []
  | c :: rest =>
    if !c.readable then .error (.policyInvalid "connector")
    else if c.asksApproval then .error (.capabilityUnsupported "approvals")
    else (compileConnectors rest).map (c.name :: ·)

/-- No connector compiles to none. Proved through `compileConnectors.eq_def` so that equation is
generated here, beside the definition, rather than in the theorem module that first unfolds it. -/
theorem compileConnectors_nil : compileConnectors [] = .ok [] := by
  rw [compileConnectors.eq_def]

/-- The thread a run's memory runs under: the platform session, or the one a resume names; `none`
for a fork, which a Mastra thread cannot do. -/
def threadOf (r : Request) : Option String :=
  match r.session with
  | .fresh => some r.sessionId
  | .resume sid => some sid
  | .fork _ => none

/-- The compiled half after every check has passed. -/
def compileWith (r : Request) (grants : List Grant) (baseUrl token : String)
    (protocol : OpenAiAgents.Protocol) (connectors : List String) (threadId : String) :
    Compiled :=
  let skills := skillSet r.skills
  { cwd := OpenAiAgents.stripTrailingSlashes r.cwd,
    tools := toolPlan r.permissions (grants.any (·.readOnly)),
    skillTools := !skills.isEmpty,
    networkEgress := r.permissions.unrestrictedNetwork,
    connection := connectionFor protocol baseUrl token, model := modelOf r protocol,
    maxSteps := r.maxTurns, budgetCap := r.budgetCap, grants, skills, connectors,
    memory := memoryFor threadId r.projectKey, observability := observabilityOff }

/-- `compileMastraRun`, check for check and in the same order. -/
@[aw_spec (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")]
def compile (r : Request) : Outcome :=
  if !r.policyReadable then .refused (.policyInvalid "policy")
  else match normaliseGrants (some protectedDirectory) r.grants with
  | none => .refused (.policyInvalid "grants")
  | some grants =>
    match r.gateway with
    | none => .refused (.credentialRefused "gateway")
    | some (baseUrl, token, wire) =>
      match OpenAiAgents.Protocol.ofWire? wire with
      | none => .refused (.capabilityUnsupported "wireProtocols")
      | some protocol =>
        if !r.environmentClean then .refused (.credentialRefused "environment")
        else if !databaseEnvClean r.envNames then .refused (.credentialRefused "database")
        else if r.budgetCap && !priced (modelOf r protocol) then
          .refused (.capabilityUnsupported "maxBudget")
        else match compileConnectors r.connectors with
        | .error e => .refused e
        | .ok names =>
          match threadOf r with
          | none => .refused (.capabilityUnsupported "fork")
          | some threadId => .ok (compileWith r grants baseUrl token protocol names threadId)

/-- The shape of every accepted compile: every check passed, and the compiled half was built from
what they read. A lemma the family's theorems share; it states no property of its own. -/
theorem compile_ok_shape {r : Request} {c : Compiled} (h : compile r = .ok c) :
    ∃ grants b t w p names tid,
      normaliseGrants (some protectedDirectory) r.grants = some grants ∧
      r.gateway = some (b, t, w) ∧ OpenAiAgents.Protocol.ofWire? w = some p ∧
      r.environmentClean = true ∧ databaseEnvClean r.envNames = true ∧
      compileConnectors r.connectors = .ok names ∧ threadOf r = some tid ∧
      c = compileWith r grants b t p names tid := by
  unfold compile at h
  split at h
  · cases h
  · rename_i hpol
    split at h
    · cases h
    · rename_i grants hg
      split at h
      · cases h
      · rename_i b t w hgw
        split at h
        · cases h
        · rename_i p hp
          split at h
          · cases h
          · rename_i he
            split at h
            · cases h
            · rename_i hd
              split at h
              · cases h
              · split at h
                · cases h
                · rename_i names hn
                  split at h
                  · cases h
                  · rename_i tid ht
                    cases h
                    refine ⟨grants, b, t, w, p, names, tid, hg, hgw, hp, ?_, ?_, hn, ht, rfl⟩
                    · simpa using he
                    · simpa using hd

/-! ## The filesystem wrapper -/

/-- Where a path a tool named lands, before any grant is consulted (`mastraWorkspacePath`). -/
inductive Resolved where
  /-- A leading `~`, which `LocalFilesystem` expands to the home directory. -/
  | tilde
  /-- An absolute path outside the workspace root. -/
  | outside
  /-- The workspace root itself. -/
  | root
  /-- A workspace-relative path, not yet normalised. -/
  | relative (path : String)
  deriving DecidableEq, Repr, Inhabited

/-- Is this relative spelling the root (`''`, `.`, `./`)? -/
def isRootSpelling (cs : List Char) : Bool := cs == [] || cs == ['.'] || cs == ['.', '/']

/-- `mastraWorkspacePath`, before its normalisation: `LocalFilesystem`'s own resolution restated
(`~` expanded, an absolute path taken as is, anything else under the base path), with the two
spellings that leave the workspace refused. The comparison is on the character list. -/
@[aw_spec (ts := "packages/engine-mastra/src/workspace.ts#mastraWorkspacePath")]
def resolveWorkspacePath (cwd input : String) : Resolved :=
  let cs := input.toList
  if cs.head? == some '~' then .tilde
  else
    let root := (OpenAiAgents.stripTrailingSlashes cwd).toList
    if cs.head? == some '/' then
      if (OpenAiAgents.stripTrailingSlashes input).toList == root then .root
      else if (root ++ ['/']).isPrefixOf cs then
        let rest := cs.drop (root.length + 1)
        if isRootSpelling rest then .root else .relative (String.ofList rest)
      else .outside
    else if isRootSpelling cs then .root
    else .relative input

/-- Why a write was refused. -/
inductive WriteRefusal where
  | tilde
  | outside
  | workspaceRoot
  | grant (reason : Refusal)
  deriving DecidableEq, Repr, Inhabited

inductive WriteVerdict where
  | ok (segments : List String)
  | refused (reason : WriteRefusal)
  deriving DecidableEq, Repr, Inhabited

def WriteVerdict.isOk : WriteVerdict → Bool
  | .ok _ => true
  | .refused _ => false

/-- `mastraWriteVerdict`: resolve the path, refuse what leaves the workspace and the root itself,
and ask `writeGrantVerdict` about the rest. -/
@[aw_spec (ts := "packages/engine-mastra/src/workspace.ts#mastraWriteVerdict")
  (ts := "packages/engine-mastra/src/workspace.ts#mastraRelativeWriteVerdict")]
def writeVerdict (c : Compiled) (input : String) : WriteVerdict :=
  match resolveWorkspacePath c.cwd input with
  | .tilde => .refused .tilde
  | .outside => .refused .outside
  | .root => .refused .workspaceRoot
  | .relative p =>
    match writeGrantVerdict (some protectedDirectory) c.grants p with
    | .ok segments => .ok segments
    | .refused r => .refused (.grant r)

/-- May the wrapped filesystem write `candidate`? `mastraWriteAllowed`. -/
@[aw_spec (ts := "packages/engine-mastra/src/workspace.ts#mastraWriteAllowed")]
def writeAllowed (c : Compiled) (candidate : String) : Bool := (writeVerdict c candidate).isOk

/-- Does the subtree at `segments` hold a read-only grant or the adapter's own directory
(`mastraRelativeSubtreeVerdict`)? Segment by segment: the candidate is a prefix of what it holds. -/
@[aw_spec (ts := "packages/engine-mastra/src/workspace.ts#mastraRelativeSubtreeVerdict")]
def holdsProtected (c : Compiled) (segments : List String) : Bool :=
  segments.isPrefixOf [protectedDirectory] ||
    c.grants.any fun g => g.readOnly && segments.isPrefixOf g.segments

/-- `mastraRemoveVerdict`: a path may be removed, or moved away, when it may be written and its
subtree holds nothing protected. `deleteFile`, `rmdir` and `moveFile`'s source ask it. -/
@[aw_spec (ts := "packages/engine-mastra/src/workspace.ts#mastraRemoveVerdict")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
def removeAllowed (c : Compiled) (candidate : String) : Bool :=
  match writeVerdict c candidate with
  | .ok segments => !holdsProtected c segments
  | .refused _ => false

/-! ## The event mapping -/

/-- One `fullStream` chunk, as the mapper reads it. -/
inductive Chunk where
  /-- `text-delta`; `none` for a missing part id or text. -/
  | textDelta (id : Option String) (text : Option String)
  | reasoningDelta (id : Option String) (text : Option String)
  | textEnd (id : Option String)
  | reasoningEnd (id : Option String)
  | toolCall (callId : Option String) (name : Option String)
  /-- `tool-result`, its output already rendered as text. -/
  | toolResult (callId : Option String) (output : String) (isError : Bool)
  /-- `tool-error`, its error's message. -/
  | toolError (callId : Option String) (message : String)
  | error
  | stepFinish
  /-- Every other chunk, by type: `start`, `step-start`, `tool-call-delta`, … -/
  | other (type : String)
  | notAnObject
  | untyped
  /-- The adapter's terminal event, built from Mastra's `finish`. -/
  | completed (stop : StopReason) (steps : Nat) (usage : Option Usage)
  deriving DecidableEq, Repr, Inhabited

/-- The mapper's state: announced call ids, the text of each open part (keyed by kind and id),
and the steps seen. -/
structure MapState where
  announced : List String
  parts : List ((BlockKind × String) × String)
  steps : Nat
  deriving DecidableEq, Repr, Inhabited

def MapState.empty : MapState := { announced := [], parts := [], steps := 0 }

/-- The text a part has gathered so far. -/
def partText (parts : List ((BlockKind × String) × String)) (key : BlockKind × String) : String :=
  (parts.lookup key).getD ""

/-- Append to a part's text, keeping one entry per part. -/
def appendPart (parts : List ((BlockKind × String) × String)) (key : BlockKind × String)
    (text : String) : List ((BlockKind × String) × String) :=
  (key, partText parts key ++ text) :: parts.filter (fun e => e.1 != key)

def blockOf : BlockKind → String → Block
  | .text, v => .text v
  | .reasoning, v => .reasoning v

def blockName : BlockKind → String
  | .text => "text"
  | .reasoning => "reasoning"

/-- A delta: the frame, and the part's text grown. -/
def deltaStep (s : MapState) (kind : BlockKind) : Option String → Option String → MapState × List Frame
  | some id, some text =>
    ({ s with parts := appendPart s.parts (kind, id) text }, [.delta (some id) kind text])
  | _, _ => (s, [.malformed ("a " ++ blockName kind ++ " delta without a part id or text")])

/-- The end of a part: one message carrying the part's joined text. -/
def endStep (s : MapState) (kind : BlockKind) : Option String → MapState × List Frame
  | some id =>
    ({ s with parts := s.parts.filter (fun e => e.1 != (kind, id)) },
      [.message (some id) .assistant [blockOf kind (partText s.parts (kind, id))]])
  | none => (s, [.malformed ("a " ++ blockName kind ++ " end without a part id")])

/-- A tool's answer: paired with an announced call, or malformed. -/
def answerStep (s : MapState) (callId : Option String) (output : String) (isError : Bool) :
    MapState × List Frame :=
  match callId with
  | none => (s, [.malformed "a tool result without a call id"])
  | some id =>
    if s.announced.contains id then
      ({ s with announced := s.announced.erase id },
        [.toolResult id (if isError then .failed else .completed) output isError])
    else (s, [.malformed "a tool result for a call no tool call announced"])

/-- One chunk, given the mapper's state: the next state and the frames. Native payloads are
carried as `null`; the replay compares every neutral field. -/
@[aw_spec (ts := "packages/engine-mastra/src/frames.ts#createMastraFrameMapper")]
def step (connectors : List String) (s : MapState) : Chunk → MapState × List Frame
  | .textDelta id text => deltaStep s .text id text
  | .reasoningDelta id text => deltaStep s .reasoning id text
  | .textEnd id => endStep s .text id
  | .reasoningEnd id => endStep s .reasoning id
  | .toolCall (some callId) (some name) =>
    -- The TypeScript mapper keeps a `Set`: a repeated call announces nothing new.
    ({ s with announced := if s.announced.contains callId then s.announced
                           else s.announced ++ [callId] },
      [.toolCall callId name (kindOf connectors name) .null])
  | .toolCall _ _ => (s, [.malformed "a tool call without a call id or a tool name"])
  | .toolResult callId output isError => answerStep s callId output isError
  | .toolError callId message => answerStep s callId message true
  | .error => (s, [.result .error (some s.steps) none])
  | .stepFinish => ({ s with steps := s.steps + 1 }, [.native "step-finish" .null])
  | .other type => (s, [.native type .null])
  | .notAnObject => (s, [.malformed "a Mastra chunk that is not an object"])
  | .untyped => (s, [.malformed "a Mastra chunk without a type"])
  | .completed stop steps usage =>
    (s, (usage.map Frame.usage).toList ++ [.result stop (some steps) none])

/-- A whole stream, from a state. -/
def mapFrom (connectors : List String) : MapState → List Chunk → List Frame
  | _, [] => []
  | s, e :: rest =>
    let (next, frames) := step connectors s e
    frames ++ mapFrom connectors next rest

/-- An empty stream maps to no frame; stated through `mapFrom.eq_def` so the equation is generated
here, beside the definition. -/
theorem mapFrom_nil (connectors : List String) (s : MapState) : mapFrom connectors s [] = [] := by
  rw [mapFrom.eq_def]

def mapAll (connectors : List String) (chunks : List Chunk) : List Frame :=
  mapFrom connectors MapState.empty chunks

/-! ## The step limit -/

/-- The run's stop over the steps its model would take, in order: each flag says whether that step
asked for tools (Mastra would take another step). A step that asked for none ends the run
`end_turn`; the step that reaches `maxSteps` still asking for tools is the last Mastra takes, and
the adapter reports the run `max_turns`. The first component is the steps taken. -/
@[aw_spec (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
def stepRun (limit : Option Nat) : Nat → List Bool → Nat × StopReason
  | n, [] => (n, .endTurn)
  | n, continues :: rest =>
    if !continues then (n + 1, .endTurn)
    else match limit with
      | some m => if m ≤ n + 1 then (n + 1, .maxTurns) else stepRun limit (n + 1) rest
      | none => stepRun limit (n + 1) rest

theorem stepRun_nil (limit : Option Nat) (n : Nat) : stepRun limit n [] = (n, .endTurn) := by
  rw [stepRun.eq_def]

/-- `mastraStopReason`: the adapter's verdict on a drained run. The budget cap wins, then the
caller's interrupt; otherwise a run whose last allowed step still asked for tools
(`stepResult.reason` is `tool-calls`) was cut short, and any other ends `end_turn`. -/
@[aw_spec (ts := "packages/engine-mastra/src/boundary.ts#mastraStopReason")]
def stopReason (steps : Nat) (lastStepReason : Option String) (maxSteps : Option Nat)
    (overBudget interrupted : Bool) : StopReason :=
  if overBudget then .maxBudget
  else if interrupted then .cancelled
  else match maxSteps with
    | some m => if m ≤ steps && lastStepReason == some "tool-calls" then .maxTurns else .endTurn
    | none => .endTurn

/-! ## The boundary's stream loop -/

/-- A chunk of Mastra's `fullStream` as the boundary's loop reads it: `finish`, or any other. -/
inductive Raw where
  | chunk (c : Chunk)
  | finish
  deriving DecidableEq, Repr, Inhabited

/-- The chunks the loop forwards as it reads them: every one but `finish`, which only the loop's
end can place. -/
def forwarded : List Raw → List Chunk
  | [] => []
  | .chunk c :: rest => c :: forwarded rest
  | .finish :: rest => forwarded rest

/-- No raw chunk forwards none; stated through `forwarded.eq_def` so the equation is generated
here, beside the definition. -/
theorem forwarded_nil : forwarded [] = [] := by
  rw [forwarded.eq_def]

/-- The events `startMastraRun` yields for a stream: the forwarded chunks, then — after an `error`
chunk — the `finish` as a native chunk if one came, or otherwise the adapter's terminal event built
from `finish` (`terminal`: the stop, the steps and the usage). -/
@[aw_spec (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
def boundaryEvents (raws : List Raw) (terminal : StopReason × Nat × Option Usage) : List Chunk :=
  if raws.contains (.chunk .error) then
    forwarded raws ++ (if raws.contains .finish then [.other "finish"] else [])
  else forwarded raws ++ [.completed terminal.1 terminal.2.1 terminal.2.2]

/-! ## Memory -/

/-- One message of a thread, as far as the journal reads it. -/
structure Message where
  id : String
  threadId : String
  body : String
  deriving DecidableEq, Repr, Inhabited

/-- One store entry the journal writes, or one it did not. -/
inductive Entry where
  | thread (id : String)
  | message (m : Message)
  | foreign
  deriving DecidableEq, Repr, Inhabited

/-- Replace the message with this id, or append it (the store's upsert by `key`). -/
def upsert (m : Message) : List Message → List Message
  | [] => [m]
  | x :: rest => if x.id == m.id then m :: rest else x :: upsert m rest

/-- Upserting into no message appends it. Proved through `upsert.eq_def` so that equation is
generated here, beside the definition, rather than in the theorem module that first unfolds it. -/
theorem upsert_nil (m : Message) : upsert m [] = [m] := by
  rw [upsert.eq_def]

/-- The journal of a thread: its record, then one entry per message (`threadEntry`,
`messageEntry`). -/
@[aw_spec (ts := "packages/engine-mastra/src/session.ts#MastraMemoryJournal")]
def journal (threadId : String) (messages : List Message) : List Entry :=
  .thread threadId :: messages.map .message

/-- The fold `readMastraThread` performs: the last thread record wins, messages are upserted by
id, and a message of another thread or an entry this adapter does not write is a refusal. -/
def fold (tid : String) : Option String → List Message → List Entry →
    Option (Option String × List Message)
  | th, acc, [] => some (th, acc)
  | _, acc, .thread id :: rest => fold tid (some id) acc rest
  | th, acc, .message m :: rest =>
    if m.threadId == tid then fold tid th (upsert m acc) rest else none
  | _, _, .foreign :: _ => none

/-- An exhausted stream folds to what was read. Proved through `fold.eq_def` so that equation is
generated here, beside the definition, rather than in the theorem module that first unfolds it. -/
theorem fold_nil (tid : String) (th : Option String) (acc : List Message) :
    fold tid th acc [] = some (th, acc) := by
  rw [fold.eq_def]

/-- `readMastraThread`: the thread's messages, or `none` when the stream is not this thread's. -/
@[aw_spec (ts := "packages/engine-mastra/src/session.ts#readMastraThread")]
def readThread (tid : String) (entries : List Entry) : Option (List Message) :=
  match fold tid none [] entries with
  | some (some t, messages) => if t == tid then some messages else none
  | _ => none

end AgentWorkspace.Behaviour.Engines.Mastra
