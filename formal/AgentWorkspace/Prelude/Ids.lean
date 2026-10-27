import AgentWorkspace.Trace.Spec
import AgentWorkspace.Prelude.WireEnum

/-!
# Typed identifiers

Every table key in the schema is a PostgreSQL `uuid` (`packages/core/src/db/schema/columns.ts`,
`primaryKeyId`), and the wire carries it as a string. The model keeps the string but tags it with
the kind of row it names, so a `RunId` can never be passed where an `AgentId` is expected.

**Choice.** One structure `Id (k : IdKind)` with a phantom kind, rather than one structure per
kind. Equality, ordering and hashing are derived once for every kind, the kinds form a closed
enumeration that `Er/Core.lean` maps onto the tables, and adding a kind is one constructor.
Two ids of different kinds have different types, so they cannot even be compared.

Tables whose primary key is not a single `id` column get a key structure of their own
(`RunEventKey`, `SessionTranscriptKey`, `SessionMessageKey`, `ProjectFileKey`,
`ProjectConnectorKey`). `share_run_charges` is keyed by its run, so its key is a `RunId`.
-/

namespace AgentWorkspace

/-- The kinds of row an identifier can name: one per table whose primary key is `id uuid`.
`connector` is the `mcp_servers` table; `principal` is `workspace_principals`. -/
@[aw_spec (ts := "packages/core/src/db/schema/columns.ts#primaryKeyId")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
inductive IdKind where
  | workspace | user | userIdentity | membership | principal | apiKey | invitation
  | browserToken | cliSession | agent | agentFile | agentGrant | agentConnector | agentSkill | agentStorageGrant
  | agentVersion | agentVersionStorageGrant
  | agentVersionEvaluation | agentPointerMove | endpointClient | oauthToken | skill | skillRevision
  | file | fileText
  | connector | modelConnection | runtimeProfile | runtimeVerification | secret | project | session | run | runToken
  | runUsageRecord | runFeedback | share | shareView | auditEvent | trigger | triggerDelivery
  | storageConnection | storageMigrationRun | builderToolCall
  deriving DecidableEq, Repr, Inhabited, Hashable, Ord

namespace IdKind

/-- Every identifier kind, in the order of the list above. -/
def all : List IdKind :=
  [workspace, user, userIdentity, membership, principal, apiKey, invitation, browserToken,
    cliSession, agent, agentFile, agentGrant, agentConnector, agentSkill, agentStorageGrant, agentVersion, agentVersionStorageGrant, agentVersionEvaluation, agentPointerMove, endpointClient, oauthToken, skill, skillRevision, file, fileText,
    connector, modelConnection, runtimeProfile, runtimeVerification, secret, project, session, run, runToken,
    runUsageRecord, runFeedback, share, shareView, auditEvent, trigger, triggerDelivery,
    storageConnection, storageMigrationRun, builderToolCall]

theorem mem_all (k : IdKind) : k ∈ all := by cases k <;> decide

/-- The wire spelling of a kind: its name in kebab case (`user-identity`, `api-key`, …). -/
def toWire : IdKind → String
  | workspace => "workspace"
  | user => "user"
  | userIdentity => "user-identity"
  | membership => "membership"
  | principal => "principal"
  | apiKey => "api-key"
  | invitation => "invitation"
  | browserToken => "browser-token"
  | cliSession => "cli-session"
  | agent => "agent"
  | agentFile => "agent-file"
  | agentGrant => "agent-grant"
  | agentConnector => "agent-connector"
  | agentSkill => "agent-skill"
  | agentStorageGrant => "agent-storage-grant"
  | agentVersion => "agent-version"
  | agentVersionStorageGrant => "agent-version-storage-grant"
  | agentVersionEvaluation => "agent-version-evaluation"
  | agentPointerMove => "agent-pointer-move"
  | endpointClient => "endpoint-client"
  | oauthToken => "oauth-token"
  | skill => "skill"
  | skillRevision => "skill-revision"
  | file => "file"
  | fileText => "file-text"
  | connector => "connector"
  | modelConnection => "model-connection"
  | runtimeProfile => "runtime-profile"
  | runtimeVerification => "runtime-verification"
  | secret => "secret"
  | project => "project"
  | session => "session"
  | run => "run"
  | runToken => "run-token"
  | runUsageRecord => "run-usage-record"
  | runFeedback => "run-feedback"
  | share => "share"
  | shareView => "share-view"
  | auditEvent => "audit-event"
  | trigger => "trigger"
  | triggerDelivery => "trigger-delivery"
  | storageConnection => "storage-connection"
  | storageMigrationRun => "storage-migration-run"
  | builderToolCall => "builder-tool-call"

/-- The kind a wire spelling denotes, if any. -/
def ofWire? : String → Option IdKind
  | "workspace" => some workspace
  | "user" => some user
  | "user-identity" => some userIdentity
  | "membership" => some membership
  | "principal" => some principal
  | "api-key" => some apiKey
  | "invitation" => some invitation
  | "browser-token" => some browserToken
  | "cli-session" => some cliSession
  | "agent" => some agent
  | "agent-file" => some agentFile
  | "agent-grant" => some agentGrant
  | "agent-connector" => some agentConnector
  | "agent-skill" => some agentSkill
  | "agent-storage-grant" => some agentStorageGrant
  | "agent-version" => some agentVersion
  | "agent-version-storage-grant" => some agentVersionStorageGrant
  | "agent-version-evaluation" => some agentVersionEvaluation
  | "agent-pointer-move" => some agentPointerMove
  | "endpoint-client" => some endpointClient
  | "oauth-token" => some oauthToken
  | "skill" => some skill
  | "skill-revision" => some skillRevision
  | "file" => some file
  | "file-text" => some fileText
  | "connector" => some connector
  | "model-connection" => some modelConnection
  | "runtime-profile" => some runtimeProfile
  | "runtime-verification" => some runtimeVerification
  | "secret" => some secret
  | "project" => some project
  | "session" => some session
  | "run" => some run
  | "run-token" => some runToken
  | "run-usage-record" => some runUsageRecord
  | "run-feedback" => some runFeedback
  | "share" => some share
  | "share-view" => some shareView
  | "audit-event" => some auditEvent
  | "trigger" => some trigger
  | "trigger-delivery" => some triggerDelivery
  | "storage-connection" => some storageConnection
  | "storage-migration-run" => some storageMigrationRun
  | "builder-tool-call" => some builderToolCall
  | _ => none

private theorem ofWire?_toWire (k : IdKind) : ofWire? (toWire k) = some k := by
  cases k <;> decide

instance : WireEnum IdKind where
  all := all
  toWire := toWire
  complete := mem_all
  nodup := by decide
  toWire_injective := by
    intro a b h
    have := congrArg ofWire? h
    rwa [ofWire?_toWire, ofWire?_toWire, Option.some.injEq] at this

end IdKind

/-- An identifier of a row of kind `k`: the textual UUID the database minted, tagged with its
kind. The model never inspects the text beyond equality; `Uuid.isCanonical` states its shape. -/
@[aw_spec (ts := "packages/contracts/src/identifiers.ts#UuidSchema")]
structure Id (k : IdKind) where
  /-- The UUID as the wire and the database render it. -/
  val : String
  deriving DecidableEq, Repr, Inhabited, Hashable, Ord

instance {k : IdKind} : ToString (Id k) := ⟨Id.val⟩

abbrev WorkspaceId := Id .workspace
abbrev UserId := Id .user
abbrev UserIdentityId := Id .userIdentity
abbrev MembershipId := Id .membership
abbrev PrincipalId := Id .principal
abbrev ApiKeyId := Id .apiKey
abbrev InvitationId := Id .invitation
abbrev BrowserTokenId := Id .browserToken
/-- One `aw login` of one person (`cli_sessions`, ADR-0083). -/
abbrev CliSessionId := Id .cliSession
abbrev AgentId := Id .agent
abbrev AgentFileId := Id .agentFile
abbrev AgentGrantId := Id .agentGrant
abbrev AgentConnectorId := Id .agentConnector
abbrev AgentSkillId := Id .agentSkill
/-- One folder of a storage connection an agent may reach (`agent_storage_grants`, #1693). -/
abbrev AgentStorageGrantId := Id .agentStorageGrant
/-- One immutable, numbered version of an agent's definition (`agent_versions`, #442). -/
abbrev AgentVersionId := Id .agentVersion
/-- One folder of a storage connection one agent version grants (`agent_version_storage_grants`,
#1694). -/
abbrev AgentVersionStorageGrantId := Id .agentVersionStorageGrant
/-- One server-scored evaluation of an agent version (`agent_version_evaluations`, #618). -/
abbrev AgentVersionEvaluationId := Id .agentVersionEvaluation
/-- One recorded move of an agent's version pointer (`agent_pointer_moves`, #615). -/
abbrev AgentPointerMoveId := Id .agentPointerMove
/-- What an external platform may reach, and the credentials bound to it (`endpoint_clients`,
ADR-0134). -/
abbrev EndpointClientId := Id .endpointClient
/-- One OAuth code, access token or refresh token issued to an endpoint client (`oauth_tokens`,
ADR-0134 part 3). -/
abbrev OAuthTokenId := Id .oauthToken
abbrev SkillId := Id .skill
/-- One published, immutable revision of a skill (`skill_revisions`, SDK-19). -/
abbrev SkillRevisionId := Id .skillRevision
abbrev FileId := Id .file
/-- One extracted, searchable text chunk of a file (`file_texts`). -/
abbrev FileTextId := Id .fileText
/-- A connector is a row of `mcp_servers`. -/
abbrev ConnectorId := Id .connector
abbrev ModelConnectionId := Id .modelConnection
abbrev RuntimeProfileId := Id .runtimeProfile
/-- The last passing Test Runtime of one driver in one workspace (`runtime_verifications`). -/
abbrev RuntimeVerificationId := Id .runtimeVerification
/-- A secret; a runtime connection is also a `secrets` row (`runtime_profiles.runtime_connection_id`). -/
abbrev SecretId := Id .secret
abbrev ProjectId := Id .project
abbrev SessionId := Id .session
abbrev RunId := Id .run
abbrev RunTokenId := Id .runToken
abbrev RunUsageRecordId := Id .runUsageRecord
/-- One rating of one run's answer (`run_feedback`, #539). -/
abbrev RunFeedbackId := Id .runFeedback
abbrev ShareId := Id .share
abbrev ShareViewId := Id .shareView
abbrev AuditEventId := Id .auditEvent
/-- What starts a run without a person at the keyboard: a webhook or a schedule (`triggers`,
ADR-0144). -/
abbrev TriggerId := Id .trigger
/-- One claimed `(trigger, delivery_key)` slot of a firing (`trigger_deliveries`, ADR-0144). -/
abbrev TriggerDeliveryId := Id .triggerDelivery
/-- One verify pass of the move off the old object naming (`storage_migration_runs`, the storage
design, §06). -/
abbrev StorageMigrationRunId := Id .storageMigrationRun
/-- A bucket or folder a workspace connected (`storage_connections`, the storage design, §05). -/
abbrev StorageConnectionId := Id .storageConnection
/-- One tool call of a Builder run, as the journal keeps it (`builder_tool_calls`, issue #1845). -/
abbrev BuilderToolCallId := Id .builderToolCall

/-- `run_events` is keyed by `(run_id, sequence)` (`run_events_pkey`). -/
@[aw_spec (ts := "packages/core/src/db/schema/run-events.ts#runEvents")]
structure RunEventKey where
  run : RunId
  sequence : Nat
  deriving DecidableEq, Repr, Inhabited, Hashable, Ord

/-- `session_transcripts` is keyed by `(workspace_id, project_key, session_id, subpath)`; the
empty `subpath` is the main transcript. -/
@[aw_spec (ts := "packages/core/src/db/schema/session-transcripts.ts#sessionTranscripts")]
structure SessionTranscriptKey where
  workspace : WorkspaceId
  projectKey : String
  session : SessionId
  subpath : String
  deriving DecidableEq, Repr, Inhabited, Hashable, Ord

/-- `session_messages` adds the message `sequence` to its transcript's key. -/
@[aw_spec (ts := "packages/core/src/db/schema/session-messages.ts#sessionMessages")]
structure SessionMessageKey where
  transcript : SessionTranscriptKey
  sequence : Nat
  deriving DecidableEq, Repr, Inhabited, Hashable, Ord

/-- `project_files` is keyed by `(project_id, file_id)`. -/
@[aw_spec (ts := "packages/core/src/db/schema/project-files.ts#projectFiles")]
structure ProjectFileKey where
  project : ProjectId
  file : FileId
  deriving DecidableEq, Repr, Inhabited, Hashable, Ord

/-- `project_mcp_servers` is keyed by `(project_id, mcp_server_id)`. -/
@[aw_spec (ts := "packages/core/src/db/schema/project-mcp-servers.ts#projectMcpServers")]
structure ProjectConnectorKey where
  project : ProjectId
  connector : ConnectorId
  deriving DecidableEq, Repr, Inhabited, Hashable, Ord

namespace Uuid

/-- A hexadecimal digit in either case, as `UUID_PATTERN`'s `/i` flag admits. -/
def isHexDigit (c : Char) : Bool :=
  ('0' ≤ c && c ≤ '9') || ('a' ≤ c && c ≤ 'f') || ('A' ≤ c && c ≤ 'F')

/-- The character pattern of the canonical form: `8-4-4-4-12` hexadecimal digits. -/
def shape : List Bool :=
  List.replicate 8 true ++ [false] ++ List.replicate 4 true ++ [false] ++
    List.replicate 4 true ++ [false] ++ List.replicate 4 true ++ [false] ++
    List.replicate 12 true

/-- `isUuid`: the RFC 9562 canonical textual form, any version, either case
(`UUID_PATTERN = /^[0-9a-f]{8}-…-[0-9a-f]{12}$/i`). -/
@[aw_spec (ts := "packages/contracts/src/identifiers.ts#UUID_PATTERN")
  (ts := "packages/contracts/src/identifiers.ts#isUuid")]
def isCanonical (s : String) : Bool :=
  let cs := s.toList
  cs.length == shape.length &&
    (cs.zip shape).all fun (c, hex) => if hex then isHexDigit c else c == '-'

end Uuid

end AgentWorkspace
