import AgentWorkspace.Authz.PathGrant
import AgentWorkspace.Events.AgentFrames
import AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-!
# The pi coding agent adapter (ENG-08, #307)

`packages/engine-pi` puts the pi coding agent (`@earendil-works/pi-coding-agent`) behind the engine
port. This module models the decisions the adapter owns, as pure functions over explicit inputs:

1. **compile** (`src/compile.ts#compilePiRun`) — the portable core plus the `pi` policy arm into a
   tool set, a gateway configuration and limits, or a refusal naming the capability it could not
   honour;
2. **the tool plan and the guard** (`src/tools.ts#piToolPlan`,
   `src/workspace.ts#piToolCallVerdict`) — the four permission switches into pi's built-in tools,
   and the `beforeToolCall` decision on each call;
3. **the pinned resource loader** (`src/boundary.ts#startPiRun`) — the only resources pi is handed;
4. **the event mapping** (`src/frames.ts#createPiFrameMapper`) — pi's session events into the
   neutral `agent.*` frames of `Events/AgentFrames.lean`;
5. **the turn limit** — `turn_end` counted, and pi-agent-core's `terminate` hint after the last
   allowed turn;
6. **the session** (`src/session.ts#PiSessionMirror`) — pi's JSONL tree over the store stream.

The path rules are `Authz/PathGrant.lean`'s, the frames `Events/AgentFrames.lean`'s, and the
permission switches, refusal codes, the provisional price list and the frame vocabulary are
`Behaviour/Engines/OpenAiAgents.lean`'s; none is re-modelled here.

## What is a hypothesis rather than a theorem

Four things happen inside pi and cannot be proved in Lean. Each is stated here, enforced by a test
(`packages/engine-pi/src/boundary.test.ts`, which runs real pi against a local fake gateway), and
listed under the unit's declared gaps:

* pi issues model requests only to the model's `baseUrl` + `/v1/messages`, with the model's
  `headers` (the suite records every request, and a decoy `ANTHROPIC_BASE_URL` receives none);
* pi reads resources only through the `ResourceLoader` it is handed (the suite plants a hostile
  extension, skills and context files under `~/.pi`, `~/.agents` and the project, and asserts
  none reaches the system prompt or runs);
* pi calls `beforeToolCall` before every tool execution and honours `{ block: true }` (the suite
  asserts a blocked write leaves the file unchanged);
* pi-agent-core ends a run after a tool batch whose results all carry `terminate` (the suite's
  `maxTurns` case sends no request past the limit).
-/

namespace AgentWorkspace.Behaviour.Engines.Pi

open AgentWorkspace AgentWorkspace.Authz.PathGrant AgentWorkspace.Events.AgentFrames

/-! ## The tools -/

/-- pi's four built-in tools the adapter can offer, in `PI_TOOL_NAMES` order. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#PI_TOOL_NAMES")]
inductive Tool where
  | read
  | write
  | edit
  | bash
  deriving DecidableEq, Repr, Inhabited

namespace Tool

def all : List Tool := [read, write, edit, bash]

theorem all_complete (t : Tool) : t ∈ all := by cases t <;> decide

/-- pi's own name for the tool (`createAgentSession({ tools })`). -/
def name : Tool → String
  | read => "read"
  | write => "write"
  | edit => "edit"
  | bash => "bash"

/-- The neutral `agent.tool.call` kind (`PI_TOOL_KIND`). -/
def kind : Tool → ToolKind
  | read => .read
  | write | edit => .edit
  | bash => .execute

def ofName? (s : String) : Option Tool := all.find? (fun t => t.name == s)

/-- Which switch grants each tool (`PI_TOOL_PERMISSION`). -/
def permitted (p : OpenAiAgents.Permissions) : Tool → Bool
  | read => p.readFiles
  | write | edit => p.writeFiles
  | bash => p.runCommands

end Tool

/-- The tool plan: every tool its switch allows, in order, with `bash` withheld while a read-only
grant exists (a redirect would write what the grant protects). -/
@[aw_spec (ts := "packages/engine-pi/src/tools.ts#piToolPlan")]
def toolPlan (p : OpenAiAgents.Permissions) (hasReadOnlyGrant : Bool) : List Tool :=
  Tool.all.filter fun t => t.permitted p && !(t == .bash && hasReadOnlyGrant)

