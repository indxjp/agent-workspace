import AgentWorkspace.Theorems.Invariants.ConceptWork
import Vectors.Common

/-!
Vectors for the `concept-work` family: the work cluster's enumerations, foreign keys and their
cardinality and tenancy, the refined checks (their SQL and, where TypeScript has the predicate,
their verdicts), the transcript key grammar and tenant session scope, the owner fields of the
resources, the run store's status-and-timestamp behaviour, and the session launch identity.

`tests/formal/concept-work.test.ts` replays the schema, contract and core-package vectors;
`apps/web/formal/concept-work.test.ts` replays the run store, `renderRun` and session-launch
vectors against the web application's own modules.
-/

namespace Vectors.ConceptWork

open Lean AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Work
open AgentWorkspace.Contracts AgentWorkspace.Lifecycle
open AgentWorkspace.Concepts.Project AgentWorkspace.Concepts.Session AgentWorkspace.Concepts.Run
open AgentWorkspace.Concepts.RunEvent AgentWorkspace.Concepts.Usage
open AgentWorkspace.Theorems.Invariants.ConceptWork

private def wf : String := "AgentWorkspace.Theorems.WellFormed.ConceptWork."
private def nm : String := "AgentWorkspace.Theorems.Normative.ConceptWork."
private def inv : String := "AgentWorkspace.Theorems.Invariants.ConceptWork."
private def mt : String := "AgentWorkspace.Theorems.Meta.ConceptWork."

