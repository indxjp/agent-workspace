import AgentWorkspace.Contracts.RunEvents

/-!
# The engine-neutral `agent.*` frame vocabulary (ENG-03, #302)

This module models the whole seam the unit builds, in one place, because the four implementations it
describes are four uses of two functions:

* **the closed frame union** (`Frame`), with its `engine`, its capped `raw`, ACP's tool kinds and
  ACP's stop reasons — `packages/contracts/src/run-events.ts`;
* **`toAgentFrames`**, the Claude adapter's mapping from a classified SDK message onto frames, whose
  input type `Classified` is `packages/core`'s `ClassifiedSdkEvent`;
* **`upgradeLegacy`**, the event-read path's upgrade of a `run_events` row recorded before ENG-03 —
  `apps/web/server/runs/agent-frames.ts`;
* **`decode`**, the SDK's validating parser of a frame off the wire —
  `packages/sdk/src/events/agent-event.ts`.

The relationship the unit's refinement theorem needs falls out of the shape: `upgradeLegacy` is
`toAgentFrames` composed with the classifier over the message the row stored, so a legacy run and a
fresh run of the same messages cannot diverge. This module replaces `Events/AgentEvent.lean`, which
modelled the Claude-shaped projection each client used to re-derive for itself.
-/

namespace AgentWorkspace.Events.AgentFrames

open AgentWorkspace AgentWorkspace.Contracts

/-! ## The closed vocabularies -/

/-- ACP's tool-call kinds (`AGENT_TOOL_KINDS`), in wire order. -/
inductive ToolKind where
  | read | edit | delete | move | search | execute | fetch | mcp | other
  deriving DecidableEq, Repr

@[aw_spec (ts := "packages/contracts/src/run-events.ts#AGENT_TOOL_KINDS")]
def ToolKind.toWire : ToolKind → String
  | .read => "read"
  | .edit => "edit"
  | .delete => "delete"
  | .move => "move"
  | .search => "search"
  | .execute => "execute"
  | .fetch => "fetch"
  | .mcp => "mcp"
  | .other => "other"

def ToolKind.all : List ToolKind :=
  [.read, .edit, .delete, .move, .search, .execute, .fetch, .mcp, .other]

def ToolKind.ofWire? (s : String) : Option ToolKind :=
  ToolKind.all.find? (fun k => k.toWire == s)

/-- ACP's prompt-turn stop reasons (`AGENT_STOP_REASONS`), in wire order. -/
inductive StopReason where
  | endTurn | maxTurns | maxBudget | refusal | cancelled | error
  deriving DecidableEq, Repr

@[aw_spec (ts := "packages/contracts/src/run-events.ts#AGENT_STOP_REASONS")]
def StopReason.toWire : StopReason → String
  | .endTurn => "end_turn"
  | .maxTurns => "max_turns"
  | .maxBudget => "max_budget"
  | .refusal => "refusal"
  | .cancelled => "cancelled"
  | .error => "error"

def StopReason.all : List StopReason :=
  [.endTurn, .maxTurns, .maxBudget, .refusal, .cancelled, .error]

def StopReason.ofWire? (s : String) : Option StopReason :=
  StopReason.all.find? (fun r => r.toWire == s)

/-- One block of a message: what the model said, or what it thought first. -/
inductive Block where
  | text (value : String)
  | reasoning (value : String)
  deriving DecidableEq, Repr

def Block.toWire : Block → JValue
  | .text v => .obj [("type", .str "text"), ("text", .str v)]
  | .reasoning v => .obj [("type", .str "reasoning"), ("text", .str v)]

def Block.ofWire? : JValue → Option Block
  | .obj [("type", .str "text"), ("text", .str v)] => some (.text v)
  | .obj [("type", .str "reasoning"), ("text", .str v)] => some (.reasoning v)
  | _ => none

/-- Who spoke a message (`AgentMessageFrameSchema.role`): a closed set, like the tool kinds. -/
inductive Role where
  | assistant | user
  deriving DecidableEq, Repr

@[aw_spec (ts := "packages/contracts/src/run-events.ts#AgentMessageFrameSchema")]
def Role.toWire : Role → String
  | .assistant => "assistant"
  | .user => "user"

def Role.ofWire? (s : String) : Option Role :=
  [Role.assistant, .user].find? (fun r => r.toWire == s)

/-- Which kind of block a streamed delta grows (`AgentMessageDeltaFrameSchema.block`). -/
inductive BlockKind where
  | text | reasoning
  deriving DecidableEq, Repr

@[aw_spec (ts := "packages/contracts/src/run-events.ts#AgentMessageDeltaFrameSchema")]
def BlockKind.toWire : BlockKind → String
  | .text => "text"
  | .reasoning => "reasoning"

def BlockKind.ofWire? (s : String) : Option BlockKind :=
  [BlockKind.text, .reasoning].find? (fun b => b.toWire == s)

/-- Whether a tool call ran (`AgentToolResultFrameSchema.status`). -/
inductive ToolStatus where
  | completed | failed
  deriving DecidableEq, Repr

@[aw_spec (ts := "packages/contracts/src/run-events.ts#AgentToolResultFrameSchema")]
def ToolStatus.toWire : ToolStatus → String
  | .completed => "completed"
  | .failed => "failed"

def ToolStatus.ofWire? (s : String) : Option ToolStatus :=
  [ToolStatus.completed, .failed].find? (fun t => t.toWire == s)