/-! ## The connection -/

/-- The compiled model connection (`piModelConnection`): the gateway's base URL, the run token as
the model's `authorization` header, and the public placeholder pi insists on as a key. -/
structure Connection where
  baseUrl : String
  authorization : String
  apiKey : String
  deriving DecidableEq, Repr, Inhabited

/-- `PI_GATEWAY_API_KEY_PLACEHOLDER`: public, fixed, and never an authenticator. -/
def apiKeyPlaceholder : String := "agent-workspace-gateway-uses-the-bearer-header"

@[aw_spec (ts := "packages/engine-pi/src/compile.ts#piModelConnection")]
def connectionFor (baseUrl token : String) : Connection :=
  { baseUrl := OpenAiAgents.stripTrailingSlashes baseUrl,
    authorization := "Bearer " ++ token,
    apiKey := apiKeyPlaceholder }

/-- Every model request a compiled connection can issue: pi-ai's Anthropic client appends
`/v1/messages` to the model's base URL and sends the model's `authorization` header. -/
def modelRequests (c : Connection) : List (String × String) :=
  [(c.baseUrl ++ "/v1/messages", c.authorization)]

/-- The protocol list the engine advertises: Anthropic Messages alone (`PI_WIRE_PROTOCOLS`). -/
def engineProtocols : List String := ["anthropic-messages"]

/-! ## The request and compile -/

inductive SessionMode where
  | fresh
  | resume
  | fork
  deriving DecidableEq, Repr, Inhabited

/-- The inputs of one compile. Strings stand for the parts compile reads and nothing more. -/
structure Request where
  /-- The sandbox root the run's paths resolve against (`request.cwd`). -/
  cwd : String
  /-- The policy arm parsed as `PiRunPolicy`. -/
  policyReadable : Bool
  permissions : OpenAiAgents.Permissions
  model : Option String
  /-- The skills the allow-list names (or, for `all`, every granted one). -/
  skills : List String
  session : SessionMode
  /-- A fork naming the session it would create. -/
  forksIntoItself : Bool
  maxTurns : Option Nat
  /-- `limits.maxBudgetUsd` is set. -/
  budgetCap : Bool
  /-- `(baseUrl, token, protocol)`, or `none` for a request carrying no gateway. -/
  gateway : Option (String × String × String)
  /-- Spec A.11's verdict over the environment (`Behaviour/SandboxEnv.lean` decides it). -/
  environmentClean : Bool
  /-- `(directory, path, readOnly)` per file grant. -/
  grants : List (Bool × String × Bool)
  /-- The connector record keys. -/
  connectors : List String
  deriving DecidableEq, Repr, Inhabited

/-- The protected directory this adapter declares: pi's own project directory name. -/
def protectedDirectory : String := ".pi"

/-- Where the platform's skills are placed, and the one directory the pinned loader reads. -/
def skillsDirectory : String := ".pi/skills"

/-- pi's own default Anthropic model, compiled when a run names none
(`PI_DEFAULT_ANTHROPIC_MODEL`). -/
def defaultModel : String := "claude-opus-4-8"

/-- The model a run is compiled with. -/
def modelOf (r : Request) : String := r.model.getD defaultModel

/-- Can a cap on this model be priced? The port's provisional table (`provisionalPriceFor`). -/
@[aw_spec (ts := "packages/engine/src/prices.ts#provisionalPriceFor")]
def priced (model : String) : Bool := OpenAiAgents.pricedModels.contains model

/-- Insert a skill name into a sorted list without repeats, keeping it sorted and without repeats. -/
def insertSkill (name : String) : List String → List String
  | [] => [name]
  | x :: rest =>
    if name == x then x :: rest
    else if name < x then name :: x :: rest
    else x :: insertSkill name rest

/-- The skills a compile hands the loader: the request's names without repeats, sorted
(`[...new Set(skillNames)].sort()`). Strings compare by code point here and by UTF-16 code unit in
TypeScript; the two agree on every name below U+10000, which a skill name is. -/
@[aw_spec (ts := "packages/engine-pi/src/compile.ts#compilePiRun")]
def skillSet (names : List String) : List String := names.foldr insertSkill []

