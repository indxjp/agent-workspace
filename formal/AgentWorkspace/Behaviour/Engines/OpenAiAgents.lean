import AgentWorkspace.Authz.PathGrant
import AgentWorkspace.Events.AgentFrames
import AgentWorkspace.Behaviour.EnginePort
import AgentWorkspace.Behaviour.GatewayIngress

/-!
# The OpenAI Agents SDK adapter (ENG-09, #308)

`packages/engine-openai-agents` puts the OpenAI Agents SDK behind the engine port. This module
models the four decisions the adapter owns, as pure functions over explicit inputs:

1. **compile** (`src/compile.ts#compileOpenAiAgentsRun`) — the portable core plus the
   `openai-agents` policy arm into a tool set, a gateway configuration and limits, or a refusal
   that names the capability it could not honour;
2. **the tool plan** (`src/tools.ts#openAiAgentsToolPlan`) — the four permission switches into
   this engine's function tools;
3. **the event mapping** (`src/frames.ts#createOpenAiAgentsFrameMapper`) — the SDK's stream
   events into the neutral `agent.*` frames of `Events/AgentFrames.lean`;
4. **the session** (`src/session.ts#EngineStoreSession`) — the SDK's `Session` over the
   engine-scoped store's list, append, delete-last and replace-all.

The path rules are `Authz/PathGrant.lean`'s and the frames are `Events/AgentFrames.lean`'s; neither
is re-modelled here.

## What is a hypothesis rather than a theorem

Three things happen inside the third-party SDK and cannot be proved in Lean. Each is stated here,
enforced by a test, and listed under the unit's declared gaps:

* the SDK issues model requests only through the client the compiled connection builds (the
  `boundary.test.ts` suite runs the real SDK against a local fake gateway and records every
  outbound URL);
* `setTracingDisabled(true)` runs before `run` and the SDK then exports no trace (the same suite,
  plus the `tracingDisabled` field every compiled configuration carries);
* the SDK enforces `maxTurns` natively, throwing `MaxTurnsExceededError` once the limit is passed
  ({@link runOutcome} models that contract; the conformance kit and the live suite check it).
-/

namespace AgentWorkspace.Behaviour.Engines.OpenAiAgents

open AgentWorkspace AgentWorkspace.Authz.PathGrant AgentWorkspace.Events.AgentFrames

/-! ## The tools -/

/-- The five function tools the adapter can offer, in `OPENAI_AGENTS_TOOL_NAMES` order. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#OPENAI_AGENTS_TOOL_NAMES")]
inductive Tool where
  | readFile
  | listFiles
  | searchFiles
  | applyPatch
  | shell
  deriving DecidableEq, Repr, Inhabited

namespace Tool

def all : List Tool := [readFile, listFiles, searchFiles, applyPatch, shell]

theorem all_complete (t : Tool) : t ∈ all := by cases t <;> decide

/-- The name the model calls the tool by. -/
def name : Tool → String
  | readFile => "read_file"
  | listFiles => "list_files"
  | searchFiles => "search_files"
  | applyPatch => "apply_patch"
  | shell => "shell"

/-- The neutral `agent.tool.call` kind (`OPENAI_AGENTS_TOOL_KIND`). -/
def kind : Tool → ToolKind
  | readFile | listFiles => .read
  | searchFiles => .search
  | applyPatch => .edit
  | shell => .execute

/-- The `tools[].type` every compiled tool is sent as. Every one is an SDK **function** tool. -/
def wireType : Tool → Behaviour.GatewayIngress.ToolType
  | _ => .function

def ofName? (s : String) : Option Tool := all.find? (fun t => t.name == s)

end Tool

/-- §17 Step 4's four switches. -/
structure Permissions where
  readFiles : Bool
  writeFiles : Bool
  runCommands : Bool
  unrestrictedNetwork : Bool
  deriving DecidableEq, Repr, Inhabited

/-- Which switch grants each tool (`OPENAI_AGENTS_TOOL_PERMISSION`). -/
def Tool.permitted (p : Permissions) : Tool → Bool
  | .readFile | .listFiles | .searchFiles => p.readFiles
  | .applyPatch => p.writeFiles
  | .shell => p.runCommands

/-- The tool plan: every tool its switch allows, in order, with `shell` withheld while a
read-only grant exists (a redirect would write what the grant protects). -/
@[aw_spec (ts := "packages/engine-openai-agents/src/tools.ts#openAiAgentsToolPlan")]
def toolPlan (p : Permissions) (hasReadOnlyGrant : Bool) : List Tool :=
  Tool.all.filter fun t => t.permitted p && !(t == .shell && hasReadOnlyGrant)

