import AgentWorkspace.Prelude.Json
import AgentWorkspace.Prelude.Codec
import AgentWorkspace.Contracts.Engines
import AgentWorkspace.Contracts.Identifiers

/-!
# `packages/contracts/src/runs.ts`

The wire types of the runs family. Phase 0 models the run status enumeration and its terminal
subset; the remaining schemas (`RunResourceSchema`, `StartRunRequestSchema`, …) are added by the
contracts phase.
-/

namespace AgentWorkspace.Contracts

open AgentWorkspace

/-- The run lifecycle as the API reports it: `queued` and `running` are live, `awaitingApproval` is
the ADR-0145 pause (stopped, yet not final), the other three are terminal. -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "packages/contracts/src/runs.ts#RUN_STATUSES")]
inductive RunStatus where
  | queued
  | running
  | awaitingApproval
  | completed
  | failed
  | cancelled
  deriving DecidableEq, Repr, Inhabited

namespace RunStatus

/-- The wire spelling, as `RUN_STATUSES` lists it. -/
def toWire : RunStatus → String
  | queued => "queued"
  | running => "running"
  | awaitingApproval => "awaiting_approval"
  | completed => "completed"
  | failed => "failed"
  | cancelled => "cancelled"

instance : WireEnum RunStatus where
  all := [queued, running, awaitingApproval, completed, failed, cancelled]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

/-- `TERMINAL_RUN_STATUSES`: the statuses a run never leaves. -/
@[aw_spec (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "packages/contracts/src/runs.ts#TERMINAL_RUN_STATUSES")]
def terminal : List RunStatus := [completed, failed, cancelled]

/-- `isTerminalRunStatus`. -/
@[aw_spec (ts := "packages/contracts/src/runs.ts#isTerminalRunStatus")]
def isTerminal : RunStatus → Bool
  | completed | failed | cancelled => true
  | queued | running | awaitingApproval => false

/-- `STOPPED_RUN_STATUSES`: the statuses at which nothing executes, the terminal ones and the
`awaitingApproval` pause (ADR-0145). -/
@[aw_spec (ts := "packages/contracts/src/runs.ts#STOPPED_RUN_STATUSES")]
def stopped : List RunStatus := terminal ++ [awaitingApproval]

/-- `isStoppedRunStatus`. -/
@[aw_spec (ts := "packages/contracts/src/runs.ts#isStoppedRunStatus")]
def isStopped : RunStatus → Bool
  | completed | failed | cancelled | awaitingApproval => true
  | queued | running => false

end RunStatus

/-! The response schemas have no transforms. Keeping their decoded JSON value makes the strict
wire shape observable, including absent versus null keys. -/
namespace Runs

open Identifiers

def maxPromptChars : Nat := 100000
def maxRunAttachments : Nat := 10
/-- `MAX_RUN_FILE_SCOPE_PATHS`: the most paths one `fileScope` may name. -/
def maxRunFileScopePaths : Nat := 100
/-- The longest `fileScope` path, in UTF-16 units. -/
def maxRunFileScopePathChars : Nat := 1024
def defaultListLimit : Nat := 20
def maxListLimit : Nat := 200

def modelProviders : List String :=
  ["anthropic", "anthropic-compatible", "openai", "azure-openai", "openai-compatible"]
def accountingStates : List String :=
  ["pending", "complete", "partial", "failed", "unavailable"]
def revokeOutcomes : List String := ["revoked", "already-revoked", "not-found"]

/-- A no-transform Zod schema. Its two codec laws follow from the field predicate. -/
def checked (p : JValue → Bool) : Codec JValue where
  encode := id
  decode j := if p j then some j else none
  valid := p
  decode_encode := by intro a h; simp [h]
  valid_of_decode := by
    intro j a h
    cases hp : p j with
    | false => simp [hp] at h
    | true =>
      simp [hp] at h
      subst a
      exact hp

def stringMin (n : Nat) (j : JValue) : Bool :=
  ((Codec.stringLen n none).decode j).isSome
def uuid (j : JValue) : Bool := (uuidCodec.decode j).isSome
def instant (j : JValue) : Bool := (isoDateTimeCodec.decode j).isSome
def nonnegativeInt (j : JValue) : Bool := ((Codec.int (some 0) none).decode j).isSome
/-- An agent version number: an integer of at least 1 (`RunResource.agentVersion`). -/
def positiveInt (j : JValue) : Bool := ((Codec.int (some 1) none).decode j).isSome
def nullable (p : JValue → Bool) (j : JValue) : Bool := j == .null || p j
def enum (names : List String) (j : JValue) : Bool :=
  match j with
  | .str s => names.contains s
  | _ => false

