import AgentWorkspace.Er.Core
import AgentWorkspace.Concepts.Project
import AgentWorkspace.Concepts.Session
import AgentWorkspace.Concepts.Run
import AgentWorkspace.Concepts.RunEvent
import AgentWorkspace.Concepts.Usage

/-!
# Today's work tables

The work cluster of the current schema: `projects`, `sessions`, `session_transcripts`,
`session_messages`, the three ENG-06 `session_state_*` tables, `runs`, `run_events`, `run_feedback`,
`run_tokens`, `run_usage_records`, `audit_events` and `surface_session_keys`.
Their columns, keys, foreign keys, unique keys and closed-set checks are already transcribed, and
pinned to the latest snapshot (`Er.Snapshot.file`), in `Er.Core.catalogue`; this module does not copy
them. It adds what the cluster needs on top:

1. **The other checks, with meaning.** `Er.Core` records the 21 checks of these tables that are
   not closed sets by name only (they hold vacuously there). `workCheck` gives each its
   semantics over a `Row`, following SQL's three-valued reading (a comparison with a `NULL`
   operand passes), and `workCheckSql` keeps the exact body `drizzle-kit` rendered, which the
   vectors compare with the snapshot. `workConsistent` is `Er.Core.consistent` plus these.
2. **Concept rows.** `projectCells` … `auditCells` map each concept value to the row it is
   stored as (a timestamp as its decimal instant, an id as its UUID text, an enum as its wire
   spelling), so the concept invariants and the row checks can be proved to agree.
3. **Relationship shape.** `workFk` looks a foreign key up by name, and `fkCardinality` reads off
   whether a child row links exactly one parent (every key column `NOT NULL`) or at most one.
-/

namespace AgentWorkspace.Er.Current.Work

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Contracts
open AgentWorkspace.Concepts.Project AgentWorkspace.Concepts.Session AgentWorkspace.Concepts.Run
open AgentWorkspace.Concepts.RunEvent AgentWorkspace.Concepts.Usage

/-- The fourteen tables of the work cluster.