/-- The engine's own cost of a turn in USD, as `AgentResultFrameSchema.engineCostUsd` constrains it:
a **non-negative** JSON number, kept as the exact decimal `mantissa · 10⁻ᵉˣᵖᵒⁿᵉⁿᵗ` it was sent as. A
`Nat` mantissa is what makes a negative cost unrepresentable rather than merely unexpected. -/
structure Cost where
  mantissa : Nat
  exponent : Nat
  deriving DecidableEq, Repr

def Cost.toWire (c : Cost) : JValue := .num (Int.ofNat c.mantissa) c.exponent

/-- A JSON number read as a cost: `none` for a negative number and for every non-number. JSON has no
spelling for `NaN` or an infinity, so every `num` is finite, as `Number.isFinite` requires. This is
both the parser's reading of `engineCostUsd` and the adapter's reading of `total_cost_usd`. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
def Cost.ofWire? : JValue → Option Cost
  | .num m e => if 0 ≤ m then some ⟨m.toNat, e⟩ else none
  | _ => none

/-- The engine's own token counters. A counter the engine did not report is absent, not zero. -/
structure Usage where
  inputTokens : Nat
  outputTokens : Nat
  cacheReadInputTokens : Option Nat
  cacheCreationInputTokens : Option Nat
  reasoningTokens : Option Nat
  deriving DecidableEq, Repr

/-! ## The frame union -/

/-- The neutral payload of one frame, without the `engine` and `raw` every arm carries. -/
inductive Frame where
  | session (engineSessionId : String) (model : Option String)
  | message (messageId : Option String) (role : Role) (blocks : List Block)
  | delta (messageId : Option String) (block : BlockKind) (text : String)
  | toolCall (toolCallId : String) (name : String) (kind : ToolKind) (input : JValue)
  | toolResult (toolCallId : String) (status : ToolStatus) (output : String) (isError : Bool)
  | usage (counters : Usage)
  | result (stopReason : StopReason) (turns : Option Nat) (engineCostUsd : Option Cost)
  | native (type : String) (payload : JValue)
  | malformed (reason : String)
  /-- The engine stopped before a tool call the agent requires approval for (ADR-0145). -/
  | approvalRequested (toolCallId : String) (toolName : String) (canonicalCall : String)
  /-- The agent handed the conversation to a person and the run ended (ADR-0145 D4). The reason is
  the operator's: a visitor's stream is served the frame without it (`none`). -/
  | handoff (reason : Option String)
  deriving DecidableEq, Repr

/-- The `event:` name of a frame, which is also the `frame` field inside its payload. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#AGENT_FRAME_NAMES")]
def Frame.name : Frame → String
  | .session _ _ => "agent.session"
  | .message _ _ _ => "agent.message"
  | .delta _ _ _ => "agent.message.delta"
  | .toolCall _ _ _ _ => "agent.tool.call"
  | .toolResult _ _ _ _ => "agent.tool.result"
  | .usage _ => "agent.usage"
  | .result _ _ _ => "agent.result"
  | .native _ _ => "agent.native"
  | .malformed _ => "agent.malformed"
  | .approvalRequested _ _ _ => "agent.approval.requested"
  | .handoff _ => "agent.handoff"

def optStr : Option String → JValue
  | some s => .str s
  | none => .null

def optStr? : JValue → Option (Option String)
  | .str s => some (some s)
  | .null => some none
  | _ => none

/-- A string the contract requires to be non-empty (`z.string().min(1)`). -/
def nonEmptyStr? : JValue → Option String
  | .str s => if s == "" then none else some s
  | _ => none

/-- A nullable string the contract requires to be non-empty when present. -/
def optNonEmptyStr? : JValue → Option (Option String)
  | .null => some none
  | j => (nonEmptyStr? j).map some

def optCost : Option Cost → JValue
  | some c => c.toWire
  | none => .null

def optCost? : JValue → Option (Option Cost)
  | .null => some none
  | j => (Cost.ofWire? j).map some

def optNat : Option Nat → JValue
  | some n => .ofInt (Int.ofNat n)
  | none => .null

def optNat? : JValue → Option (Option Nat)
  | .null => some none
  | j => match j.asInt? with
    | some n => if 0 ≤ n then some (some n.toNat) else none
    | none => none

/-- The arm-specific fields of one frame, in the order the contract declares them. -/
def Frame.body : Frame → JValue.Fields
  | .session id model => [("engineSessionId", .str id), ("model", optStr model)]
  | .message id role blocks =>
    [("messageId", optStr id), ("role", .str role.toWire),
     ("blocks", .arr (blocks.map Block.toWire))]
  | .delta id block text =>
    [("messageId", optStr id), ("block", .str block.toWire), ("text", .str text)]
  | .toolCall id name kind input =>
    [("toolCallId", .str id), ("name", .str name), ("kind", .str kind.toWire), ("input", input)]
  | .toolResult id status output isError =>
    [("toolCallId", .str id), ("status", .str status.toWire), ("output", .str output),
     ("isError", .bool isError)]
  | .usage u =>
    [("inputTokens", .ofInt (Int.ofNat u.inputTokens)),
     ("outputTokens", .ofInt (Int.ofNat u.outputTokens)),
     ("cacheReadInputTokens", optNat u.cacheReadInputTokens),
     ("cacheCreationInputTokens", optNat u.cacheCreationInputTokens),
     ("reasoningTokens", optNat u.reasoningTokens)]
  | .result stop turns cost =>
    [("stopReason", .str stop.toWire), ("turns", optNat turns), ("engineCostUsd", optCost cost)]
  | .native type payload => [("type", .str type), ("payload", payload)]
  | .malformed reason => [("reason", .str reason)]
  | .approvalRequested id toolName call =>
    [("toolCallId", .str id), ("toolName", .str toolName), ("canonicalCall", .str call)]
  | .handoff (some reason) => [("reason", .str reason)]
  | .handoff none => []