def fields (fs : JValue.Fields) (rules : List (String × (JValue → Bool))) : Bool :=
  Obj.onlyKeys (rules.map Prod.fst) fs &&
    rules.all (fun (name, check) => (JValue.lookup name fs).any check)

def object (rules : List (String × (JValue → Bool))) : JValue → Bool
  | .obj fs => fields fs rules
  | _ => false

def optField (check : JValue → Bool) (name : String) (fs : JValue.Fields) : Bool :=
  (JValue.lookup name fs).all check

def runUsage : JValue → Bool := object
  [("inputTokens", nonnegativeInt), ("outputTokens", nonnegativeInt),
   ("cacheReadInputTokens", nonnegativeInt), ("cacheCreationInputTokens", nonnegativeInt),
   ("totalTokens", nonnegativeInt), ("toolCalls", nonnegativeInt)]

def runCost : JValue → Bool := object
  [("amount", stringMin 1), ("currency", stringMin 1),
   ("priceTableVersion", nullable (fun j => (Codec.string.decode j).isSome))]

/-- What a completed run answered (ADR-0143): the final text and the structured value, which may be
any JSON value including `null`. -/
def runOutput : JValue → Bool := object
  [("text", fun j => (Codec.string.decode j).isSome), ("structured", fun _ => true)]

/-- The tool call a paused run waits on (ADR-0145): the tool's name and the canonical call. -/
def runApprovalCall : JValue → Bool := object
  [("toolName", stringMin 1), ("canonicalCall", stringMin 1)]

def runResource : JValue → Bool := object
  [("id", stringMin 1), ("workspaceId", stringMin 1), ("agentId", stringMin 1),
   ("projectId", nullable (fun j => (Codec.string.decode j).isSome)),
   ("initiatingUserId", nullable (fun j => (Codec.string.decode j).isSome)),
   ("sessionId", stringMin 1), ("agentVersion", nullable positiveInt),
   ("status", enum ((WireEnum.all : List RunStatus).map RunStatus.toWire)),
   ("createdAt", instant), ("startedAt", nullable instant), ("endedAt", nullable instant),
   ("durationMs", nullable nonnegativeInt),
   ("model", nullable (fun j => (Codec.string.decode j).isSome)),
   ("provider", nullable (enum modelProviders)),
   ("modelConnectionId", nullable (fun j => (Codec.string.decode j).isSome)),
   ("engine", nullable (enum Engines.engineIds)),
   ("engineVersion", nullable (fun j => (Codec.string.decode j).isSome)),
   ("usage", runUsage), ("cost", runCost),
   ("error", nullable (fun j => (Codec.string.decode j).isSome)),
   ("output", nullable runOutput),
   ("pendingApproval", nullable runApprovalCall),
   ("accountingState", enum accountingStates),
   ("accountingError", nullable (fun j => (Codec.string.decode j).isSome))]

def noRepeats : List JValue → Bool
  | [] => true
  | x :: rest => !rest.contains x && noRepeats rest

/-- `attachments`: one to `MAX_RUN_ATTACHMENTS` strict `{ fileId }` items, no `fileId` twice. -/
def attachments : JValue → Bool
  | .arr xs =>
    xs.all (object [("fileId", stringMin 1)]) && 1 ≤ xs.length &&
      xs.length ≤ maxRunAttachments &&
      noRepeats (xs.filterMap fun x => match x with
        | .obj fs => JValue.lookup "fileId" fs
        | _ => none)
  | _ => false

/-- The root of a requested `outputSchema` is a JSON object whose `type` is `"object"`. The finer
limits of ADR-0143 (`size`, `dialect`, `ref`, `depth`) are checked by `outputSchemaViolation` in
TypeScript only and are not modelled here. -/
def outputSchemaRoot : JValue → Bool
  | .obj fs => (JValue.lookup "type" fs).any (· == .str "object")
  | _ => false