/-! ## The connection -/

/-- The wire protocols the adapter speaks, Responses first (`OPENAI_AGENTS_WIRE_PROTOCOLS`). -/
inductive Protocol where
  | openaiResponses
  | openaiChatCompletions
  | anthropicMessages
  deriving DecidableEq, Repr, Inhabited

namespace Protocol

def toWire : Protocol → String
  | openaiResponses => "openai-responses"
  | openaiChatCompletions => "openai-chat-completions"
  | anthropicMessages => "anthropic-messages"

def all : List Protocol := [openaiResponses, openaiChatCompletions, anthropicMessages]

def ofWire? (s : String) : Option Protocol := all.find? (fun p => p.toWire == s)

/-- The path a model request on this protocol takes under the `/v1` endpoint. -/
def path : Protocol → String
  | openaiResponses => "/responses"
  | openaiChatCompletions => "/chat/completions"
  | anthropicMessages => "/messages"

end Protocol

/-- The engine's advertised protocol list, as compose's resolver reads it. -/
def engineProtocols : List String := Protocol.all.map Protocol.toWire

/-- Which client the boundary builds: `OpenAIProvider`, or `aisdk(createAnthropic(…))`. -/
inductive Client where
  | openai
  | aisdkAnthropic
  deriving DecidableEq, Repr, Inhabited

def Client.toWire : Client → String
  | .openai => "openai"
  | .aisdkAnthropic => "aisdk-anthropic"

def clientFor : Protocol → Client
  | .anthropicMessages => .aisdkAnthropic
  | _ => .openai

/-- `baseUrl` without its trailing slashes, as `replace(/\/+$/u, '')` computes it. -/
def stripTrailingSlashes (s : String) : String :=
  String.ofList (s.toList.reverse.dropWhile (· == '/')).reverse

/-- The compiled model connection (`openAiAgentsModelConnection`). -/
structure Connection where
  protocol : Protocol
  client : Client
  endpoint : String
  authorization : String
  deriving DecidableEq, Repr, Inhabited

@[aw_spec (ts := "packages/engine-openai-agents/src/compile.ts#openAiAgentsModelConnection")]
def connectionFor (protocol : Protocol) (baseUrl token : String) : Connection :=
  { protocol, client := clientFor protocol,
    endpoint := stripTrailingSlashes baseUrl ++ "/v1",
    authorization := "Bearer " ++ token }

/-- Every model request a compiled connection can issue: one URL, the endpoint plus the protocol's
path, carrying the connection's `Authorization`. -/
def modelRequests (c : Connection) : List (String × String) :=
  [(c.endpoint ++ c.protocol.path, c.authorization)]

/-! ## The request and the refusals -/

/-- One connector, as far as compile reads it. -/
structure Connector where
  name : String
  /-- Reached over HTTP or SSE rather than as a stdio subprocess. -/
  remote : Bool
  /-- Some tool of it asks for a human approval (`always_ask` or `org_max_permission: ask`). -/
  asksApproval : Bool
  deriving DecidableEq, Repr, Inhabited

inductive SessionMode where
  | fresh
  | resume
  | fork
  deriving DecidableEq, Repr, Inhabited

/-- The inputs of one compile. Strings stand for the parts compile reads and nothing more. -/
structure Request where
  /-- The policy arm parsed as `OpenAiAgentsRunPolicy`. -/
  policyReadable : Bool
  permissions : Permissions
  model : Option String
  /-- Granted skill names: the resources' and the allow-list's. -/
  skills : List String
  session : SessionMode
  maxTurns : Option Nat
  /-- `limits.maxBudgetUsd` is set. -/
  budgetCap : Bool
  /-- `(baseUrl, token, protocol)`, or `none` for a request carrying no gateway. -/
  gateway : Option (String × String × String)
  /-- Spec A.11's verdict over the environment (`Behaviour/SandboxEnv.lean` decides it). -/
  environmentClean : Bool
  /-- `(directory, path, readOnly)` per file grant. -/
  grants : List (Bool × String × Bool)
  connectors : List Connector
  deriving DecidableEq, Repr, Inhabited

/-- A refusal: the port's code and the capability or requirement it names. -/
inductive Refusal where
  | policyInvalid (requirement : String)
  | capabilityUnsupported (capability : String)
  | credentialRefused (requirement : String)
  deriving DecidableEq, Repr, Inhabited