/-- The JSON one frame is sent as: the discriminant, the engine, the capped engine-native payload,
then the arm's own fields. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#AgentFrameSchema")]
def encode (engine : String) (raw : JValue) (frame : Frame) : JValue :=
  .obj ([("frame", .str frame.name), ("engine", .str engine), ("raw", raw)] ++ frame.body)

/-- The SDK's validating parser: the engine, the engine-native payload and the frame, or `none` for
a payload that does not satisfy the contract. Reading the arm's fields *positively* is the whole
point — a payload whose `frame` field this build does not know, or whose fields do not match it, is
refused by name rather than read around (ADR-0015). -/
@[aw_spec (ts := "packages/sdk/src/events/agent-event.ts#toAgentEvent")]
def decode : JValue → Option (String × JValue × Frame)
  | .obj (("frame", .str name) :: ("engine", .str engine) :: ("raw", raw) :: body) =>
    (decodeBody name body).map fun frame => (engine, raw, frame)
  | _ => none
where
  decodeBody (name : String) : JValue.Fields → Option Frame
    | [("engineSessionId", id), ("model", model)] =>
      if name == "agent.session" then
        (nonEmptyStr? id).bind fun id => (optNonEmptyStr? model).map (Frame.session id)
      else none
    | [("messageId", messageId), ("role", .str role), ("blocks", .arr blocks)] =>
      if name == "agent.message" then
        (optNonEmptyStr? messageId).bind fun id => (Role.ofWire? role).bind fun r =>
          (blocks.mapM Block.ofWire?).map fun bs => Frame.message id r bs
      else none
    | [("messageId", messageId), ("block", .str block), ("text", .str text)] =>
      if name == "agent.message.delta" then
        (optNonEmptyStr? messageId).bind fun id =>
          (BlockKind.ofWire? block).map fun b => Frame.delta id b text
      else none
    | [("toolCallId", id), ("name", toolName), ("kind", .str kind), ("input", input)] =>
      if name == "agent.tool.call" then
        (nonEmptyStr? id).bind fun id => (nonEmptyStr? toolName).bind fun toolName =>
          (ToolKind.ofWire? kind).map fun k => Frame.toolCall id toolName k input
      else none
    | [("toolCallId", id), ("status", .str status), ("output", .str output),
       ("isError", .bool isError)] =>
      if name == "agent.tool.result" then
        (nonEmptyStr? id).bind fun id =>
          (ToolStatus.ofWire? status).map fun st => Frame.toolResult id st output isError
      else none
    | [("inputTokens", input), ("outputTokens", output), ("cacheReadInputTokens", read),
       ("cacheCreationInputTokens", creation), ("reasoningTokens", reasoning)] =>
      if name == "agent.usage" then
        match optNat? input, optNat? output with
        | some (some i), some (some o) =>
          (optNat? read).bind fun r => (optNat? creation).bind fun c =>
            (optNat? reasoning).map fun t => Frame.usage ⟨i, o, r, c, t⟩
        | _, _ => none
      else none
    | [("stopReason", .str stop), ("turns", turns), ("engineCostUsd", cost)] =>
      if name == "agent.result" then
        (StopReason.ofWire? stop).bind fun s =>
          (optNat? turns).bind fun t => (optCost? cost).map fun c => Frame.result s t c
      else none
    | [("type", type), ("payload", payload)] =>
      if name == "agent.native" then (nonEmptyStr? type).map fun t => Frame.native t payload
      else none
    | [("reason", reason)] =>
      if name == "agent.malformed" then (nonEmptyStr? reason).map Frame.malformed
      else if name == "agent.handoff" then (nonEmptyStr? reason).map fun r => Frame.handoff (some r)
      else none
    | [("toolCallId", id), ("toolName", toolName), ("canonicalCall", call)] =>
      if name == "agent.approval.requested" then
        (nonEmptyStr? id).bind fun id => (nonEmptyStr? toolName).bind fun toolName =>
          (nonEmptyStr? call).map fun call => Frame.approvalRequested id toolName call
      else none
    | [] => if name == "agent.handoff" then some (Frame.handoff none) else none
    | _ => none

/-! ## `raw`: capped, never rejected -/

/-- The published cap on the engine-native payload a frame may carry, in UTF-8 bytes. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#AGENT_FRAME_RAW_MAX_BYTES")]
def rawMaxBytes : Nat := 65536

/-- The marker `raw` becomes when the payload did not fit, or had no JSON representation. -/
@[aw_spec (ts := "packages/contracts/src/run-events.ts#AgentFrameRawTruncationSchema")]
def truncationMarker (encodedBytes : Option Nat) : JValue :=
  .obj [("truncated", .bool true), ("encodedBytes", optNat encodedBytes),
        ("limitBytes", .ofInt (Int.ofNat rawMaxBytes))]

/-- Cap a payload: the value when it fits, the marker when it does not, and the marker with no size
when it has no JSON representation to measure. **Total** — there is no arm that drops the frame,
because the neutral fields beside `raw` are the part a consumer renders. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#capAgentFrameRaw")]
def capRaw (encodedBytes : Option Nat) (raw : JValue) : JValue :=
  match encodedBytes with
  | some n => if n ≤ rawMaxBytes then raw else truncationMarker (some n)
  | none => truncationMarker none