ENG-06 (#305) added the last three: `session_state_streams`, `session_state_entries` and
`session_state_blobs` are the engine-scoped generalisation of `session_transcripts` and
`session_messages`, and they belong to the same cluster because they are the same fact about a
session told for every engine rather than for one. The Claude pair stays until the contract step of
the expand/contract migration (ADR-0071). -/
@[aw_spec (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/index.ts")]
def workTables : List TableName :=
  [.projects, .sessions, .sessionTranscripts, .sessionMessages, .sessionStateStreams,
    .sessionStateEntries, .sessionStateBlobs, .runs, .runEvents, .runFeedback, .runTokens,
    .runUsageRecords, .auditEvents, .surfaceSessionKeys]

/-! ## Audit events -/

/-- `AUDIT_ACTIONS` (`auditActions` in the schema): the control-plane actions the audit trail
records. -/
@[aw_spec (ts := "packages/contracts/src/observability.ts#AUDIT_ACTIONS")
  (ts := "packages/core/src/db/schema/audit-events.ts#auditActions")]
inductive AuditAction where
  | userCreated | userDeleted | agentChanged | providerCredentialChanged | apiKeyCreated
  | apiKeyRevoked | connectorChanged | permissionChanged | runtimeProfileChanged | projectCreated
  | projectDeleted | projectArchived | projectRestored | sessionPublished | publicLinkRevoked
  | runnableLinkStopped | publicSharingPolicyChanged | invitationCreated | invitationResent
  | invitationRevoked | invitationAccepted | endpointClientCreated | endpointClientChanged
  | endpointClientRevoked | endpointToolCalled | oauthClientSecretRotated | oauthGrantIssued
  | oauthGrantRevoked
  deriving DecidableEq, Repr, Inhabited

namespace AuditAction

/-- The wire spelling. -/
def toWire : AuditAction → String
  | userCreated => "user-created"
  | userDeleted => "user-deleted"
  | agentChanged => "agent-changed"
  | providerCredentialChanged => "provider-credential-changed"
  | apiKeyCreated => "api-key-created"
  | apiKeyRevoked => "api-key-revoked"
  | connectorChanged => "connector-changed"
  | permissionChanged => "permission-changed"
  | runtimeProfileChanged => "runtime-profile-changed"
  | projectCreated => "project-created"
  | projectDeleted => "project-deleted"
  | projectArchived => "project-archived"
  | projectRestored => "project-restored"
  | sessionPublished => "session-published"
  | publicLinkRevoked => "public-link-revoked"
  | runnableLinkStopped => "runnable-link-stopped"
  | publicSharingPolicyChanged => "public-sharing-policy-changed"
  | invitationCreated => "invitation-created"
  | invitationResent => "invitation-resent"
  | invitationRevoked => "invitation-revoked"
  | invitationAccepted => "invitation-accepted"
  | endpointClientCreated => "endpoint-client-created"
  | endpointClientChanged => "endpoint-client-changed"
  | endpointClientRevoked => "endpoint-client-revoked"
  | endpointToolCalled => "endpoint-tool-called"
  | oauthClientSecretRotated => "oauth-client-secret-rotated"
  | oauthGrantIssued => "oauth-grant-issued"
  | oauthGrantRevoked => "oauth-grant-revoked"

instance : WireEnum AuditAction where
  all := [userCreated, userDeleted, agentChanged, providerCredentialChanged, apiKeyCreated,
    apiKeyRevoked, connectorChanged, permissionChanged, runtimeProfileChanged, projectCreated,
    projectDeleted, projectArchived, projectRestored, sessionPublished, publicLinkRevoked,
    runnableLinkStopped, publicSharingPolicyChanged, invitationCreated, invitationResent,
    invitationRevoked, invitationAccepted, endpointClientCreated, endpointClientChanged,
    endpointClientRevoked, endpointToolCalled, oauthClientSecretRotated, oauthGrantIssued,
    oauthGrantRevoked]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end AuditAction

/-- One audit row: who, what, to which thing, when. The labels are snapshots taken when the row
was written; `subjectId` is text with no foreign key, because the subject may be gone. -/
@[aw_spec (ts := "packages/core/src/db/schema/audit-events.ts#auditEvents")
  (ts := "packages/contracts/src/observability.ts#AuditEventSchema")
  (doc := "docs/sdk/04-api-specification.md#514-metrics-and-audit--awobservability")]
structure AuditEvent where
  id : AuditEventId
  workspace : WorkspaceId
  actorUser : Option UserId
  actorPrincipal : Option PrincipalId
  actorLabel : String
  action : AuditAction
  subjectId : Option String
  subjectLabel : String
  createdAt : Nat
  deriving DecidableEq, Repr, Inhabited

/-- The three checks of `audit_events` that are not closed sets: both labels non-blank, and a
recorded subject id has the canonical UUID shape. -/
@[aw_spec (ts := "packages/core/src/db/schema/audit-events.ts#audit_events_subject_id_shape")
  (ts := "packages/core/src/db/schema/audit-events.ts#audit_events_actor_label_not_blank")]
def AuditEvent.wellFormed (e : AuditEvent) : Bool :=
  hasNonSpace e.actorLabel && hasNonSpace e.subjectLabel && e.subjectId.all Uuid.isCanonical

/-! ## Rows from concept values -/

/-- A row from `(column, value?)` cells: a `none` value is SQL `NULL` (no cell). -/
def ofCells (l : List (String × Option String)) : Row :=
  ⟨l.filterMap fun p => p.2.map (p.1, ·)⟩

/-- A timestamp cell: the instant as decimal text. -/
def instant (n : Nat) : String := toString n

/-- The cells of a `projects` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/projects.ts#projects")]
def projectCells (p : Project) : List (String × Option String) :=
  [("id", some p.id.val), ("workspace_id", some p.workspace.val), ("name", some p.name),
    ("instructions", p.instructions), ("default_agent_id", p.defaultAgent.map (·.val)),
    ("visibility", some (WireEnum.toWire p.visibility)),
    ("default_model_connection_id", p.defaultModelConnection.map (·.val)),
    ("default_model", p.defaultModel), ("created_by", p.createdBy.map (·.val)),
    ("owner_principal_id", some p.ownerPrincipal.val),
    ("archived_at", p.archivedAt.map instant), ("created_at", some (instant p.createdAt)),
    ("updated_at", some (instant p.updatedAt))]

/-- The cells of a `sessions` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/sessions.ts#sessions")]
def sessionCells (s : Session) : List (String × Option String) :=
  [("id", some s.id.val), ("workspace_id", some s.workspace.val),
    ("user_id", s.user.map (·.val)), ("owner_principal_id", some s.ownerPrincipal.val),
    ("agent_id", some s.agent.val), ("project_id", s.project.map (·.val)),
    ("engine_session_id", s.engineSessionId),
    ("engine", s.engine.map WireEnum.toWire), ("agent_version_id", s.agentVersion.map (·.val)),
    ("title", s.title),
    ("status", some (WireEnum.toWire s.status)), ("created_at", some (instant s.createdAt)),
    ("updated_at", some (instant s.updatedAt))]

/-- The cells of a `session_transcripts` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/session-transcripts.ts#sessionTranscripts")]
def transcriptCells (t : Transcript) : List (String × Option String) :=
  [("workspace_id", some t.key.workspace.val), ("project_key", some t.key.projectKey),
    ("session_id", some t.key.session.val), ("subpath", some t.key.subpath),
    ("created_at", some (instant t.createdAt)), ("updated_at", some (instant t.updatedAt))]

/-- The cells of a `session_messages` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/session-messages.ts#sessionMessages")]
def messageCells (m : TranscriptMessage) : List (String × Option String) :=
  [("workspace_id", some m.key.transcript.workspace.val),
    ("project_key", some m.key.transcript.projectKey),
    ("session_id", some m.key.transcript.session.val),
    ("subpath", some m.key.transcript.subpath), ("sequence", some (toString m.key.sequence)),
    ("position", some (toString m.position)), ("entry_uuid", m.entryUuid),
    ("entry", some m.entry), ("created_at", some (instant m.createdAt))]

/-- The cells of a `runs` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs")]
def runCells (r : Run) : List (String × Option String) :=
  [("id", some r.id.val), ("workspace_id", some r.workspace.val),
    ("session_id", some r.session.val), ("status", some (WireEnum.toWire r.status)),
    ("model", r.model), ("provider", r.provider.map WireEnum.toWire),
    ("model_connection_id", r.modelConnection.map (·.val)),
    -- `Concepts/Run.lean` does not carry the tool connector snapshot yet (ADR-0113 C16), so a
    -- run concept renders the empty set, the column default.
    ("tool_connector_ids", some "{}"),
    ("started_at", r.startedAt.map instant), ("ended_at", r.endedAt.map instant),
    ("input_tokens", some (toString r.counters.inputTokens)),
    ("output_tokens", some (toString r.counters.outputTokens)),
    ("cache_read_input_tokens", some (toString r.counters.cacheReadInputTokens)),
    ("cache_creation_input_tokens", some (toString r.counters.cacheCreationInputTokens)),
    ("cost_usd", some r.costUsd), ("cost_currency", some r.costCurrency),
    ("price_table_version", r.priceTableVersion),
    ("tool_calls", some (toString r.counters.toolCalls)), ("error", r.error),
    ("accounting_state", some (WireEnum.toWire r.accountingState)),
    ("accounting_error", r.accountingError), ("created_at", some (instant r.createdAt)),
    ("updated_at", some (instant r.updatedAt))]

/-- The cells of a `run_events` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-events.ts#runEvents")]
def runEventCells (e : RunEvent) : List (String × Option String) :=
  [("run_id", some e.key.run.val), ("workspace_id", some e.workspace.val),
    ("sequence", some (toString e.key.sequence)), ("type", some e.type), ("data", some e.data),
    ("created_at", some (instant e.createdAt))]

/-- The cells of a `run_tokens` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-tokens.ts#runTokens")]
def runTokenCells (t : RunToken) : List (String × Option String) :=
  [("id", some t.id.val), ("run_id", some t.run.val), ("workspace_id", some t.workspace.val),
    ("token_hash", some t.tokenHash), ("expires_at", some (instant t.expiresAt)),
    ("revoked_at", t.revokedAt.map instant), ("created_at", some (instant t.createdAt))]

/-- The cells of a `run_usage_records` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")]
def usageCells (u : UsageRecord) : List (String × Option String) :=
  [("id", some u.id.val), ("workspace_id", some u.workspace.val), ("run_id", some u.run.val),
    ("provider_response_id", some u.providerResponseId), ("provider", some u.provider),
    ("model", some u.model), ("input_tokens", some (toString u.counters.inputTokens)),
    ("output_tokens", some (toString u.counters.outputTokens)),
    ("cache_read_input_tokens", some (toString u.counters.cacheReadInputTokens)),
    ("cache_creation_input_tokens", some (toString u.counters.cacheCreationInputTokens)),
    ("tool_calls", some (toString u.counters.toolCalls)), ("cost_usd", some u.costUsd),
    ("cost_currency", some u.costCurrency),
    ("wire_protocol", some (WireEnum.toWire u.wireProtocol)),
    ("price_table_version", u.priceTableVersion),
    ("created_at", some (instant u.createdAt))]

/-- The cells of an `audit_events` row. -/
@[aw_spec (ts := "packages/core/src/db/schema/audit-events.ts#auditEvents")]
def auditCells (e : AuditEvent) : List (String × Option String) :=
  [("id", some e.id.val), ("workspace_id", some e.workspace.val),
    ("actor_user_id", e.actorUser.map (·.val)),
    ("actor_principal_id", e.actorPrincipal.map (·.val)), ("actor_label", some e.actorLabel),
    ("action", some (WireEnum.toWire e.action)), ("subject_id", e.subjectId),
    ("subject_label", some e.subjectLabel), ("created_at", some (instant e.createdAt))]

/-! ## The checks that are not closed sets -/

/-- The wire spellings of the terminal run statuses, as `terminalRunStatuses` renders them into
`runs_ended_at_iff_terminal`. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#terminalRunStatuses")]
def terminalWires : List String := RunStatus.terminal.map WireEnum.toWire

/-- The accounting states with priced usage, as `runs_price_version_matches_accounting_state`
and `runs_unpriced_cost_zero` spell them. -/
def pricedWires : List String := ["complete", "partial"]

/-- The integer counter columns of `runs` and `run_usage_records`. -/
def counterColumns : List String :=
  ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
    "tool_calls"]

/-- Decimal digits read as a natural number: how PostgreSQL's `integer`, `bigint` and
`timestamptz` cells of this model read back (`none` for anything else, including a sign). -/
def parseNat? (s : String) : Option Nat :=
  if !s.toList.isEmpty && s.toList.all Char.isDigit then some (Nat.ofDigitChars 10 s.toList 0)
  else none

/-- A cell read as a natural number (`none` for `NULL` or for text that is not one). -/
def natCell? (r : Row) (c : String) : Option Nat := (r.get c).bind parseNat?

/-- `x >= y` for two timestamp cells, passing when either is `NULL`. -/
def notBefore (r : Row) (later earlier : String) : Bool :=
  match r.get later, r.get earlier with
  | some _, some _ =>
    match natCell? r later, natCell? r earlier with
    | some a, some b => b ≤ a
    | _, _ => false
  | _, _ => true

/-- The counters are non-negative integers and the cost a non-negative decimal
(`*_counters_non_negative`); a `NULL` operand passes. -/
def countersNonNegative (r : Row) : Bool :=
  counterColumns.all (fun c => (r.get c).all fun v => (parseNat? v).isSome) &&
    (r.get "cost_usd").all isNonNegDecimal

/-- The semantics of each check of the work tables that is not a closed set, by constraint name,
reading a row under SQL's three-valued logic: a comparison with a `NULL` operand is `NULL`, and a
check passes unless it is `false`. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs")
  (ts := "packages/core/src/db/schema/projects.ts#projects")
  (ts := "packages/core/src/db/schema/run-tokens.ts#runTokens")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")
  (ts := "packages/core/src/db/schema/run-feedback.ts#runFeedback")
  (ts := "packages/core/src/db/schema/audit-events.ts#auditEvents")]
def workCheck : String → Option (Row → Bool)
  | "projects_name_not_blank" => some fun r => (r.get "name").all hasNonSpace
  | "projects_default_model_pair" => some fun r =>
    (r.get "default_model_connection_id").isNone == (r.get "default_model").isNone
  | "runs_ended_at_iff_terminal" => some fun r =>
    (r.get "status").all fun s => terminalWires.contains s == (r.get "ended_at").isSome
  | "runs_ended_after_started" => some fun r => notBefore r "ended_at" "started_at"
  | "runs_counters_non_negative" => some countersNonNegative
  | "runs_cost_currency_usd" => some fun r => (r.get "cost_currency").all (· == "USD")
  | "runs_price_version_matches_accounting_state" => some fun r =>
    (r.get "accounting_state").all fun a =>
      pricedWires.contains a == (r.get "price_table_version").isSome
  | "runs_unpriced_cost_zero" => some fun r =>
    match r.get "accounting_state", r.get "cost_usd" with
    | some a, some c => pricedWires.contains a || isZeroDecimal c
    | some _, none => true
    | none, _ => true
  -- `char_length` counts code points, as `String.length` does.
  | "run_feedback_comment_length" => some fun r => (r.get "comment").all (·.length ≤ 1000)
  | "run_tokens_expiry_after_created" => some fun r =>
    match r.get "expires_at", r.get "created_at" with
    | some _, some _ =>
      match natCell? r "expires_at", natCell? r "created_at" with
      | some e, some c => c < e
      | _, _ => false
    | _, _ => true
  | "run_tokens_revoked_after_created" => some fun r => notBefore r "revoked_at" "created_at"
  | "run_usage_records_counters_non_negative" => some countersNonNegative
  | "run_usage_records_currency_usd" => some fun r => (r.get "cost_currency").all (· == "USD")
  | "audit_events_actor_label_not_blank" => some fun r => (r.get "actor_label").all hasNonSpace
  | "audit_events_subject_label_not_blank" => some fun r =>
    (r.get "subject_label").all hasNonSpace
  | "audit_events_subject_id_shape" => some fun r => (r.get "subject_id").all Uuid.isCanonical
  | _ => none

/-- A check of a work table holds on a row: its semantics, or vacuously for a check this module
does not refine (there is none; `every_work_check_is_refined` states so). -/
def workCheckHolds (n : String) (r : Row) : Bool :=
  match workCheck n with
  | some f => f r
  | none => true

/-- The exact bodies `drizzle-kit` rendered for the work tables' other checks (compared with
the latest snapshot (`Er.Snapshot.file`) by the conformance suite, which is a snapshot that
carries the three session-state tables this cluster gained in 0026). -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def workCheckSql : List (String × String) :=
  [("projects_name_not_blank", "length(btrim(\"projects\".\"name\")) > 0"),
    ("projects_default_model_pair",
      "(\"projects\".\"default_model_connection_id\" is null) = (\"projects\".\"default_model\" is null)"),
    ("runs_ended_at_iff_terminal",
      "(\"runs\".\"status\" in ('completed', 'failed', 'cancelled')) = (\"runs\".\"ended_at\" is not null)"),
    ("runs_ended_after_started",
      "\"runs\".\"ended_at\" is null or \"runs\".\"started_at\" is null or \"runs\".\"ended_at\" >= \"runs\".\"started_at\""),
    ("runs_counters_non_negative",
      "\"runs\".\"input_tokens\" >= 0 and \"runs\".\"output_tokens\" >= 0 and \"runs\".\"cache_read_input_tokens\" >= 0 and \"runs\".\"cache_creation_input_tokens\" >= 0 and \"runs\".\"tool_calls\" >= 0 and \"runs\".\"cost_usd\" >= 0"),
    ("runs_cost_currency_usd", "\"runs\".\"cost_currency\" = 'USD'"),
    ("runs_price_version_matches_accounting_state",
      "(\"runs\".\"accounting_state\" in ('complete', 'partial')) = (\"runs\".\"price_table_version\" is not null)"),
    ("runs_unpriced_cost_zero",
      "\"runs\".\"accounting_state\" in ('complete', 'partial') or \"runs\".\"cost_usd\" = 0"),
    ("run_feedback_comment_length",
      "\"run_feedback\".\"comment\" is null or char_length(\"run_feedback\".\"comment\") <= 1000"),
    ("run_tokens_expiry_after_created",
      "\"run_tokens\".\"expires_at\" > \"run_tokens\".\"created_at\""),
    ("run_tokens_revoked_after_created",
      "\"run_tokens\".\"revoked_at\" is null or \"run_tokens\".\"revoked_at\" >= \"run_tokens\".\"created_at\""),
    ("run_usage_records_counters_non_negative",
      "\"run_usage_records\".\"input_tokens\" >= 0 and \"run_usage_records\".\"output_tokens\" >= 0 and \"run_usage_records\".\"cache_read_input_tokens\" >= 0 and \"run_usage_records\".\"cache_creation_input_tokens\" >= 0 and \"run_usage_records\".\"tool_calls\" >= 0 and \"run_usage_records\".\"cost_usd\" >= 0"),
    ("run_usage_records_currency_usd", "\"run_usage_records\".\"cost_currency\" = 'USD'"),
    ("audit_events_actor_label_not_blank", "length(btrim(\"audit_events\".\"actor_label\")) > 0"),
    ("audit_events_subject_label_not_blank",
      "length(btrim(\"audit_events\".\"subject_label\")) > 0"),
    ("audit_events_subject_id_shape",
      "\"audit_events\".\"subject_id\" is null or \"audit_events\".\"subject_id\" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'")]

