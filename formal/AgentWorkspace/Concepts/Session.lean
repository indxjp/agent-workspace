import AgentWorkspace.Prelude.Json
import AgentWorkspace.Prelude.Ids
import AgentWorkspace.Contracts.Engines
import AgentWorkspace.Concepts.ModelConnection

/-!
# Session, transcript and transcript message

A **session** is "not a run; it is the continuity between runs": one conversation with one agent
(`packages/core/src/db/schema/sessions.ts`; `docs/sdk/site/concepts/run-lifecycle.mdx`). It
belongs to exactly one workspace, one agent and one owning principal, to at most one project, and
to at most one member (the legacy `user_id`, which must then be a member of the same workspace).

Three identifiers meet here, and the glossary in `docs/formal/units/concept-work.md` keeps them
apart:

* `Session.id` — the platform's own row id (`sessions.id`, `SessionResource.id`,
  `StartRunRequest.sessionId`, `RunResource.sessionId`);
* `Session.engineSessionId` — the *engine's* session id (`sessions.engine_session_id`,
  `SessionResource.engineSessionId`, the `:engineSessionId` / `:providerSessionId` path segment
  of the transcript routes; ADR-0065 renamed the field from `claudeSessionId`, while the route
  segment keeps its name). It is `NULL` until the first run reports it, and today the runtime
  must report exactly the platform id (`recordReportedSessionIdentity`), so it is either absent
  or equal to `id`. `Session.engine` names the engine that minted it, and the two are written
  together: an id is reported *by* an engine, so a session that has one always says which;
* the transcript key `(workspace_id, project_key, session_id, subpath)`, whose `project_key` is
  the workspace id by construction and whose empty `subpath` is the main transcript.

Lifecycle: `active` or `archived` (`sessionStatuses`). A session is `resumable` when it is active
and the SDK has reported its id.
-/

namespace AgentWorkspace.Concepts.Session

open AgentWorkspace

/-- `SESSION_STATUSES`: "§20's four supported operations reduce to two states". -/
@[aw_spec (ts := "packages/contracts/src/sessions.ts#SESSION_STATUSES")
  (ts := "packages/core/src/db/schema/sessions.ts#sessionStatuses")]
inductive SessionStatus where
  | active
  | archived
  deriving DecidableEq, Repr, Inhabited

namespace SessionStatus

/-- The wire spelling. -/
def toWire : SessionStatus → String
  | active => "active"
  | archived => "archived"

instance : WireEnum SessionStatus where
  all := [active, archived]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end SessionStatus