namespace Refusal

def code : Refusal → String
  | policyInvalid _ => "engine_policy_invalid"
  | capabilityUnsupported _ => "engine_capability_unsupported"
  | credentialRefused _ => "engine_credential_refused"

def names : Refusal → String
  | policyInvalid n | capabilityUnsupported n | credentialRefused n => n

end Refusal

/-- The protected directory this adapter declares. -/
def protectedDirectory : String := ".openai-agents"

/-- The compiled configuration, as far as the theorems read it. -/
structure Compiled where
  tools : List Tool
  networkEgress : Bool
  connection : Connection
  connectors : List String
  maxTurns : Option Nat
  /-- The provisional cap is compiled, to be enforced from the usage the gateway reports back
  (ADR-0074 D7; `limits.budget` is not `null`). -/
  budgetCap : Bool
  grants : List Grant
  tracingDisabled : Bool
  deriving DecidableEq, Repr, Inhabited

inductive Outcome where
  | ok (compiled : Compiled)
  | refused (refusal : Refusal)
  deriving DecidableEq, Repr, Inhabited

/-- The connectors, or the first one compile refuses (sorted by name in the TypeScript; the model
takes them in the order given). A remote connector is not refused for want of
`unrestrictedNetwork`: remote MCP is offered on the Claude engine's terms (Owner decision on #308,
ADR-0074 D2), so only a tool asking for an approval refuses one. -/
def compileConnectors : List Connector → Except Refusal (List String)
  | [] => .ok []
  | c :: rest =>
    if c.asksApproval then .error (.capabilityUnsupported "approvals")
    else (compileConnectors rest).map (c.name :: ·)

/-- No connector compiles to none. Proved through `compileConnectors.eq_def` so that equation is
generated here, beside the definition, rather than in the theorem module that first unfolds it. -/
theorem compileConnectors_nil : compileConnectors [] = .ok [] := by
  rw [compileConnectors.eq_def]

/-! ## The provisional budget (ADR-0074 D7, #342) -/

/-- The models the provisional price table prices: the keys of `OPENAI_AGENTS_PROVISIONAL_PRICES`,
in its order. A cap on any other model (or on the SDK's unnamed default) is refused. -/
@[aw_spec (ts := "packages/engine-openai-agents/src/budget.ts#OPENAI_AGENTS_PROVISIONAL_PRICES")]
def pricedModels : List String :=
  ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "claude-opus-5",
   "claude-sonnet-5", "claude-sonnet-4-5", "claude-haiku-4-5"]

/-- Can a cap on this model be priced? `openAiAgentsPriceFor(model) !== null`. -/
@[aw_spec (ts := "packages/engine-openai-agents/src/budget.ts#openAiAgentsPriceFor")]
def priced : Option String → Bool
  | none => false
  | some m => pricedModels.contains m

/-- The boundary's budget stop over the estimated cost of each model response, in order, in
micro-dollars: after each response the spend so far is compared with the cap, and the run stops
`max_budget` at the first response that brings it to the cap or over; a run whose responses stay
under it ends as the model ends it. The first component is the responses performed. -/
@[aw_spec (ts := "packages/engine-openai-agents/src/boundary.ts#startOpenAiAgentsRun")
  (ts := "packages/engine-openai-agents/src/budget.ts#openAiAgentsBudgetSpent")]
def budgetRunFrom (cap spent : Nat) : List Nat → Nat × StopReason
  | [] => (0, .endTurn)
  | c :: rest =>
    if cap ≤ spent + c then (1, .maxBudget)
    else ((budgetRunFrom cap (spent + c) rest).1 + 1, (budgetRunFrom cap (spent + c) rest).2)

/-- The spend of a list of response costs. -/
def spend : List Nat → Nat
  | [] => 0
  | c :: rest => c + spend rest

/-- A run with no response is not stopped by its budget. Proved through `budgetRunFrom.eq_def` so
that equation is generated here, beside the definition, rather than in the theorem module that
first unfolds it. -/
theorem budgetRunFrom_nil (cap spent : Nat) : budgetRunFrom cap spent [] = (0, .endTurn) := by
  rw [budgetRunFrom.eq_def]

/-- No response spends nothing. Proved through `spend.eq_def`, for the reason above. -/
theorem spend_nil : spend [] = 0 := by
  rw [spend.eq_def]