/-- The names of the other checks of table `t`. -/
def otherChecks (t : TableName) : List String :=
  (catalogue t).checks.filterMap fun
    | .other n => some n
    | .oneOf .. => none

/-- Every refined check of every work table holds on every row of the state. -/
def workChecksHold (st : State) : Bool :=
  workTables.all fun t => (otherChecks t).all fun n => (st t).all (workCheckHolds n)

/-- The states the database can hold, as far as the work cluster can tell: every constraint of
`Er.Core` holds, and so does every refined check of the work tables. -/
@[aw_spec (ts := "packages/core/src/db/schema/index.ts")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
def workConsistent (st : State) : Bool := consistent catalogue st && workChecksHold st

/-! ## Relationships -/

/-- The foreign key named `n` of table `t` (the default key if there is none, which
`every_work_fk_is_declared` rules out for the names used). -/
def workFk (t : TableName) (n : String) : ForeignKey := ((catalogue t).foreignKey? n).getD default

/-- How many parent rows a child row links through a foreign key. -/
@[aw_spec (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
inductive Cardinality where
  /-- Every key column is `NOT NULL`: every child row has exactly one parent (`||` in the ER
  diagram). -/
  | exactlyOne
  /-- Some key column is nullable: a child row has one parent or none (`o|`). -/
  | atMostOne
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling, for vectors. -/
def Cardinality.toWire : Cardinality → String
  | .exactlyOne => "exactly-one"
  | .atMostOne => "at-most-one"

instance : WireEnum Cardinality where
  all := [.exactlyOne, .atMostOne]
  toWire := Cardinality.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

/-- The cardinality a foreign key imposes on its child rows. -/
@[aw_spec (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
def fkCardinality (S : Schema) (t : TableName) (fk : ForeignKey) : Cardinality :=
  if fk.columns.all (S t).isNotNull then .exactlyOne else .atMostOne

/-- Every foreign key of the work tables, as `(table, key)`. -/
def workForeignKeys : List (TableName × ForeignKey) :=
  workTables.flatMap fun t => (catalogue t).foreignKeys.map (t, ·)

end AgentWorkspace.Er.Current.Work