/-- One session, with the fields `sessions` stores. -/
@[aw_spec (ts := "packages/core/src/db/schema/sessions.ts#sessions")
  (ts := "packages/contracts/src/sessions.ts#SessionResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
structure Session where
  id : SessionId
  workspace : WorkspaceId
  user : Option UserId
  ownerPrincipal : PrincipalId
  agent : AgentId
  project : Option ProjectId
  engineSessionId : Option String
  /-- `sessions.engine` (ADR-0065): the engine that reported `engineSessionId`. -/
  engine : Option Contracts.Engines.EngineId
  /-- `sessions.agent_version_id` (issue #612): the agent version the conversation started on,
  written once at insert. `none` is a legacy, unversioned agent. -/
  agentVersion : Option AgentVersionId
  title : Option String
  status : SessionStatus
  createdAt : Nat
  updatedAt : Nat
  deriving DecidableEq, Repr, Inhabited

/-- How the runner launches a run in a session. -/
@[aw_spec (ts := "apps/web/server/composition/session-launch.ts#sessionForLaunch")]
inductive LaunchMode where
  /-- The SDK has never reported a session: start one (`{ id, agentId }`). -/
  | fresh
  /-- Resume the SDK session (`{ id, agentId, resume: true }`). -/
  | resume
  deriving DecidableEq, Repr, Inhabited

namespace Session

/-- `resumable`: "active, and known to the SDK" (`row.status === 'active' &&
row.engineSessionId !== null`). -/
@[aw_spec (ts := "apps/web/server/sessions/api.ts#resumable")
  (ts := "packages/contracts/src/sessions.ts#SessionResourceSchema")]
def resumable (s : Session) : Bool := s.status == .active && s.engineSessionId.isSome

/-- `sessionForLaunch`: fresh until the SDK has reported an id, resume afterwards. -/
@[aw_spec (ts := "apps/web/server/composition/session-launch.ts#sessionForLaunch")]
def launchMode (s : Session) : LaunchMode :=
  if s.engineSessionId.isNone then .fresh else .resume

/-- `recordReportedSessionIdentity`: the runtime's reported SDK session id is recorded only when
it equals the platform id; any other id is refused (the function throws). -/
@[aw_spec (ts := "apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity")]
def recordReported (s : Session) (reported : String) : Option Session :=
  if reported == s.id.val then
    some { s with engineSessionId := some reported, engine := some .claudeAgentSdk }
  else none

/-- ADR-0065's pairing: a session that carries an engine session id always names its engine.

`recordReportedSessionIdentity` is the one writer, and it writes both cells in one update, so the
state `engine = NULL ∧ engine_session_id ≠ NULL` is unreachable after migration 0025 backfills the
rows written before the column existed. -/
@[aw_spec (ts := "apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity")
  (ts := "packages/core/src/db/schema/sessions.ts#engine")]
def enginePaired (s : Session) : Bool := s.engineSessionId.isNone || s.engine.isSome

/-- Today's identity invariant: the SDK session id is absent or equals the platform id. Only the
application keeps it; `engine_session_id` is free text to the database. -/
@[aw_spec (ts := "apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity")
  (ts := "packages/core/src/db/schema/sessions.ts#engineSessionId")]
def identityCurrent (s : Session) : Bool := s.engineSessionId.all (· == s.id.val)

end Session

/-! ## Transcript keys -/

/-- A character of `PROJECT_KEY_PATTERN`'s class `[A-Za-z0-9_-]`. -/
def isKeyChar (c : Char) : Bool :=
  ('A' ≤ c && c ≤ 'Z') || ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9') || c == '_' || c == '-'

/-- An ASCII letter or digit. -/
def isAsciiAlnum (c : Char) : Bool :=
  ('A' ≤ c && c ≤ 'Z') || ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9')

/-- `PROJECT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/`, which is also the SDK's own validator for
`CLAUDE_CODE_PROJECT_DIR_NAME` (`SDK_PROJECT_DIR_NAME`). -/
@[aw_spec (ts := "packages/contracts/src/sessions.ts#PROJECT_KEY_PATTERN")
  (ts := "packages/run-protocol/src/schemas.ts#SDK_PROJECT_DIR_NAME")]
def isProjectKey (s : String) : Bool :=
  let cs := s.toList
  1 ≤ cs.length && cs.length ≤ 64 && cs.all isKeyChar

/-- ASCII lower case. -/
def lowerAscii (c : Char) : Char := if 'A' ≤ c && c ≤ 'Z' then Char.ofNat (c.toNat + 32) else c

/-- `SDK_WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i`. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#SDK_WINDOWS_DEVICE_NAME")]
def isWindowsDeviceName (s : String) : Bool :=
  match s.toList.map lowerAscii with
  | ['c', 'o', 'n'] | ['p', 'r', 'n'] | ['a', 'u', 'x'] | ['n', 'u', 'l'] => true
  | ['c', 'o', 'm', d] | ['l', 'p', 't', d] => '0' ≤ d && d ≤ '9'
  | _ => false

/-- `validateTenantSessionScope` for string inputs: the config directory is not blank, and the
project key passes the SDK's validator and is not a Windows device name. A scope that fails is
one the SDK would silently ignore, keying the session under a path shared across tenants. -/
@[aw_spec (ts := "packages/run-protocol/src/schemas.ts#validateTenantSessionScope")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
def tenantScopeOk (projectKey configDir : String) : Bool :=
  !ModelConnection.isBlank configDir && isProjectKey projectKey &&
    !isWindowsDeviceName projectKey

/-- The database spelling of the main transcript's subpath. -/
@[aw_spec (ts := "packages/core/src/db/schema/session-transcripts.ts#subpath")]
def mainSubpath : String := ""

/-- `TRANSCRIPT_SUBPATH_MAX_LENGTH`. -/
@[aw_spec (ts := "packages/contracts/src/sessions.ts#TRANSCRIPT_SUBPATH_MAX_LENGTH")]
def subpathMaxLength : Nat := 128

/-- One `/`-separated segment `[A-Za-z0-9][A-Za-z0-9_-]*`. -/
def isSubpathSegment : List Char → Bool
  | [] => false
  | c :: rest => isAsciiAlnum c && rest.all isKeyChar

/-- Split on `/`. -/
def splitSlash : List Char → List (List Char)
  | [] => [[]]
  | '/' :: rest => [] :: splitSlash rest
  | c :: rest =>
    match splitSlash rest with
    | seg :: segs => (c :: seg) :: segs
    | [] => [[c]]

/-- A subagent transcript subpath as the wire admits it: `TRANSCRIPT_SUBPATH_PATTERN` (one or
more segments joined by `/`) and at most 128 characters. The empty string is refused. -/
@[aw_spec (ts := "packages/contracts/src/sessions.ts#TRANSCRIPT_SUBPATH_PATTERN")
  (ts := "packages/contracts/src/sessions.ts#TRANSCRIPT_SUBPATH_MAX_LENGTH")
  (doc := "docs/sdk/04-api-specification.md#511-sessions-and-transcripts--awsessions")]
def isWireSubpath (s : String) : Bool :=
  s.length ≤ subpathMaxLength && (splitSlash s.toList).all isSubpathSegment

/-- One stored transcript (`session_transcripts`): a main (`subpath = ''`) or subagent transcript
of one platform session. -/
@[aw_spec (ts := "packages/core/src/db/schema/session-transcripts.ts#sessionTranscripts")]
structure Transcript where
  key : SessionTranscriptKey
  createdAt : Nat
  updatedAt : Nat
  deriving DecidableEq, Repr, Inhabited

namespace Transcript

/-- The main transcript. -/
def isMain (t : Transcript) : Bool := t.key.subpath == mainSubpath

/-- The transcript is stored under its workspace's own key: `projectKey` is the workspace id.
The repository refuses any other key; the database does not. -/
@[aw_spec (ts := "packages/core/src/db/repositories/session-transcripts.ts#createDatabaseSessionTranscriptRepositoryProvider")
  (ts := "packages/contracts/src/sessions.ts#PROJECT_KEY_PATTERN")]
def projectKeyIsWorkspace (t : Transcript) : Bool := t.key.projectKey == t.key.workspace.val

end Transcript

/-- One delivered transcript entry (`session_messages`). `position` is the first-delivery
sequence of the entry's UUID: "Redeliveries retain it so load order never changes." -/
@[aw_spec (ts := "packages/core/src/db/schema/session-messages.ts#sessionMessages")]
structure TranscriptMessage where
  key : SessionMessageKey
  position : Nat
  entryUuid : Option String
  entry : String
  createdAt : Nat
  deriving DecidableEq, Repr, Inhabited

/-- A delivery is never placed after itself: its position is its own sequence (first delivery)
or an earlier one (a redelivery). -/
@[aw_spec (ts := "packages/core/src/db/schema/session-messages.ts#position")]
def TranscriptMessage.positionAtMostSequence (m : TranscriptMessage) : Bool :=
  m.position ≤ m.key.sequence

end AgentWorkspace.Concepts.Session