/-! ## The Claude adapter's input: one classified SDK message -/

/-- `packages/core`'s `ClassifiedSdkEvent`. It is the *input* of `toAgentFrames` and names nothing on
the wire any more. -/
@[aw_spec (ts := "packages/run-protocol/src/types.ts#ClassifiedSdkEvent")]
inductive Classified where
  | system (subtype : String) (event : JValue)
  | systemUnknown (subtype : String) (event : JValue)
  | result (subtype : String) (event : JValue)
  | resultUnknown (subtype : String) (event : JValue)
  | event (type : String) (event : JValue)
  | unknown (type : String) (event : JValue)
  | malformed (reason : String) (event : JValue)
  deriving DecidableEq, Repr

/-- The engine-native message a classification wraps, which becomes the frame's `raw`. -/
def Classified.message : Classified → JValue
  | .system _ e => e
  | .systemUnknown _ e => e
  | .result _ e => e
  | .resultUnknown _ e => e
  | .event _ e => e
  | .unknown _ e => e
  | .malformed _ e => e

/-- The name `agent.native` gives a message with no neutral meaning. -/
def Classified.nativeName : Classified → String
  | .system s _ => "system/" ++ s
  | .systemUnknown s _ => "system/" ++ s
  | .result s _ => "result/" ++ s
  | .resultUnknown s _ => "result/" ++ s
  | .event t _ => t
  | .unknown t _ => t
  | .malformed _ _ => "malformed"

/-! ## The Claude mapping -/

/-- `claudeToolKind`: only tools whose effect is known are named; an MCP tool by its prefix, and
everything else `other`, which is the honest answer rather than a default that hides an effect. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#claudeToolKind")]
def toolKindOf (name : String) : ToolKind :=
  if "mcp__".isPrefixOf name then .mcp
  else if name == "Read" || name == "NotebookRead" then .read
  else if name == "Write" || name == "Edit" || name == "MultiEdit" || name == "NotebookEdit" then
    .edit
  else if name == "Glob" || name == "Grep" || name == "WebSearch" then .search
  else if name == "WebFetch" then .fetch
  else if name == "Bash" || name == "BashOutput" || name == "KillShell" || name == "KillBash" then
    .execute
  else .other

/-- The neutral stop reason of a `result` subtype. An unrecognised subtype is an `error`: a turn
whose outcome this build cannot name is not one it may report as having gone well. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
def stopReasonOf (subtype : String) : StopReason :=
  if subtype == "success" then .endTurn
  else if subtype == "error_max_turns" then .maxTurns
  else if subtype == "error_max_budget_usd" then .maxBudget
  else .error

private def nonEmpty? : Option JValue → Option String
  | some (.str s) => if s == "" then none else some s
  | _ => none

private def field (event : JValue) (key : String) : Option JValue :=
  match event with
  | .obj fs => JValue.lookup key fs
  | _ => none

private def blockOf : JValue → Option Block
  | .obj fs =>
    match JValue.lookup "type" fs, JValue.lookup "text" fs, JValue.lookup "thinking" fs with
    | some (.str "text"), some (.str s), _ => some (.text s)
    | some (.str "thinking"), _, some (.str s) => some (.reasoning s)
    | _, _, _ => none
  | _ => none

/-- The prose blocks of a Messages-API `content`, in the model's order. -/
def proseBlocks : Option JValue → List Block
  | some (.str s) => if s == "" then [] else [.text s]
  | some (.arr items) => items.filterMap blockOf
  | _ => []

private def textOf : JValue → Option String
  | .obj fs =>
    match JValue.lookup "type" fs, JValue.lookup "text" fs with
    | some (.str "text"), some (.str s) => some s
    | _, _ => none
  | _ => none

/-- A tool result's `content` as one string: a string as itself, blocks by their text parts. -/
def flattenOutput : Option JValue → String
  | some (.str s) => s
  | some (.arr items) => String.intercalate "\n" (items.filterMap textOf)
  | _ => ""

/-- The fields a `tool_use` block carries, read positively. An absent `input` is `null`, which is
what the code sends too: JSON has no spelling for `undefined`, and the contract's `input` key must be
present on the wire. -/
def toolCallData : JValue → Option (String × String × JValue)
  | .obj fs =>
    if JValue.lookup "type" fs == some (.str "tool_use") then
      match nonEmpty? (JValue.lookup "id" fs), nonEmpty? (JValue.lookup "name" fs) with
      | some id, some name => some (id, name, (JValue.lookup "input" fs).getD .null)
      | _, _ => none
    else none
  | _ => none

/-- The fields a `tool_result` block carries, read positively. -/
def toolResultData : JValue → Option (String × String × Bool) :=
  fun item => match item with
  | .obj fs =>
    if JValue.lookup "type" fs == some (.str "tool_result") then
      match nonEmpty? (JValue.lookup "tool_use_id" fs) with
      | some id =>
        some (id, flattenOutput (JValue.lookup "content" fs),
          JValue.lookup "is_error" fs == some (.bool true))
      | none => none
    else none
  | _ => none

def callFrame (d : String × String × JValue) : Frame :=
  .toolCall d.1 d.2.1 (toolKindOf d.2.1) d.2.2

def resultFrame (d : String × String × Bool) : Frame :=
  -- `status` is whether the call ran and `isError` the engine's verdict on its answer. The Claude
  -- SDK delivers a result block for both, so a delivered block always ran to completion.
  .toolResult d.1 .completed d.2.1 d.2.2

/-- The tool frames one message's content carries.