def strs (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

def optNat : Option Nat → Json
  | some n => Json.num n
  | none => Json.null

/-! ## Enumerations -/

/-- Spellings no enumeration of the cluster admits. -/
def invalidSpellings : List String :=
  ["", "Active", "PRIVATE", " private", "public ", "canceled", "completed ", "priced", "api_key",
    "user_created", "project-archive", "anthropic_compatible", "OpenAI", "none", "null"]

def enumVectors {α : Type} [WireEnum α] (name : String) (witnesses : List String) : List Vector :=
  let members := WireEnum.wires α
  ({ id := s!"enum/{name}/members", input := Json.mkObj [("enum", name)],
     expected := Json.mkObj [("members", strs members)], witnesses } : Vector) ::
    (members ++ invalidSpellings.filter (!members.contains ·)).map fun v =>
      { id := s!"enum/{name}/{(Json.str v).compress}",
        input := Json.mkObj [("enum", name), ("value", v)],
        expected := Json.mkObj [("valid", members.contains v)], witnesses }

def enumsFile : List Vector :=
  enumVectors (α := ProjectVisibility) "project-visibility"
      [wf ++ "project_visibility_is_the_visibility_check"] ++
    enumVectors (α := ProjectListFilter) "project-list-filter"
      [nm ++ "project_list_filters_partition"] ++
    enumVectors (α := SessionStatus) "session-status" [wf ++ "session_status_is_the_status_check"] ++
    enumVectors (α := ModelProvider) "model-provider"
      [wf ++ "model_provider_is_the_provider_check", mt ++ "usage_record_provider_is_open_text"] ++
    enumVectors (α := AccountingState) "accounting-state"
      [wf ++ "accounting_state_is_the_accounting_check", nm ++ "only_complete_is_settled"] ++
    enumVectors (α := AuditAction) "audit-action" [wf ++ "audit_action_is_the_action_check"] ++
    [{ id := "enum/terminal-run-status/members", input := Json.mkObj [("enum", "terminal-run-status")],
       expected := Json.mkObj [("members", strs terminalWires)],
       witnesses := [wf ++ "check_value_lists_match_the_concepts"] }]

/-! ## Foreign keys -/

def cardinalitySuffix : Cardinality → String
  | .exactlyOne => "exactly_one"
  | .atMostOne => "at_most_one"

def fkVector (t : TableName) (fk : ForeignKey) : Vector :=
  let card := fkCardinality catalogue t fk
  let tenant := ((catalogue fk.refTable).tenantColumn?).isSome
  { id := s!"fk/{TableName.toWire t}/{fk.name}",
    input := Json.mkObj [("table", TableName.toWire t), ("name", fk.name)],
    expected := Json.mkObj [("columns", strs fk.columns),
      ("refTable", TableName.toWire fk.refTable), ("refColumns", strs fk.refColumns),
      ("cardinality", WireEnum.toWire card), ("tenantPreserving", tenant)],
    witnesses := [wf ++ s!"{fk.name}_is_{cardinalitySuffix card}",
        nm ++ s!"{fk.name}_links_{if card == .exactlyOne then "exactly_one" else "at_most_one"}_parent",
        wf ++ "work_foreign_key_counts"] ++
      (if tenant then [inv ++ s!"{fk.name}_preserves_tenant"] else []) }

def foreignKeysFile : List Vector :=
  { id := "fk/tables", input := Json.mkObj [],
    expected := Json.mkObj [("tables", strs (workTables.map TableName.toWire)),
      ("count", Json.num workForeignKeys.length)],
    witnesses := [wf ++ "work_foreign_key_counts", wf ++ "work_constraints_are_satisfiable"] } ::
    workForeignKeys.map fun p => fkVector p.1 p.2

/-! ## Checks -/

def checksFile : List Vector :=
  (workTables.map fun t =>
    ({ id := s!"checks/{TableName.toWire t}", input := Json.mkObj [("table", TableName.toWire t)],
       expected := Json.mkObj [("otherChecks", strs (otherChecks t))],
       witnesses := [wf ++ "every_work_check_is_refined", wf ++ "work_check_counts"] } : Vector)) ++
  workCheckSql.map fun (n, sql) =>
    { id := s!"check/{n}", input := Json.mkObj [("name", n)],
      expected := Json.mkObj [("sql", sql)],
      witnesses := [wf ++ "every_work_check_is_refined", wf ++ "work_check_counts"] }

/-- A `runs` row with the given status and, optionally, an end time. -/
def runRow (status : String) (ended : Bool) : Row :=
  ⟨[("status", status)] ++ (if ended then [("ended_at", "5")] else [])⟩

def subjectIds : List (Option String) :=
  [none, some "0f8fad5b-d9cb-469f-a165-70867728950e", some "0F8FAD5B-D9CB-469F-A165-70867728950E",
    some "0f8fad5bd9cb469fa16570867728950e", some "0f8fad5b-d9cb-469f-a165-70867728950",
    some "0f8fad5b-d9cb-469f-a165-70867728950e0", some "gf8fad5b-d9cb-469f-a165-70867728950e",
    some "{0f8fad5b-d9cb-469f-a165-70867728950e}", some "", some "agent-1",
    some "0f8fad5b_d9cb_469f_a165_70867728950e"]

def checkRowsFile : List Vector :=
  ((WireEnum.all : List RunStatus).flatMap fun s => ([true, false] : List Bool).map fun (ended : Bool) =>
    ({ id := s!"row/runs_ended_at_iff_terminal/{WireEnum.toWire s}/{ended}",
       input := Json.mkObj [("check", "runs_ended_at_iff_terminal"),
         ("status", WireEnum.toWire s), ("endedAt", Json.bool ended)],
       expected := Json.mkObj [("holds",
         workCheckHolds "runs_ended_at_iff_terminal" (runRow (WireEnum.toWire s) ended))],
       witnesses := [nm ++ "run_row_has_ended_at_iff_terminal",
         wf ++ "run_invariants_are_the_row_checks"] } : Vector)) ++
  subjectIds.map fun v =>
    let row : Row := ⟨match v with | some x => [("subject_id", x)] | none => []⟩
    { id := s!"row/audit_events_subject_id_shape/{(match v with | some x => Json.str x | none => Json.null).compress}",
      input := Json.mkObj [("check", "audit_events_subject_id_shape"),
        ("subjectId", match v with | some x => Json.str x | none => Json.null)],
      expected := Json.mkObj [("holds", workCheckHolds "audit_events_subject_id_shape" row)],
      witnesses := [nm ++ "audit_row_invariants", wf ++ "audit_invariants_are_the_row_checks"] }

/-! ## Transcript keys and the tenant session scope -/

def uuidSamples : List String :=
  ["0f8fad5b-d9cb-469f-a165-70867728950e", "00000000-0000-0000-0000-000000000000",
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "7c9e6679-7425-40de-944b-e07fc1f90ae7"]

def projectKeys : List String :=
  uuidSamples ++
    ["", "a", "w1_x-Y", String.ofList (List.replicate 64 'k'), String.ofList (List.replicate 65 'k'),
      "con", "CON", "Com1", "lpt9", "lpt", "com10", "nul", "aux", "prn", "has space", "a/b", "a.b",
      "shared-cwd", "ünï", "-", "_"]

/-- Configuration directories, with the Unicode blanks `String.prototype.trim` strips (U+3000,
U+2028, U+2029, U+205F, U+1680, U+2000, U+200A, U+202F, U+00A0, U+FEFF) and two characters it
does not (U+200B, U+180E). -/
def configDirs : List String :=
  ["/var/lib/aw", "", "   ", "\t", "\n", " /x ", "\u3000", "\u2028", "\u2029", "\u205F",
    "\u1680", "\u2000", "\u200A", "\u202F", "\u00A0", "\uFEFF", "\u000B\u000C\r",
    "\u3000/var/lib/aw\u2028", "\u200B", "\u180E"]

def transcriptKeysFile : List Vector :=
  (projectKeys.map fun k =>
    ({ id := s!"project-key/{(Json.str k).compress}", input := Json.mkObj [("projectKey", k)],
       expected := Json.mkObj [("pattern", isProjectKey k), ("device", isWindowsDeviceName k),
         ("scopeOk", tenantScopeOk k "/var/lib/aw"), ("uuid", Uuid.isCanonical k)],
       witnesses := [nm ++ "workspace_id_is_a_safe_project_key",
         nm ++ "tenant_scope_accepts_a_workspace_key"] } : Vector)) ++
  (configDirs.map fun d =>
    ({ id := s!"config-dir/{(Json.str d).compress}", input := Json.mkObj [("configDir", d)],
       expected := Json.mkObj [("scopeOk", tenantScopeOk uuidSamples.head! d)],
       witnesses := [nm ++ "tenant_scope_accepts_a_workspace_key",
         nm ++ "tenant_scope_refuses_unsafe_keys", nm ++ "tenant_scope_refusals"] } : Vector)) ++
  (["", "subagents/agent-1", "a", "/a", "a/", "a//b", "_a", "-a", "a_b-c/D9", "a b", "a.b",
      String.ofList (List.replicate 128 'a'), String.ofList (List.replicate 129 'a'),
      "subagents/" ++ String.ofList (List.replicate 118 'x'),
      "subagents/" ++ String.ofList (List.replicate 119 'x')].map fun s =>
    { id := s!"subpath/{(Json.str s).compress}", input := Json.mkObj [("subpath", s)],
      expected := Json.mkObj [("valid", isWireSubpath s), ("main", s == mainSubpath)],
      witnesses := [nm ++ "main_transcript_has_no_wire_subpath"] })

/-! ## Event names -/

/-- Names around `EVENT_NAME_PATTERN`'s edges, and every listed frame name. -/
def eventNames : List String :=
  controlFrameNames ++ runStatusEvent :: relayedEventNames ++
    ["a", "Z", "a" ++ String.ofList (List.replicate 62 'x'),
      "a" ++ String.ofList (List.replicate 63 'x'), "a" ++ String.ofList (List.replicate 64 'x'),
      "a" ++ String.ofList (List.replicate 63 '9'), "Z.b_c-9", "run.status.v2", "", "1abc",
      "_abc", "-abc", ".abc", "a b", "a:b", "a\n", "é", "aé", "a/b", "a+b", "A-", "a..b"]

def eventNamesFile : List Vector :=
  eventNames.map fun n =>
    { id := s!"event-name/{(Json.str n).compress}", input := Json.mkObj [("name", n)],
      expected := Json.mkObj [("valid", isEventName n), ("length", Json.num n.length)],
      witnesses := [nm ++ "event_name_pattern_edges", nm ++ "listed_frame_names_are_well_formed"] }

/-! ## Owner fields on the wire -/

def ownerFieldsFile : List Vector :=
  [("ProjectResourceSchema", true), ("SessionResourceSchema", true), ("RunResourceSchema", false)].map
    fun (schema, present) =>
      { id := s!"owner-field/{schema}", input := Json.mkObj [("schema", schema),
          ("field", "ownerPrincipalId")],
        expected := Json.mkObj [("present", present)],
        witnesses := [mt ++ "runs_carry_no_owner_principal",
          nm ++ "run_reaches_exactly_one_owner"] }

/-! ## The run store -/

def opJson : RunOp × Nat → Json
  | (.markRunning, t) => Json.mkObj [("op", "markRunning"), ("at", t)]
  | (.finish s, t) => Json.mkObj [("op", "finish"), ("target", WireEnum.toJsonValue s), ("at", t)]

def allOps : List RunOp := .markRunning :: (WireEnum.all : List RunStatus).map .finish

/-- Every sequence of at most two store operations, at instants 101 and 102. -/
def opSequences : List (List (RunOp × Nat)) :=
  [] :: (allOps.map fun a => [(a, 101)]) ++
    allOps.flatMap fun a => allOps.map fun b => [(a, 101), (b, 102)]

def runJson (r : Run) : Json :=
  Json.mkObj [("status", WireEnum.toJsonValue r.status), ("startedAt", optNat r.startedAt),
    ("endedAt", optNat r.endedAt), ("durationMs", optNat r.durationMs),
    ("totalTokens", Json.num r.counters.totalTokens), ("costUsd", r.costUsd),
    ("accountingState", WireEnum.toJsonValue r.accountingState),
    ("wellFormed", r.wellFormed)]

def runStoreFile : List Vector :=
  opSequences.map fun ops =>
    let r := timedSteps (Run.create ⟨"run-1"⟩ ⟨"workspace-1"⟩ ⟨"session-1"⟩ 100) ops
    { id := s!"store/{(Json.arr (ops.map opJson).toArray).compress}",
      input := Json.mkObj [("createdAt", Json.num 100), ("operations", Json.arr (ops.map opJson).toArray)],
      expected := runJson r,
      witnesses := [inv ++ "store_operations_preserve_run_checks",
        inv ++ "store_stamps_follow_the_status", inv ++ "store_durations_are_exact",
        inv ++ "finished_run_has_a_duration", nm ++ "new_run_is_queued_unpriced_and_well_formed",
        nm ++ "duration_needs_both_timestamps"] }

/-- Usage counters and timestamps a stored run may carry, and what `renderRun` derives. -/
def renderSamples : List (Counters × Option Nat × Option Nat) :=
  [(⟨0, 0, 0, 0, 0⟩, none, none), (⟨10, 20, 3, 4, 2⟩, some 1000, none),
    (⟨10, 20, 3, 4, 2⟩, some 1000, some 3500), (⟨1, 0, 0, 0, 9⟩, none, some 5),
    (⟨100000, 250000, 7, 0, 0⟩, some 0, some 0)]

def renderFile : List Vector :=
  renderSamples.map fun (c, s, e) =>
    let r := { Run.create ⟨"run-1"⟩ ⟨"workspace-1"⟩ ⟨"session-1"⟩ 0 with
      counters := c, startedAt := s, endedAt := e }
    { id := s!"render/{c.inputTokens}-{c.outputTokens}-{c.cacheReadInputTokens}-{c.cacheCreationInputTokens}-{c.toolCalls}/{(optNat s).compress}/{(optNat e).compress}",
      input := Json.mkObj [("inputTokens", c.inputTokens), ("outputTokens", c.outputTokens),
        ("cacheReadInputTokens", c.cacheReadInputTokens),
        ("cacheCreationInputTokens", c.cacheCreationInputTokens), ("toolCalls", c.toolCalls),
        ("startedAt", optNat s), ("endedAt", optNat e)],
      expected := Json.mkObj [("totalTokens", c.totalTokens), ("toolCalls", c.toolCalls),
        ("durationMs", optNat r.durationMs)],
      witnesses := [nm ++ "total_tokens_is_the_sum_of_four_counters",
        nm ++ "duration_needs_both_timestamps"] }

/-! ## Session launch identity -/

def sessionFile : List Vector :=
  let base : Session :=
    { id := ⟨"0f8fad5b-d9cb-469f-a165-70867728950e"⟩, workspace := ⟨"workspace-1"⟩, user := none,
      ownerPrincipal := ⟨"principal-1"⟩, agent := ⟨"agent-1"⟩, project := none,
      engineSessionId := none, engine := none, agentVersion := none, title := none,
      status := .active,
      createdAt := 0, updatedAt := 0 }
  let launch := [none, some base.id.val].map fun c =>
    let s := { base with engineSessionId := c,
                         engine := c.map (fun _ => Contracts.Engines.EngineId.claudeAgentSdk) }
    ({ id := s!"launch/{(match c with | some x => Json.str x | none => Json.null).compress}",
       input := Json.mkObj [("kind", "launch"), ("id", s.id.val), ("agentId", s.agent.val),
         ("engineSessionId", match c with | some x => Json.str x | none => Json.null)],
       expected := Json.mkObj [("mode", match s.launchMode with | .fresh => "fresh" | .resume => "resume")],
       witnesses := [nm ++ "resumable_means_active_and_reported"] } : Vector)
  let record := [base.id.val, "7c9e6679-7425-40de-944b-e07fc1f90ae7", ""].map fun reported =>
    ({ id := s!"record/{(Json.str reported).compress}",
       input := Json.mkObj [("kind", "record"), ("id", base.id.val), ("agentId", base.agent.val),
         ("reported", reported)],
       expected := Json.mkObj [("recorded", (base.recordReported reported).isSome),
         ("engineSessionId", match base.recordReported reported with
           | some s => match s.engineSessionId with | some x => Json.str x | none => Json.null
           | none => Json.null),
         ("engine", match base.recordReported reported with
           | some s => match s.engine with
             | some e => Json.str (WireEnum.toWire e)
             | none => Json.null
           | none => Json.null)],
       witnesses := [nm ++ "reported_identity_must_be_the_platform_id",
         inv ++ "recording_keeps_the_session_identity"] } : Vector)
  launch ++ record

def files : List (String × Json) :=
  [("enums.json", file "concept-work"
      "The work cluster's enumerations, in order, with near-miss spellings" enumsFile),
   ("foreign-keys.json", file "concept-work"
      "Every foreign key of the nine work tables: target, cardinality, tenancy" foreignKeysFile),
   ("checks.json", file "concept-work"
      "The refined checks of the work tables and their exact SQL" checksFile),
   ("check-rows.json", file "concept-work"
      "Row verdicts of the checks TypeScript has a predicate for" checkRowsFile),
   ("transcript-keys.json", file "concept-work"
      "Transcript project keys, config directories and subpaths" transcriptKeysFile),
   ("event-names.json", file "concept-work"
      "EVENT_NAME_PATTERN on its edges and every listed frame name" eventNamesFile),
   ("owner-fields.json", file "concept-work"
      "Which resources carry ownerPrincipalId on the wire" ownerFieldsFile),
   ("run-store.json", file "concept-work"
      "Every sequence of at most two run-store operations with a clock" runStoreFile),
   ("run-render.json", file "concept-work"
      "renderRun's derived totalTokens and durationMs" renderFile),
   ("session-launch.json", file "concept-work"
      "Session launch mode and reported SDK identity" sessionFile)]

end Vectors.ConceptWork