/-- The compiled half after the gateway has been read. -/
def compileWith (r : Request) (grants : List Grant) (baseUrl token : String) (p : Protocol) :
    Outcome :=
  let plan := toolPlan r.permissions (grants.any (·.readOnly))
  match compileConnectors r.connectors with
  | .error e => .refused e
  | .ok names =>
    .ok { tools := plan, networkEgress := r.permissions.unrestrictedNetwork,
          connection := connectionFor p baseUrl token, connectors := names,
          maxTurns := r.maxTurns, budgetCap := r.budgetCap, grants, tracingDisabled := true }

/-- `compileOpenAiAgentsRun`, check for check and in the same order. -/
@[aw_spec (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")]
def compile (r : Request) : Outcome :=
  if !r.policyReadable then .refused (.policyInvalid "policy")
  else match normaliseGrants (some protectedDirectory) r.grants with
  | none => .refused (.policyInvalid "grants")
  | some grants =>
    if !r.skills.isEmpty then .refused (.capabilityUnsupported "skills")
    else if r.session == .fork then .refused (.capabilityUnsupported "fork")
    else if r.budgetCap && !priced r.model then .refused (.capabilityUnsupported "maxBudget")
    else match r.gateway with
    | none => .refused (.credentialRefused "gateway")
    | some (baseUrl, token, wire) =>
      match Protocol.ofWire? wire with
      | none => .refused (.capabilityUnsupported "wireProtocols")
      | some p =>
        if p == .anthropicMessages && r.model.isNone then .refused (.capabilityUnsupported "model")
        else if !r.environmentClean then .refused (.credentialRefused "environment")
        else compileWith r grants baseUrl token p

/-- May the compiled Editor write `candidate`? `workspaceWriteAllowed`, over the compiled grants. -/
@[aw_spec (ts := "packages/engine-openai-agents/src/workspace.ts#workspaceWriteAllowed")]
def writeAllowed (c : Compiled) (candidate : String) : Bool :=
  (writeGrantVerdict (some protectedDirectory) c.grants candidate).isOk

/-! ## What an accepted compile looks like -/

private theorem compileWith_ok {r : Request} {grants : List Grant} {b t : String} {p : Protocol}
    {c : Compiled} (h : compileWith r grants b t p = .ok c) :
    c.tools = toolPlan r.permissions (grants.any (·.readOnly)) ∧ c.grants = grants ∧
      c.networkEgress = r.permissions.unrestrictedNetwork ∧ c.connection = connectionFor p b t ∧
      c.tracingDisabled = true ∧ c.maxTurns = r.maxTurns ∧ c.budgetCap = r.budgetCap := by
  unfold compileWith at h
  dsimp only at h
  split at h
  · cases h
  · cases h
    exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

/-- The shape of every accepted compile: the request's grants normalised, its gateway read, and
the compiled half built from them. A lemma the family's theorems share; it states no property of its own. -/
theorem compile_ok_shape {r : Request} {c : Compiled} (h : compile r = .ok c) :
    ∃ grants b t w p,
      normaliseGrants (some protectedDirectory) r.grants = some grants ∧
      r.gateway = some (b, t, w) ∧ Protocol.ofWire? w = some p ∧
      c.tools = toolPlan r.permissions (grants.any (·.readOnly)) ∧ c.grants = grants ∧
      c.networkEgress = r.permissions.unrestrictedNetwork ∧ c.connection = connectionFor p b t ∧
      c.tracingDisabled = true ∧ c.maxTurns = r.maxTurns ∧ c.budgetCap = r.budgetCap := by
  unfold compile at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i grants hg
      split at h
      · cases h
      · split at h
        · cases h
        · split at h
          · cases h
          · split at h
            · cases h
            · rename_i b t w hgw
              split at h
              · cases h
              · rename_i p hp
                split at h
                · cases h
                · split at h
                  · cases h
                  · obtain ⟨h1, h2, h3, h4, h5, h6, h7⟩ := compileWith_ok h
                    exact ⟨grants, b, t, w, p, hg, hgw, hp, h1, h2, h3, h4, h5, h6, h7⟩

/-! ## The event mapping -/

/-- One SDK stream event, as `./boundary.ts` flattens it and as far as the mapper reads it. -/
inductive Event where
  /-- `raw_model_stream_event` `output_text_delta`. -/
  | textDelta (itemId : Option String) (delta : String)
  /-- `raw_model_stream_event` `model` carrying a reasoning delta. -/
  | reasoningDelta (itemId : Option String) (delta : String)
  /-- Any other raw model event, by its `type`. -/
  | rawOther (type : String)
  /-- A raw model event with no string `type`. -/
  | rawUntyped
  /-- `message_output_created`; `none` texts is content that is not a list of parts. -/
  | messageCreated (id : Option String) (texts : Option (List String))
  /-- `reasoning_item_created`; `none` text is unreadable reasoning. -/
  | reasoningCreated (id : Option String) (text : Option String)
  /-- `tool_called`; `isFunction` is `rawItem.type === 'function_call'`. -/
  | toolCalled (isFunction : Bool) (callId : Option String) (name : Option String)
  /-- `tool_output`; `isFunctionResult` is `rawItem.type === 'function_call_result'`. -/
  | toolOutput (isFunctionResult : Bool) (callId : Option String) (output : String)
      (incomplete : Bool)
  /-- Any other `run_item_stream_event`, by name. -/
  | otherItem (name : String)
  /-- `agent_updated_stream_event`. -/
  | agentUpdated
  /-- The adapter's terminal event. -/
  | completed (stop : StopReason) (turns : Option Nat) (usage : Option Usage)
  deriving DecidableEq, Repr, Inhabited

/-- The prefix an executor's error answer carries (`OPENAI_AGENTS_TOOL_ERROR_PREFIX`). -/
def errorPrefix : String := "ERROR: "

/-- Context the mapper holds: the adapter's own tool names, and whether connectors exist. -/
structure FrameContext where
  localTools : List String
  hasMcp : Bool
  deriving DecidableEq, Repr, Inhabited

/-- The kind of a function call by name. -/
def kindOf (ctx : FrameContext) (name : String) : ToolKind :=
  if ctx.hasMcp && !ctx.localTools.contains name then .mcp
  else match Tool.ofName? name with
    | some t => t.kind
    | none => .other

/-- One event, given the call ids announced so far: the new announced list and the frames.
Native payloads are carried as `null` here; the replay compares every neutral field. -/
@[aw_spec (ts := "packages/engine-openai-agents/src/frames.ts#createOpenAiAgentsFrameMapper")]
def step (ctx : FrameContext) (announced : List String) : Event → List String × List Frame
  | .textDelta id d => (announced, [.delta id .text d])
  | .reasoningDelta id d => (announced, [.delta id .reasoning d])
  | .rawOther type => (announced, [.native ("raw_model_stream_event." ++ type) .null])
  | .rawUntyped => (announced, [.malformed "a raw model event without a type"])
  | .messageCreated _ none =>
    (announced, [.malformed "a message item whose content is not a list of parts"])
  | .messageCreated id (some texts) =>
    (announced, [.message id .assistant (texts.map Block.text)])
  | .reasoningCreated _ none => (announced, [.malformed "a reasoning item with unreadable text"])
  | .reasoningCreated id (some text) => (announced, [.message id .assistant [.reasoning text]])
  | .toolCalled false _ _ => (announced, [.native "run_item_stream_event.tool_called" .null])
  | .toolCalled true (some callId) (some name) =>
    (announced ++ [callId], [.toolCall callId name (kindOf ctx name) .null])
  | .toolCalled true _ _ =>
    (announced, [.malformed "a function call without a call id or a name"])
  | .toolOutput false _ _ _ => (announced, [.native "run_item_stream_event.tool_output" .null])
  | .toolOutput true none _ _ => (announced, [.malformed "a tool output without a call id"])
  | .toolOutput true (some callId) output incomplete =>
    if announced.contains callId then
      (announced.erase callId,
        [.toolResult callId (if incomplete then .failed else .completed) output
          (incomplete || errorPrefix.toList.isPrefixOf output.toList)])
    else (announced, [.malformed "a tool output for a call no tool call announced"])
  | .otherItem name => (announced, [.native ("run_item_stream_event." ++ name) .null])
  | .agentUpdated => (announced, [.native "agent_updated_stream_event" .null])
  | .completed stop turns usage =>
    (announced, (usage.map Frame.usage).toList ++ [.result stop turns none])

/-- A whole stream, from no announced call. -/
def mapFrom (ctx : FrameContext) : List String → List Event → List Frame
  | _, [] => []
  | announced, e :: rest =>
    let (next, frames) := step ctx announced e
    frames ++ mapFrom ctx next rest

/-- An empty stream maps to no frame; stated through `mapFrom.eq_def` for the reason
`compileConnectors_nil` gives. -/
theorem mapFrom_nil (ctx : FrameContext) (announced : List String) : mapFrom ctx announced [] = [] := by
  rw [mapFrom.eq_def]

def mapAll (ctx : FrameContext) (events : List Event) : List Frame := mapFrom ctx [] events

/-- The nine names of the closed `agent.*` vocabulary (`AGENT_FRAME_NAMES`). -/
def frameNames : List String :=
  ["agent.session", "agent.message", "agent.message.delta", "agent.tool.call",
   "agent.tool.result", "agent.usage", "agent.result", "agent.native", "agent.malformed"]

/-- Is a frame in the closed vocabulary — a neutral frame, `agent.native` or `agent.malformed`? -/
def isNeutral (f : Frame) : Bool := frameNames.contains f.name

/-- Tool pairing over a frame stream: every result names a call announced earlier and not yet
answered. -/
def pairedFrom : List String → List Frame → Bool
  | _, [] => true
  | open_, .toolCall id _ _ _ :: rest => pairedFrom (open_ ++ [id]) rest
  | open_, .toolResult id _ _ _ :: rest => open_.contains id && pairedFrom (open_.erase id) rest
  | open_, _ :: rest => pairedFrom open_ rest

/-- An empty frame stream is paired; stated through `pairedFrom.eq_def` for the reason
`compileConnectors_nil` gives. -/
theorem pairedFrom_nil (announced : List String) : pairedFrom announced [] = true := by
  rw [pairedFrom.eq_def]

/-! ## Turns -/

/-- The SDK's native `maxTurns` contract (a hypothesis, see the header): a run whose model would
take `wanted` responses performs `min wanted limit` of them and ends `max_turns` when it was cut
short. -/
@[aw_spec (ts := "packages/engine-openai-agents/src/boundary.ts#startOpenAiAgentsRun")]
def runOutcome (limit : Option Nat) (wanted : Nat) : Nat × StopReason :=
  match limit with
  | none => (wanted, .endTurn)
  | some m => if wanted ≤ m then (wanted, .endTurn) else (m, .maxTurns)

/-! ## The session -/

/-- The SDK's own `Session` semantics over a list: the specification this adapter refines. -/
structure SdkSession (α : Type) where
  items : List α
  deriving DecidableEq, Repr

/-- One store entry: the adapter wraps every item under its own entry type. -/
structure Entry (α : Type) where
  type : String
  item : α
  deriving DecidableEq, Repr

def entryType : String := "openai-agents.item"

def wrap {α : Type} (a : α) : Entry α := { type := entryType, item := a }

def unwrap {α : Type} (e : Entry α) : Option α := if e.type == entryType then some e.item else none

/-- The store's four operations over one stream (ADR-0071 "The operations"). -/
def Store.list {α : Type} (s : List (Entry α)) : List (Entry α) := s
def Store.append {α : Type} (s entries : List (Entry α)) : List (Entry α) := s ++ entries
def Store.deleteLast {α : Type} (s : List (Entry α)) : List (Entry α) := s.dropLast
def Store.replaceAll {α : Type} (_s entries : List (Entry α)) : List (Entry α) := entries

/-- `getItems(limit)` over the store: list, unwrap, keep the last `limit`. -/
@[aw_spec (ts := "packages/engine-openai-agents/src/session.ts#EngineStoreSession")]
def getItems {α : Type} (s : List (Entry α)) (limit : Option Nat) : Option (List α) :=
  (Store.list s).mapM unwrap |>.map fun items =>
    match limit with
    | none => items
    | some n => items.drop (items.length - n)

def addItems {α : Type} (s : List (Entry α)) (items : List α) : List (Entry α) :=
  if items.isEmpty then s else Store.append s (items.map wrap)

def popItem {α : Type} (s : List (Entry α)) : Option α × List (Entry α) :=
  match (getItems s none).bind List.getLast? with
  | none => (none, s)
  | some last => (some last, Store.deleteLast s)

def clearSession {α : Type} (s : List (Entry α)) : List (Entry α) := Store.replaceAll s []

/-- The abstraction: a store stream the adapter wrote is the list of the items it wraps. -/
def abstraction {α : Type} (s : List (Entry α)) : SdkSession α := ⟨s.map Entry.item⟩

/-- A stream every entry of which this adapter wrote. -/
def adapterWritten {α : Type} (s : List (Entry α)) : Prop := ∀ e ∈ s, e.type = entryType

end AgentWorkspace.Behaviour.Engines.OpenAiAgents