/-- The compiled configuration, as far as the theorems read it. -/
structure Compiled where
  /-- The sandbox root without trailing slashes (`workspace.cwd`). -/
  cwd : String
  tools : List Tool
  networkEgress : Bool
  connection : Connection
  model : String
  maxTurns : Option Nat
  budgetCap : Bool
  grants : List Grant
  skills : List String
  deriving DecidableEq, Repr, Inhabited

inductive Outcome where
  | ok (compiled : Compiled)
  | refused (refusal : OpenAiAgents.Refusal)
  deriving DecidableEq, Repr, Inhabited

/-- The compiled half after the gateway has been read. -/
def compileWith (r : Request) (grants : List Grant) (baseUrl token : String) : Compiled :=
  { cwd := OpenAiAgents.stripTrailingSlashes r.cwd,
    tools := toolPlan r.permissions (grants.any (·.readOnly)),
    networkEgress := r.permissions.unrestrictedNetwork,
    connection := connectionFor baseUrl token, model := modelOf r, maxTurns := r.maxTurns,
    budgetCap := r.budgetCap, grants, skills := skillSet r.skills }

/-- `compilePiRun`, check for check and in the same order. -/
@[aw_spec (ts := "packages/engine-pi/src/compile.ts#compilePiRun")]
def compile (r : Request) : Outcome :=
  if !r.policyReadable then .refused (.policyInvalid "policy")
  else match normaliseGrants (some protectedDirectory) r.grants with
  | none => .refused (.policyInvalid "grants")
  | some grants =>
    if !r.connectors.isEmpty then .refused (.capabilityUnsupported "mcp")
    else if r.budgetCap && !priced (modelOf r) then .refused (.capabilityUnsupported "maxBudget")
    else match r.gateway with
    | none => .refused (.credentialRefused "gateway")
    | some (baseUrl, token, wire) =>
      if wire != "anthropic-messages" then .refused (.capabilityUnsupported "wireProtocols")
      else if !r.environmentClean then .refused (.credentialRefused "environment")
      else if r.session == .fork && r.forksIntoItself then .refused (.policyInvalid "fork")
      else .ok (compileWith r grants baseUrl token)

/-- The shape of every accepted compile: the request's grants normalised, its gateway read, and the
compiled half built from them. A lemma the family's theorems share; it states no property of its
own. -/
theorem compile_ok_shape {r : Request} {c : Compiled} (h : compile r = .ok c) :
    ∃ grants b t,
      normaliseGrants (some protectedDirectory) r.grants = some grants ∧
      r.gateway = some (b, t, "anthropic-messages") ∧ r.connectors = [] ∧
      c = compileWith r grants b t := by
  unfold compile at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i grants hg
      split at h
      · cases h
      · rename_i hc
        split at h
        · cases h
        · split at h
          · cases h
          · rename_i b t w hgw
            split at h
            · cases h
            · rename_i hw
              split at h
              · cases h
              · split at h
                · cases h
                · cases h
                  refine ⟨grants, b, t, hg, ?_, ?_, rfl⟩
                  · simp only [bne_iff_ne, ne_eq, Decidable.not_not] at hw
                    rw [hgw, hw]
                  · simpa using hc

/-! ## The guard (`beforeToolCall`) -/

/-- The characters pi's `normalizeUnicodeSpaces` folds into an ASCII space (`REWRITTEN_SPACES`):
U+00A0, U+1680, U+2000–U+200B, U+202F, U+205F, U+3000 and U+FEFF. -/
def isRewrittenSpace (c : Char) : Bool :=
  let n := c.toNat
  n == 0xA0 || n == 0x1680 || (0x2000 ≤ n && n ≤ 0x200B) || n == 0x202F || n == 0x205F ||
    n == 0x3000 || n == 0xFEFF

/-- Where a model-supplied path lands, before any grant is consulted. -/
inductive Resolved where
  /-- A spelling pi rewrites before it resolves the path — a leading `~` or `@`, or a Unicode
  space — refused rather than re-implemented. -/
  | rewritten
  /-- The workspace root itself: `.`, `./`, the sandbox root, or the root with a slash. -/
  | root
  /-- A workspace-relative path, not yet normalised: the input itself, or what follows the
  sandbox root in an absolute path below it. -/
  | relative (path : String)
  deriving DecidableEq, Repr, Inhabited