/-- A requested `fileScope` path (issue #1539): one to `maxRunFileScopePathChars` UTF-16 units, no
backslash, no NUL, and no empty, `.` or `..` segment, as `isCanonicalFileScopePath` decides. -/
def fileScopePath : JValue → Bool
  | .str s =>
    1 ≤ Text.utf16Length s && Text.utf16Length s ≤ maxRunFileScopePathChars &&
      !s.toList.contains '\\' && !s.toList.contains '\x00' &&
      (s.splitOn "/").all (fun part => part != "" && part != "." && part != "..")
  | _ => false

/-- `fileScope`: one to `maxRunFileScopePaths` canonical paths, none twice. That each path lies
inside the agent's file grants is judged when the run launches, not by the request schema. -/
def fileScope : JValue → Bool
  | .arr xs =>
    xs.all fileScopePath && 1 ≤ xs.length && xs.length ≤ maxRunFileScopePaths && noRepeats xs
  | _ => false

def startRunRequest : JValue → Bool
  | .obj fs =>
    let allowed :=
      ["prompt", "sessionId", "modelConnectionId", "model", "attachments", "outputSchema",
       "fileScope"]
    let prompt := (JValue.lookup "prompt" fs).any fun j =>
      match j with
      | .str s => Text.utf16Length s ≤ maxPromptChars && !Text.isBlank s
      | _ => false
    let sessionOk := optField (nullable uuid) "sessionId" fs
    let connectionOk := optField (nullable uuid) "modelConnectionId" fs
    let modelOk := optField (nullable (stringMin 1)) "model" fs
    let attachmentsOk := optField attachments "attachments" fs
    let outputSchemaOk := optField outputSchemaRoot "outputSchema" fs
    let fileScopeOk := optField fileScope "fileScope" fs
    let hasConnection := (JValue.lookup "modelConnectionId" fs).any (· != .null)
    let hasModel := (JValue.lookup "model" fs).any (· != .null)
    Obj.onlyKeys allowed fs && prompt && sessionOk && connectionOk && modelOk &&
      attachmentsOk && outputSchemaOk && fileScopeOk && (hasConnection == hasModel)
  | _ => false

def startRunResponse : JValue → Bool := object
  [("run", runResource), ("events", stringMin 1)]
def runResponse : JValue → Bool := object [("run", runResource)]

def runApprovalCommentMaxLength : Nat := 1000
def runApprovalDecisions : List String := ["approve", "reject"]

/-- The body of `POST /api/runs/:id/approval` (ADR-0145): a decision and an optional non-blank
comment of at most `RUN_APPROVAL_COMMENT_MAX_LENGTH` characters. -/
def runApprovalRequest : JValue → Bool
  | .obj fs =>
    let commentOk := optField (fun j => match j with
      | .str s => Text.utf16Length s ≤ runApprovalCommentMaxLength && !Text.isBlank s
      | _ => false) "comment" fs
    Obj.onlyKeys ["decision", "comment"] fs &&
      (JValue.lookup "decision" fs).any (enum runApprovalDecisions) && commentOk
  | _ => false

/-- The `202` of `POST /api/runs/:id/approval`: the continuation run and its event stream. -/
def runApprovalResponse : JValue → Bool := object
  [("run", runResource), ("events", stringMin 1)]
def interruptRunResponse : JValue → Bool := runResponse
def revokeRunTokensResponse : JValue → Bool := object
  [("revoked", nonnegativeInt), ("outcome", enum revokeOutcomes)]
def runListResponse : JValue → Bool := object
  [("runs", fun j => match j with
    | .arr xs => xs.all runResource
    | _ => false), ("nextCursor", nullable (stringMin 1))]

def runUsageCodec := checked runUsage
def runCostCodec := checked runCost
def runResourceCodec := checked runResource
def startRunRequestCodec := checked startRunRequest
def startRunResponseCodec := checked startRunResponse
def runResponseCodec := checked runResponse
def interruptRunResponseCodec := checked interruptRunResponse
def revokeRunTokensResponseCodec := checked revokeRunTokensResponse
def runListResponseCodec := checked runListResponse

/-- `RunListQuery` carries optional filters; the renderer omits only absent fields and does not
validate their values. -/
structure RunListQuery where
  status : Option String := none
  agent : Option String := none
  project : Option String := none
  provider : Option String := none
  model : Option String := none
  fromInstant : Option String := none
  toInstant : Option String := none
  user : Option String := none
  limit : Option Int := none
  cursor : Option String := none
  deriving Repr

def runListSearchParams (q : RunListQuery) : List (String × String) :=
  let candidates : List (String × Option String) :=
    [("status", q.status), ("agent", q.agent), ("project", q.project),
     ("provider", q.provider), ("model", q.model), ("from", q.fromInstant),
     ("to", q.toInstant), ("user", q.user), ("limit", q.limit.map toString),
     ("cursor", q.cursor)]
  candidates.filterMap fun (key, value) => value.map (key, ·)

end Runs
end AgentWorkspace.Contracts