A `tool_use` block rides only on an `assistant` message and a `tool_result` only on a `user` one,
which is what makes the pairing invariant hold over a whole run without this function having to
remember anything between messages. Each list is a `map` over the blocks it read, so "every frame
here is a call" is an induction rather than an assertion. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
def toolFrames (role : String) : Option JValue → List Frame
  | some (.arr items) =>
    if role == "assistant" then (items.filterMap toolCallData).map callFrame
    else if role == "user" then (items.filterMap toolResultData).map resultFrame
    else []
  | _ => []

/-- Whether a frame announces a tool call, and whether it answers one. -/
def Frame.isToolCall : Frame → Bool
  | .toolCall _ _ _ _ => true
  | _ => false

def Frame.isToolResult : Frame → Bool
  | .toolResult _ _ _ _ => true
  | _ => false

/-- The call ids a sequence announces, and the ids its results answer. -/
def callIds : List Frame → List String
  | [] => []
  | .toolCall id _ _ _ :: rest => id :: callIds rest
  | _ :: rest => callIds rest

def resultIds : List Frame → List String
  | [] => []
  | .toolResult id _ _ _ :: rest => id :: resultIds rest
  | _ :: rest => resultIds rest

private def pairedFrom (seen : List String) : List Frame → Bool
  | [] => true
  | .toolCall id _ _ _ :: rest => pairedFrom (id :: seen) rest
  | .toolResult id _ _ _ :: rest => seen.contains id && pairedFrom seen rest
  | _ :: rest => pairedFrom seen rest

/-- Whether every `agent.tool.result` in a sequence is answered by an **earlier**
`agent.tool.call` with the same id. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
def paired (frames : List Frame) : Bool := pairedFrom [] frames

/-- A stream is `paired` when each of its `agent.tool.result` frames names an id that some earlier
`agent.tool.call` announced. The public face of the scan `paired` runs, so an engine model can
prove pairing from its own scan without seeing this one. -/
theorem paired_of_results_follow_calls (frames : List Frame)
    (h : ∀ pre id st out err rest, frames = pre ++ .toolResult id st out err :: rest →
      id ∈ callIds pre) :
    paired frames = true := by
  suffices key : ∀ (fs : List Frame) (seen : List String),
      (∀ pre id st out err rest, fs = pre ++ .toolResult id st out err :: rest →
        id ∈ seen ∨ id ∈ callIds pre) → pairedFrom seen fs = true from
    key frames [] (fun pre id st out err rest he => Or.inr (h pre id st out err rest he))
  intro fs
  induction fs with
  | nil => intro seen _; rw [pairedFrom.eq_def]
  | cons f rest ih =>
    intro seen hf
    have tail : ∀ pre id st out err rest', rest = pre ++ .toolResult id st out err :: rest' →
        id ∈ seen ∨ id ∈ callIds (f :: pre) :=
      fun pre id st out err rest' he => hf (f :: pre) id st out err rest' (by simp [he])
    cases f with
    | toolCall cid n k i =>
      rw [pairedFrom.eq_def]
      apply ih
      intro pre id st out err rest' he
      rcases tail pre id st out err rest' he with h1 | h1
      · exact Or.inl (List.mem_cons_of_mem _ h1)
      · simp only [callIds, List.mem_cons] at h1
        rcases h1 with h1 | h1
        · exact Or.inl (h1 ▸ List.mem_cons_self ..)
        · exact Or.inr h1
    | toolResult rid st out err =>
      rw [pairedFrom.eq_def]
      simp only [Bool.and_eq_true, List.contains_iff_mem]
      refine ⟨?_, ?_⟩
      · rcases hf [] rid st out err rest rfl with h1 | h1
        · exact h1
        · simp [callIds] at h1
      · apply ih
        intro pre id st' out' err' rest' he
        rcases tail pre id st' out' err' rest' he with h1 | h1
        · exact Or.inl h1
        · exact Or.inr (by simpa [callIds] using h1)
    | _ =>
      rw [pairedFrom.eq_def]
      simp only
      apply ih
      intro pre id st out err rest' he
      rcases tail pre id st out err rest' he with h1 | h1
      · exact Or.inl h1
      · exact Or.inr (by simpa [callIds] using h1)

private structure Counters where
  inputTokens : Nat
  outputTokens : Nat
  cacheReadInputTokens : Option Nat
  cacheCreationInputTokens : Option Nat
  reasoningTokens : Option Nat

private def addOpt : Option Nat → Option Nat → Option Nat
  | none, b => b
  | some a, none => some a
  | some a, some b => some (a + b)

private def counter (fs : JValue.Fields) (key : String) : Option Nat :=
  match (JValue.lookup key fs).bind JValue.asInt? with
  | some n => if 0 ≤ n then some n.toNat else none
  | none => none

private def entryCounters : String × JValue → Option Counters
  | (_, .obj fs) =>
    match counter fs "inputTokens", counter fs "outputTokens" with
    | some i, some o =>
      some ⟨i, o, counter fs "cacheReadInputTokens", counter fs "cacheCreationInputTokens",
        counter fs "thinkingTokens"⟩
    | _, _ => none
  | _ => none

/-- The engine's own counters, when at least one `modelUsage` entry is readable.