/-- `resolveWorkspacePath`, before its normalisation: refuse a rewritten spelling, strip an
absolute `cwd` prefix, and map `.` or `cwd` to the root. An absolute path outside `cwd` is left as
it is, so normalising it refuses it as absolute. The comparison is on the character list, which
reduces in the kernel where `String.startsWith` does not. -/
@[aw_spec (ts := "packages/engine-pi/src/workspace.ts#resolveWorkspacePath")]
def resolveWorkspacePath (cwd input : String) : Resolved :=
  let cs := input.toList
  if cs.head? == some '~' || cs.head? == some '@' || cs.any isRewrittenSpace then .rewritten
  else
    let root := (OpenAiAgents.stripTrailingSlashes cwd).toList
    let relative : List Char :=
      if cs == root || cs == root ++ ['/'] then ['.']
      else if (root ++ ['/']).isPrefixOf cs then cs.drop (root.length + 1)
      else cs
    if relative == ['.'] || relative == ['.', '/'] || relative == [] then .root
    else .relative (String.ofList relative)

/-- Why a write was refused: a rewritten spelling, the workspace root itself (which is not a file),
or the grant check's own refusal. -/
inductive WriteRefusal where
  | rewrittenSpelling
  | workspaceRoot
  | grant (reason : Refusal)
  deriving DecidableEq, Repr, Inhabited

/-- The write decision: the normalised segments written, or the refusal by name. -/
inductive WriteVerdict where
  | ok (segments : List String)
  | refused (reason : WriteRefusal)
  deriving DecidableEq, Repr, Inhabited

namespace WriteVerdict

/-- Was the write allowed? -/
def isOk : WriteVerdict → Bool
  | .ok _ => true
  | .refused _ => false

end WriteVerdict

/-- `workspaceWriteVerdict`: resolve the path, refuse the root with its own reason, and ask
`writeGrantVerdict` about the workspace-relative rest. -/
@[aw_spec (ts := "packages/engine-pi/src/workspace.ts#workspaceWriteVerdict")
  (ts := "packages/engine-pi/src/workspace.ts#relativeWriteVerdict")]
def workspaceWriteVerdict (c : Compiled) (input : String) : WriteVerdict :=
  match resolveWorkspacePath c.cwd input with
  | .rewritten => .refused .rewrittenSpelling
  | .root => .refused .workspaceRoot
  | .relative p =>
    match writeGrantVerdict (some protectedDirectory) c.grants p with
    | .ok segments => .ok segments
    | .refused r => .refused (.grant r)

/-- May a tool of the compiled run write `candidate`? `workspaceWriteAllowed`. -/
@[aw_spec (ts := "packages/engine-pi/src/workspace.ts#workspaceWriteAllowed")]
def writeAllowed (c : Compiled) (candidate : String) : Bool :=
  (workspaceWriteVerdict c candidate).isOk

/-- May `read` open `candidate`? The root, and any path that normalises inside the workspace. -/
def readAllowed (c : Compiled) (candidate : String) : Bool :=
  match resolveWorkspacePath c.cwd candidate with
  | .rewritten => false
  | .root => true
  | .relative p => (normaliseGrantPath none p).isOk

/-- The guard's decision on one call, on the path the model named (`piToolCallVerdict`): a tool the
plan does not offer is blocked; `bash` runs when offered; `read` needs a path that resolves inside
the workspace; `write` and `edit` need a path `workspaceWriteVerdict` allows. -/
@[aw_spec (ts := "packages/engine-pi/src/workspace.ts#piToolCallVerdict")]
def guard (c : Compiled) (toolName : String) (path : Option String) : Bool :=
  match c.tools.find? (fun t => t.name == toolName) with
  | none => false
  | some .bash => true
  | some .read =>
    match path with
    | none => false
    | some p => readAllowed c p
  | some _ =>
    match path with
    | none => false
    | some p => writeAllowed c p

/-! ## The pinned resource loader -/

/-- Where a resource pi could load comes from. -/
inductive Source where
  /-- A skill the platform placed under `.pi/skills/<name>/`. -/
  | platformSkill
  /-- The agent's instructions, appended to pi's own system prompt. -/
  | platformInstructions
  /-- Anything under `~/.pi` (settings, extensions, skills, prompts, themes, `AGENTS.md`). -/
  | piHome
  /-- Anything under `~/.agents`. -/
  | agentsHome
  /-- Project discovery: `.agents/skills`, `.pi/extensions`, `AGENTS.md`, `CLAUDE.md`, … -/
  | project
  deriving DecidableEq, Repr, Inhabited

/-- One resource pi could load. -/
structure Resource where
  source : Source
  /-- The skill name for a skill; the resource's own name otherwise. -/
  name : String
  deriving DecidableEq, Repr, Inhabited

/-- The agent's instructions, which the loader appends to pi's system prompt from the compiled
configuration rather than reading from the host. -/
def instructions : Resource := ⟨.platformInstructions, "instructions"⟩

/-- What the platform materialised for this run, built from the compiled configuration alone: one
placed skill under `.pi/skills/<name>/` per granted name, and the instructions. -/
def materialised (c : Compiled) : List Resource :=
  c.skills.map (fun name => ⟨.platformSkill, name⟩) ++ [instructions]

/-- What the pinned loader returns, of everything present on the host: the skills it finds under
`.pi/skills` that the run grants, then the instructions. Nothing else is ever consulted. -/
@[aw_spec (ts := "packages/engine-pi/src/boundary.ts#startPiRun")]
def pinnedLoad (c : Compiled) (present : List Resource) : List Resource :=
  present.filter (fun res => res.source == .platformSkill && c.skills.contains res.name) ++
    [instructions]

/-! ## The event mapping -/

/-- One pi session event, as the mapper reads it. -/
inductive Event where
  /-- `message_update` with a `text_delta`. -/
  | textDelta (delta : String)
  /-- `message_update` with a `thinking_delta`. -/
  | thinkingDelta (delta : String)
  /-- Any other `message_update`, by its assistant-event type. -/
  | updateOther (type : String)
  /-- A `message_update` without an assistant-message event. -/
  | updateUnreadable
  /-- `message_end` of an assistant message; `none` blocks is content that is not a list. -/
  | assistantEnd (responseId : Option String) (blocks : Option (List Block))
  /-- `message_end` of a user, tool-result or system message, by role. -/
  | messageEndOther (role : String)
  /-- A `message_end` without a message role. -/
  | messageEndUnreadable
  /-- `tool_execution_start`. -/
  | toolStart (callId : Option String) (name : Option String)
  /-- `tool_execution_end`; `none` output is content that is not a list of parts. -/
  | toolEnd (callId : Option String) (output : Option String) (isError : Bool)
  /-- Every other pi event by type — `agent_start`, `turn_end`, `agent_end`, … -/
  | lifecycle (type : String)
  /-- An event without a type. -/
  | untyped
  /-- The adapter's terminal event. -/
  | completed (stop : StopReason) (turns : Nat) (usage : Option Usage)
  deriving DecidableEq, Repr, Inhabited

/-- The kind of a tool call by name. -/
def kindOf (name : String) : ToolKind :=
  match Tool.ofName? name with
  | some t => t.kind
  | none => .other

/-- One event, given the call ids announced so far: the new announced list and the frames. Native
payloads are carried as `null` here; the replay compares every neutral field. -/
@[aw_spec (ts := "packages/engine-pi/src/frames.ts#createPiFrameMapper")]
def step (announced : List String) : Event → List String × List Frame
  | .textDelta d => (announced, [.delta none .text d])
  | .thinkingDelta d => (announced, [.delta none .reasoning d])
  | .updateOther type => (announced, [.native ("message_update." ++ type) .null])
  | .updateUnreadable =>
    (announced, [.malformed "a message_update without an assistant message event"])
  | .assistantEnd _ none =>
    (announced, [.malformed "an assistant message whose content is not a list of parts"])
  | .assistantEnd id (some blocks) => (announced, [.message id .assistant blocks])
  | .messageEndOther role => (announced, [.native ("message_end." ++ role) .null])
  | .messageEndUnreadable => (announced, [.malformed "a message_end without a message role"])
  | .toolStart (some callId) (some name) =>
    -- The TypeScript mapper keeps a `Set`: a repeated start announces nothing new.
    (if announced.contains callId then announced else announced ++ [callId],
      [.toolCall callId name (kindOf name) .null])
  | .toolStart _ _ =>
    (announced, [.malformed "a tool execution without a call id or a tool name"])
  | .toolEnd none _ _ => (announced, [.malformed "a tool result without a call id"])
  | .toolEnd (some callId) output isError =>
    if announced.contains callId then
      match output with
      | none => (announced, [.malformed "a tool result whose content is not a list of parts"])
      | some text =>
        (announced.erase callId,
          [.toolResult callId (if isError then .failed else .completed) text isError])
    else (announced, [.malformed "a tool result for a call no tool execution announced"])
  | .lifecycle type => (announced, [.native type .null])
  | .untyped => (announced, [.malformed "a pi event without a type"])
  | .completed stop turns usage =>
    (announced, (usage.map Frame.usage).toList ++ [.result stop (some turns) none])