Summed across models, because R-01 §4 records the record key as unstable; `thinkingTokens` is
reported as `reasoningTokens` and never added to `outputTokens`, which already contains it. An engine
that reported nothing is not an engine that reported zero, so this is `none` rather than a zero
frame. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
def usageOf (event : JValue) : Option Usage :=
  match field event "modelUsage" with
  | some (.obj entries) =>
    let readable := entries.filterMap entryCounters
    if readable.isEmpty then none
    else
      let total := readable.foldl (fun acc e =>
        (⟨acc.inputTokens + e.inputTokens, acc.outputTokens + e.outputTokens,
          addOpt acc.cacheReadInputTokens e.cacheReadInputTokens,
          addOpt acc.cacheCreationInputTokens e.cacheCreationInputTokens,
          addOpt acc.reasoningTokens e.reasoningTokens⟩ : Counters))
        ⟨0, 0, none, none, none⟩
      some ⟨total.inputTokens, total.outputTokens, total.cacheReadInputTokens,
        total.cacheCreationInputTokens, total.reasoningTokens⟩
  | _ => none

private def resultFrames (subtype : String) (event : JValue) : List Frame :=
  (match usageOf event with
    | some u => [Frame.usage u]
    | none => []) ++
  [.result (stopReasonOf subtype)
    (match ((field event "num_turns").bind JValue.asInt?) with
      | some n => if 0 ≤ n then some n.toNat else none
      | none => none)
    -- A cost the engine did not report, or reported as something other than a non-negative
    -- number, is `null`: the contract refuses a negative or non-numeric cost, and the adapter
    -- does not relay one it would refuse.
    ((field event "total_cost_usd").bind Cost.ofWire?)]

private def messageFrames (role : Role) (event : JValue) : List Frame :=
  match field event "message" with
  | some message =>
    let content := field message "content"
    let prose := proseBlocks content
    (if prose.isEmpty then []
      else
        [Frame.message
          (match role with
           | .assistant => nonEmpty? (field message "id")
           | .user => nonEmpty? (field event "uuid"))
          role prose]) ++ toolFrames role.toWire content
  | none => []

/-- `agent.native`, or `agent.malformed`, for a message with no neutral meaning.

The one place the "nothing is dropped" guarantee is implemented: whatever the mapping could not
express, this is what carries it. -/
def fallbackFrame : Classified → Frame
  | .malformed reason _ => .malformed reason
  | c => .native c.nativeName c.message

/-- The frames the neutral vocabulary can express for one message, which may be none of them. -/
def mappedFrames (classified : Classified) : List Frame :=
  match classified with
  | .malformed _ _ => []
  | .system subtype event =>
    if subtype == "init" then
      match nonEmpty? (field event "session_id") with
      | some id => [.session id (nonEmpty? (field event "model"))]
      -- A `system/init` with no session id is not a session; claiming one would write an empty id
      -- into `sessions.engine_session_id`.
      | none => []
    else []
  | .result subtype event => resultFrames subtype event
  | .resultUnknown subtype event => resultFrames subtype event
  | .event type event =>
    match Role.ofWire? type with
    | some role => messageFrames role event
    | none => []
  | .systemUnknown _ _ => []
  | .unknown _ _ => []

/-- A list, or the fallback when it is empty. -/
def nonEmptyOr (fallback : Frame) : List Frame → List Frame
  | [] => [fallback]
  | frames@(_ :: _) => frames

/-- Map one classified Claude Agent SDK message onto neutral frames.

**Never empty, by construction**: whatever `mappedFrames` cannot express becomes `agent.native`, and
a message that could not be parsed becomes `agent.malformed`. There is no arm that returns `[]` for
an event that arrived, and `never_drops_an_engine_message` is one line because of it. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
def toAgentFrames (classified : Classified) : List Frame :=
  nonEmptyOr (fallbackFrame classified) (mappedFrames classified)

/-! ## The diagnostics, in the code's words -/

private def hexDigit (n : Nat) : Char :=
  if n < 10 then Char.ofNat (48 + n) else Char.ofNat (87 + n)

/-- One character as `JSON.stringify` writes it inside a string. Lean's `Char` is a Unicode scalar
value, so the lone surrogates JavaScript would also escape cannot occur. -/
def jsonEscape (c : Char) : List Char :=
  if c = '"' then ['\\', '"']
  else if c = '\\' then ['\\', '\\']
  else if c = '\n' then ['\\', 'n']
  else if c = '\r' then ['\\', 'r']
  else if c = '\t' then ['\\', 't']
  else if c.toNat = 8 then ['\\', 'b']
  else if c.toNat = 12 then ['\\', 'f']
  else if c.toNat < 32 then
    ['\\', 'u', '0', '0', hexDigit (c.toNat / 16), hexDigit (c.toNat % 16)]
  else [c]

/-- `JSON.stringify` of a string. -/
def jsonQuote (s : String) : String :=
  String.ofList ('"' :: (s.toList.flatMap jsonEscape ++ ['"']))

private def stripZeros : Nat → Nat → Nat → Nat × Nat
  | 0, m, z => (m, z)
  | fuel + 1, m, z => if m ≠ 0 ∧ m % 10 = 0 then stripZeros fuel (m / 10) (z + 1) else (m, z)

private def zeros (n : Nat) : String := String.ofList (List.replicate n '0')

/-- `String(x)` for the exact decimal `m · 10⁻ᵉ` (ECMA-262 `Number::toString`, radix 10).