/-- A whole stream, from no announced call. -/
def mapFrom : List String → List Event → List Frame
  | _, [] => []
  | announced, e :: rest =>
    let (next, frames) := step announced e
    frames ++ mapFrom next rest

/-- An empty stream maps to no frame; stated through `mapFrom.eq_def` so the equation is generated
here, beside the definition. -/
theorem mapFrom_nil (announced : List String) : mapFrom announced [] = [] := by
  rw [mapFrom.eq_def]

def mapAll (events : List Event) : List Frame := mapFrom [] events

/-! ## The turn limit -/

/-- The adapter's turn stop over the turns a run's model would take, in order: each flag says
whether that turn ran tools (so pi would ask the model again). A turn that ran none ends the run
`end_turn`; the turn that reaches the limit with tools still running is the last, ended by the
`terminate` hint, and the run ends `max_turns`. The first component is the turns taken. -/
@[aw_spec (ts := "packages/engine-pi/src/boundary.ts#startPiRun")]
def turnRun (limit : Option Nat) : Nat → List Bool → Nat × StopReason
  | n, [] => (n, .endTurn)
  | n, continues :: rest =>
    if !continues then (n + 1, .endTurn)
    else match limit with
      | some m => if m ≤ n + 1 then (n + 1, .maxTurns) else turnRun limit (n + 1) rest
      | none => turnRun limit (n + 1) rest

/-- No turn left takes no further turn; stated through `turnRun.eq_def` for the reason
`OpenAiAgents.compileConnectors_nil` gives. -/
theorem turnRun_nil (limit : Option Nat) (n : Nat) : turnRun limit n [] = (n, .endTurn) := by
  rw [turnRun.eq_def]

/-! ## The session -/

/-- One line of a pi session file: the header (`type: "session"`, `id` the session id) or an entry
with its `parentId`. -/
structure Line where
  kind : String
  id : String
  parentId : Option String
  deriving DecidableEq, Repr, Inhabited

/-- Every entry's id is new and its parent is `null` or an earlier line's id. -/
def treeFrom : List String → List Line → Bool
  | _, [] => true
  | seen, l :: rest =>
    !seen.contains l.id &&
      (match l.parentId with
        | none => true
        | some p => seen.contains p) &&
      treeFrom (seen ++ [l.id]) rest

/-- An empty rest is a tree under any seen ids; stated through `treeFrom.eq_def` so the equation is
generated here, beside the definition. -/
theorem treeFrom_nil (seen : List String) : treeFrom seen [] = true := by
  rw [treeFrom.eq_def]

/-- `readPiStream`: a stream is resumable as `sid` only when it starts with `sid`'s header and the
rest is a tree under it. -/
@[aw_spec (ts := "packages/engine-pi/src/session.ts#readPiStream")]
def readStream (sid : String) : List Line → Option (List Line)
  | [] => none
  | h :: rest => if h.kind == "session" && h.id == sid && treeFrom [sid] rest then some (h :: rest)
      else none

/-- `PiSessionMirror.persist`: append the lines of the file the stream does not hold yet. -/
@[aw_spec (ts := "packages/engine-pi/src/session.ts#PiSessionMirror")]
def persist (stream file : List Line) : List Line :=
  stream ++ file.filter fun l => !(stream.map Line.id).contains l.id

end AgentWorkspace.Behaviour.Engines.Pi