Exact for every number whose shortest round-tripping decimal is the one written, which is every
number of at most fifteen significant digits: the same agreement `Prelude/JValue.lean` states
between the model's numbers and JavaScript's doubles. -/
def jsNumberString (m : Int) (e : Nat) : String :=
  if m = 0 then "0"
  else
    let sign := if m < 0 then "-" else ""
    let (digits, z) := stripZeros (m.natAbs.log2 + 1) m.natAbs 0
    let s := toString digits
    let k : Int := s.length
    -- `x = s · 10^(n − k)`, with `s` free of trailing zeros.
    let n : Int := k + z - e
    let body :=
      if k ≤ n ∧ n ≤ 21 then s ++ zeros (n - k).toNat
      else if 0 < n ∧ n ≤ 21 then
        String.ofList (s.toList.take n.toNat) ++ "." ++ String.ofList (s.toList.drop n.toNat)
      else if -6 < n ∧ n ≤ 0 then "0." ++ zeros (-n).toNat ++ s
      else
        let exp := n - 1
        let expPart := (if 0 ≤ exp then "e+" else "e-") ++ toString exp.natAbs
        if k = 1 then s ++ expPart
        else String.ofList (s.toList.take 1) ++ "." ++ String.ofList (s.toList.drop 1) ++ expPart
    sign ++ body

/-- `describe` in `packages/run-protocol/src/schemas.ts`: the offending value in JavaScript's words. `none`
is a key that is absent, which JavaScript reads as `undefined`. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#classifySdkEvent")]
def describe : Option JValue → String
  | none => "a value of type undefined"
  | some .null => "null"
  | some (.arr _) => "an array"
  | some (.str s) => "the string " ++ jsonQuote s
  | some (.num m e) => "the number " ++ jsNumberString m e
  | some (.bool b) => "the boolean " ++ (if b then "true" else "false")
  | some (.obj _) => "a value of type object"

/-- The JSON the adapter sends for one engine message: every frame it maps to, each carrying the
capped engine message as its `raw`. `encodedBytes` is the message's `JSON.stringify` size in UTF-8
bytes, or `none` when it has no JSON representation.

Every frame of the message carries it, not only the first: a consumer that resumed inside a
message, or reads only `agent.result`, still holds the words the frame was derived from — and the
result frame's accounting is checked against exactly that. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#toAgentFrames")]
def toAgentFramesJson (engine : String) (encodedBytes : Option Nat) (classified : Classified) :
    List JValue :=
  (toAgentFrames classified).map (encode engine (capRaw encodedBytes classified.message))

/-! ## The legacy upgrade -/

/-- `classifySdkEvent`, as `packages/core` decides it: discriminate on `type`, then on `subtype` for
`system` and `result`, and reject a non-object, a non-string discriminant or an **empty** `type` by
name rather than falling through to the opaque-forward path (ADR-0015). An empty `type` is refused
because it names nothing: forwarded, it would become an `agent.native` frame whose `type` the
contract refuses, which is a dropped message by another route.

A `malformed` reason is the code's whole diagnostic, `; got …` suffix included, so the replay
compares it with `toEqual` like every other field. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#classifySdkEvent")]
def classify (systemSubtypes resultSubtypes eventTypes : List String) (raw : JValue) :
    Classified :=
  match raw with
  | .obj fs =>
    match JValue.lookup "type" fs with
    | some (.str t) =>
      if t == "" then .malformed "an SDK event must carry a non-empty 'type'; got the string \"\"" raw
      else if t == "system" || t == "result" then
        match JValue.lookup "subtype" fs with
        | some (.str s) =>
          if t == "system" then
            if systemSubtypes.contains s then .system s raw else .systemUnknown s raw
          else if resultSubtypes.contains s then .result s raw else .resultUnknown s raw
        | other =>
          .malformed (s!"a '{t}' event must carry a string 'subtype'; got " ++ describe other) raw
      else if eventTypes.contains t then .event t raw
      else .unknown t raw
    | other => .malformed ("an SDK event must carry a string 'type'; got " ++ describe other) raw
  | _ => .malformed ("an SDK event must be an object; got " ++ describe (some raw)) raw

/-- The envelope `relay.ts` stored for one pre-ENG-03 row: the classification, serialised. -/
def legacyEnvelope (kind : String) (message : JValue) : JValue :=
  .obj [("kind", .str kind), ("event", message)]

/-- Read the engine message out of a stored envelope, or the code's reason the row is not one. -/
@[aw_spec (ts := "apps/web/server/runs/agent-frames.ts#upgradeStoredEvent")]
def legacyMessage : JValue → Except String JValue
  | .obj fs =>
    match JValue.lookup "kind" fs with
    | some (.str _) =>
      match JValue.lookup "event" fs with
      | some message => .ok message
      | none => .error "a pre-ENG-03 run event's envelope must carry the engine message under 'event'; this row's does not"
    | _ => .error "a pre-ENG-03 run event's envelope must carry a string 'kind'; this row's does not, so the engine message it wrapped cannot be identified"
  | _ => .error "a pre-ENG-03 run event must hold the runner's classification envelope as a JSON object; this row holds something else"

/-- Upgrade one pre-ENG-03 row.

Deterministic, and by construction the *same two functions* a fresh run applies, in the same order,
over the same input. A row that is not an envelope becomes `agent.malformed` — the frame says the
envelope could not be read, and nothing is invented. -/
@[aw_spec (ts := "apps/web/server/runs/agent-frames.ts#upgradeStoredEvent")]
def upgradeLegacy (systemSubtypes resultSubtypes eventTypes : List String) (data : JValue) :
    List Frame :=
  match legacyMessage data with
  | .ok message => toAgentFrames (classify systemSubtypes resultSubtypes eventTypes message)
  | .error reason => [.malformed reason]

/-! ## The wire id: `<sequence>[.<sub-index>]` -/

/-- The id one served frame carries.

`none` for the sub-index is the bare sequence a row served one-to-one, which is every row a run
started after ENG-03 writes. An upgraded legacy row always carries one, even when it produced a
single frame, so an id says which kind of row it came from. -/
@[aw_spec (ts := "apps/web/server/runs/agent-frames.ts#wireEventId")]
def wireEventId (sequence : Nat) (subIndex : Option Nat) : String :=
  match subIndex with
  | none => toString sequence
  | some i => toString sequence ++ "." ++ toString i

/-- Number a list from zero, so a row's frames carry their position. -/
def indexed {α : Type} (xs : List α) : List (Nat × α) := (List.range xs.length).zip xs

/-- Whether one served id comes strictly before another under `(sequence, sub-index)` order. -/
def idBefore (a b : Nat × Option Nat) : Bool :=
  if a.1 < b.1 then true
  else if a.1 == b.1 then
    match a.2, b.2 with
    | none, some _ => true
    | some i, some j => i < j
    | _, _ => false
  else false

/-- Whether a whole served sequence of ids is strictly increasing. -/
def idsIncreasing : List (Nat × Option Nat) → Bool
  | [] => true
  | [_] => true
  | a :: b :: rest => idBefore a b && idsIncreasing (b :: rest)

/-- The most frames one row may serve: sub-indices `0 … 999`, the three digits the documented id
grammar (`WIRE_EVENT_ID_PATTERN`, `cursor.ts`) admits. -/
@[aw_spec (ts := "apps/web/server/runs/agent-frames.ts#MAX_FRAMES_PER_ROW")]
def maxFramesPerRow : Nat := 1000

/-- The reason the last served frame of an over-long row gives for the frames it stands in for. -/
def rowOverflowReason (total : Nat) : String :=
  s!"a pre-ENG-03 run event mapped to {total} frames, more than the {maxFramesPerRow} one row may serve; the last {total - (maxFramesPerRow - 1)} are reported here instead of served"

/-- Cap the frames one row serves: every frame when they fit; otherwise the first 999 and one
`agent.malformed` that reports the remainder. Reported, never guessed and never a stream that stops
parsing: a tenant's agent chooses how many tool calls one turn carries. -/
@[aw_spec (ts := "apps/web/server/runs/agent-frames.ts#upgradeStoredEvent")]
def capRowFrames (frames : List Frame) : List Frame :=
  if frames.length ≤ maxFramesPerRow then frames
  else frames.take (maxFramesPerRow - 1) ++ [.malformed (rowOverflowReason frames.length)]

/-- The ids and frames one legacy row serves, in the order `toAgentFrames` emitted them. -/
@[aw_spec (ts := "apps/web/server/runs/agent-frames.ts#upgradeStoredEvent")]
def serveLegacyRow (systemSubtypes resultSubtypes eventTypes : List String)
    (sequence : Nat) (data : JValue) : List ((Nat × Option Nat) × Frame) :=
  (indexed (capRowFrames (upgradeLegacy systemSubtypes resultSubtypes eventTypes data))).map
    fun (i, frame) => ((sequence, some i), frame)

/-- What a client resumed at `(sequence, subIndex)` is served from a row. `subIndexed` is whether the
row is served in parts — an upgraded legacy row — rather than one-to-one.

The frames after the one it last saw, when the row is the one its cursor named and was served in
parts; every frame of the row otherwise. A cursor into a row the store can no longer retain has
already produced a `stream-reset`, so the oldest retained row is new to the client in its entirety;
and a sub-index on a row served one-to-one is an id this server never wrote, so the row is served
whole rather than dropped on the strength of a position it does not have. -/
@[aw_spec (ts := "apps/web/server/runs/agent-frames.ts#upgradeEventStream")]
def resumeWithinRow {α : Type} (cursor : Option (Nat × Nat)) (sequence : Nat) (subIndexed : Bool)
    (served : List α) : List α :=
  match cursor with
  | some (s, i) => if s == sequence && subIndexed then served.drop (i + 1) else served
  | none => served

/-! ## The SDK's frame classification -/

/-- One frame of the stream as the SDK classifies it (`RunEventFrame`): the platform's own frames,
and a durable frame the runtime produced. -/
inductive Wire where
  | runStatus | runFailed | streamReset | done
  | runtime (name : String) (data : JValue)
  deriving DecidableEq, Repr

/-- The SDK's `toAgentEvent`.

`none` for the platform's own frames: they are already typed on `RunEventFrame` and are the
*platform* speaking about the run and the stream, not the engine speaking about the turn. A runtime
frame whose payload does not decode is a `ContractViolationError` in the code, and `none` here. -/
@[aw_spec (ts := "packages/sdk/src/events/agent-event.ts#toAgentEvent")]
def toAgentEvent : Wire → Option Frame
  | .runStatus => none
  | .runFailed => none
  | .streamReset => none
  | .done => none
  | .runtime name data =>
    match decode data with
    | some (_, _, frame) => if name == frame.name then some frame else none
    | none => none

/-- The SDK's `assistantResponseFromAgentEvent`: the visible text of a spoken assistant turn, and
nothing else. Reasoning, tool use, usage and results cannot reach the conversation. -/
@[aw_spec (ts := "packages/sdk/src/events/agent-event.ts#assistantResponseFromAgentEvent")]
def assistantResponse : Frame → Option (String × List String)
  | .message (some id) role blocks =>
    if role == .assistant then
      let text := blocks.filterMap fun b =>
        match b with
        | .text s => if Text.isBlank s then none else some s
        | .reasoning _ => none
      if text.isEmpty then none else some (id, text)
    else none
  | _ => none

end AgentWorkspace.Events.AgentFrames
