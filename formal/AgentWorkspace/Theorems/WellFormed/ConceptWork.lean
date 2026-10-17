import AgentWorkspace.Er.Current.Work
import AgentWorkspace.Theorems.Invariants.ErCore
import Std.Data.String.ToNat

/-!
T0 — the work cluster's definitions are coherent.

* **Enumerations are the database's closed sets.** Each concept enumeration lists exactly the
  values, in the same order, that the matching `CHECK … IN (…)` of the catalogue inlines, so a
  wire member the database would refuse (or the reverse) fails a theorem by name.
* **Every other check has a meaning.** `workCheck` refines each of the 15 checks of the work
  tables that `Er.Core` records by name only, and `workCheckSql` names exactly those 15.
* **Every foreign key is declared, with its cardinality.** `aw_work_fk_cardinality_theorems`
  generates one theorem per foreign key of the twelve tables stating that the key exists and
  whether a child row links exactly one parent or at most one.
* **Concept rows fit their tables.** Every concept value encodes to a row that fills every
  `NOT NULL` column, names only columns of its table and passes the closed-set checks, and the
  concept's invariants are *exactly* the row checks of its table (the `…_are_the_row_checks`
  theorems), so the concept layer and the database cannot drift apart silently.
* **The constraints are satisfiable.** `work_constraints_are_satisfiable` exhibits a state that is
  consistent under every constraint of the catalogue and every refined check, with a row in
  every work table and every foreign key of the cluster in use; it witnesses the hypotheses of
  the T1, T2 and T5 theorems of this family.
-/

namespace AgentWorkspace.Theorems.WellFormed.ConceptWork

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Work AgentWorkspace.Contracts
open AgentWorkspace.Concepts.Project AgentWorkspace.Concepts.Session AgentWorkspace.Concepts.Run
open AgentWorkspace.Concepts.RunEvent AgentWorkspace.Concepts.Usage

/-! ## Enumerations and the closed-set checks -/

/-- The project visibilities are exactly `projects_visibility_valid`'s values, in order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/projects.ts#PROJECT_VISIBILITIES")
  (ts := "packages/core/src/db/schema/projects.ts#projectVisibilities")]
theorem project_visibility_is_the_visibility_check :
    (catalogue .projects).oneOfCheck? "projects_visibility_valid" =
      some ("visibility", WireEnum.wires ProjectVisibility) := by decide

/-- The session statuses are exactly `sessions_status_valid`'s values, in order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/sessions.ts#SESSION_STATUSES")
  (ts := "packages/core/src/db/schema/sessions.ts#sessionStatuses")]
theorem session_status_is_the_status_check :
    (catalogue .sessions).oneOfCheck? "sessions_status_valid" =
      some ("status", WireEnum.wires SessionStatus) := by decide

/-- The run statuses of the contract are exactly `runs_status_valid`'s values, in order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#RUN_STATUSES")
  (ts := "packages/core/src/db/schema/runs.ts#runStatuses")]
theorem run_status_is_the_status_check :
    (catalogue .runs).oneOfCheck? "runs_status_valid" = some ("status", WireEnum.wires RunStatus) := by
  decide

/-- The model providers are exactly `runs_provider_valid`'s values, in order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#MODEL_PROVIDERS")
  (ts := "packages/core/src/db/schema/model-connections.ts#modelProviders")]
theorem model_provider_is_the_provider_check :
    (catalogue .runs).oneOfCheck? "runs_provider_valid" =
      some ("provider", WireEnum.wires ModelProvider) := by decide

/-- The accounting states are exactly `runs_accounting_state_valid`'s values, in order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/runs.ts#ACCOUNTING_STATES")
  (ts := "packages/core/src/db/schema/runs.ts#accountingStates")]
theorem accounting_state_is_the_accounting_check :
    (catalogue .runs).oneOfCheck? "runs_accounting_state_valid" =
      some ("accounting_state", WireEnum.wires AccountingState) := by decide

/-- The audit actions are exactly `audit_events_action_valid`'s values, in order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/observability.ts#AUDIT_ACTIONS")
  (ts := "packages/core/src/db/schema/audit-events.ts#auditActions")]
theorem audit_action_is_the_action_check :
    (catalogue .auditEvents).oneOfCheck? "audit_events_action_valid" =
      some ("action", WireEnum.wires AuditAction) := by decide

/-- The terminal statuses inlined into `runs_ended_at_iff_terminal` are the contract's terminal
statuses, and the priced accounting states are exactly those `isPriced` names. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/runs.ts#terminalRunStatuses")
  (ts := "packages/contracts/src/runs.ts#TERMINAL_RUN_STATUSES")]
theorem check_value_lists_match_the_concepts :
    terminalWires = ((WireEnum.all : List RunStatus).filter RunStatus.isTerminal).map WireEnum.toWire ∧
      pricedWires =
        ((WireEnum.all : List AccountingState).filter AccountingState.isPriced).map WireEnum.toWire := by
  decide

/-! ## Every check of the work tables is refined -/

/-- Every check of a work table that is not a closed set has semantics in `workCheck`, and
`workCheckSql` names exactly those checks, table by table, in declaration order. -/
@[aw_spec (tier := T0)
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/runs.ts#runs")]
theorem every_work_check_is_refined :
    (workTables.all fun t => (otherChecks t).all fun n => (workCheck n).isSome) ∧
      workCheckSql.map Prod.fst = workTables.flatMap otherChecks := by
  decide

/-- The work tables carry 16 checks that are not closed sets and 13 closed-set checks. -/
@[aw_spec (tier := T0)
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/one-of.ts#oneOf")]
theorem work_check_counts :
    (workTables.flatMap otherChecks).length = 16 ∧
      (workTables.flatMap fun t => (catalogue t).checks).length = 29 := by
  decide

/-! ## Foreign keys and their cardinality (generated) -/

section Generator

open Lean Elab Command

/-- A `/-- … -/` docstring node for generated declarations. -/
private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

/-- The constructor name of a table, from its SQL name (`run_events` → `runEvents`). -/
private def ctorName (sql : String) : Name :=
  match sql.splitOn "_" with
  | [] => .anonymous
  | w :: ws => Name.mkSimple (w ++ String.join (ws.map String.capitalize))

private def cardinalitySuffix : Cardinality → String
  | .exactlyOne => "exactly_one"
  | .atMostOne => "at_most_one"

private def cardinalitySentence : Cardinality → String
  | .exactlyOne => "every key column is `NOT NULL`, so every child row links exactly one parent"
  | .atMostOne => "a key column is nullable, so a child row links at most one parent"

private def cardinalityTerm : Cardinality → Name
  | .exactlyOne => ``Cardinality.exactlyOne
  | .atMostOne => ``Cardinality.atMostOne

/-- One T0 theorem per foreign key of the work tables: it is declared, and its cardinality. -/
elab "aw_work_fk_cardinality_theorems" : command => do
  for (t, fk) in workForeignKeys do
    let s := catalogue t
    let sql := TableName.toWire t
    let tIdent := mkIdent (``TableName ++ ctorName sql)
    let card := fkCardinality catalogue t fk
    let fkTs := Syntax.mkStrLit ("packages/core/src/db/schema/" ++ s.source ++ "#" ++
      (if fk.inline then s.tsExport else fk.name))
    let thm := mkIdent (Name.mkSimple s!"{fk.name}_is_{cardinalitySuffix card}")
    let doc := mkDocComment s!"`{fk.name}` of `{sql}` references `{TableName.toWire fk.refTable}`, \
      and {cardinalitySentence card}."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T0))
        (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
        (ts := $fkTs)]
      theorem $thm :
          ((catalogue $tIdent).foreignKey? $(Syntax.mkStrLit fk.name)).map
              (fun fk => (fk.refTable, fkCardinality catalogue $tIdent fk)) =
            some ($(mkIdent (``TableName ++ ctorName (TableName.toWire fk.refTable))),
              $(mkIdent (cardinalityTerm card))) := by decide))

end Generator

aw_work_fk_cardinality_theorems

/-- The work tables declare 41 foreign keys: 29 whose every column is `NOT NULL` and 12 with a
nullable column. -/
@[aw_spec (tier := T0)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem work_foreign_key_counts :
    workForeignKeys.length = 41 ∧
      (workForeignKeys.filter fun p => fkCardinality catalogue p.1 p.2 == .exactlyOne).length = 29 := by
  decide

/-! ## Concept rows -/

private theorem lookup_none {β : Type} :
    ∀ (l : List (String × β)) (k : String), k ∉ l.map Prod.fst → l.lookup k = none
  | [], _, _ => rfl
  | (a, _) :: rest, k, h => by
    simp only [List.map_cons, List.mem_cons, not_or] at h
    simp only [List.lookup_cons]
    have : (k == a) = false := by simpa using h.1
    rw [this]
    exact lookup_none rest k h.2

private theorem get_ofCells :
    ∀ (l : List (String × Option String)) (c : String),
      (l.map Prod.fst).Nodup → (ofCells l).get c = (l.lookup c).bind id
  | [], _, _ => rfl
  | (k, v) :: rest, c, hnd => by
    have hnd' : (rest.map Prod.fst).Nodup := (List.nodup_cons.mp hnd).2
    have hk : k ∉ rest.map Prod.fst := (List.nodup_cons.mp hnd).1
    have ih := get_ofCells rest c hnd'
    by_cases hc : c = k
    · subst hc
      have hl := lookup_none rest c hk
      cases v with
      | none =>
        simp only [ofCells, List.filterMap_cons, Option.map_none] at ih ⊢
        rw [ih, hl]; simp
      | some w => simp [ofCells, Row.get]
    · have hne : (c == k) = false := by simpa using hc
      cases v with
      | none =>
        simp only [ofCells, List.filterMap_cons, Option.map_none] at ih ⊢
        rw [ih]; simp [List.lookup_cons, hne]
      | some w =>
        simp only [ofCells, List.filterMap_cons, Option.map_some] at ih ⊢
        simp only [Row.get, List.lookup_cons, hne] at ih ⊢
        exact ih

private theorem parse_repr (n : Nat) : parseNat? (Nat.repr n) = some n := by
  have hl : (Nat.repr n).toList = Nat.toDigits 10 n := by simp [Nat.repr_eq_ofList_toDigits]
  have hsome := String.toNat?_eq_some_ofDigitChars (Nat.isNat_repr n)
  rw [Nat.toNat?_repr, hl] at hsome
  have hfilter : (Nat.toDigits 10 n).filter (· != '_') = Nat.toDigits 10 n := by
    apply List.filter_eq_self.mpr
    intro c hc
    have : c ≠ '_' := fun h => Nat.underscore_not_in_toDigits (h ▸ hc)
    simpa using this
  rw [hfilter] at hsome
  have hne : (Nat.toDigits 10 n).isEmpty = false := by
    cases h : Nat.toDigits 10 n with
    | nil =>
      have := Nat.isNat_repr n
      rw [String.isNat_iff] at this
      exact absurd (by simp [← String.toList_eq_nil_iff, hl, h]) this.1
    | cons _ _ => rfl
  have hall : (Nat.toDigits 10 n).all Char.isDigit = true :=
    List.all_eq_true.mpr fun c hc => Nat.isDigit_of_mem_toDigits (by decide) (by decide) hc
  simp only [parseNat?, hl, hne, hall, Bool.not_false, Bool.and_self, ite_true]
  exact congrArg some (Option.some.inj hsome).symm

/-- A timestamp or counter cell reads back as the number it was written from: the decimal
rendering the concept rows use and the parser the row checks use are inverse. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/runs.ts#runs_ended_after_started")
  (ts := "packages/core/src/db/schema/runs.ts#runs_counters_non_negative")]
theorem instant_round_trips (n : Nat) : parseNat? (instant n) = some n := parse_repr n

/-- A row fits table `t`: it fills every `NOT NULL` column, passes every check `Er.Core` gives
semantics to (the closed sets), and names only columns of the table. -/
def rowFits (t : TableName) (cells : List (String × Option String)) : Bool :=
  (catalogue t).columns.all (notNullHolds [ofCells cells]) &&
    (catalogue t).checks.all (checkHolds [ofCells cells]) &&
    cells.all fun c => (catalogue t).hasColumn c.1

/-! ### Projects -/

private theorem project_nd (p : Project) : ((projectCells p).map Prod.fst).Nodup := by
  simp only [projectCells, List.map_cons, List.map_nil]; decide

private theorem project_get (p : Project) (c : String) :
    (ofCells (projectCells p)).get c = ((projectCells p).lookup c).bind id :=
  get_ofCells _ c (project_nd p)

/-- Every project encodes to a row that fits `projects`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/projects.ts#projects")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem project_row_fits (p : Project) : rowFits .projects (projectCells p) = true := by
  simp only [rowFits, catalogue, List.all_cons, List.all_nil, notNullHolds, checkHolds,
    project_get, otherCheckHolds]
  simp [projectCells, List.lookup_cons, TableSpec.hasColumn]
  all_goals (cases p.visibility <;> simp [WireEnum.toWire, ProjectVisibility.toWire])

/-- The project invariants are exactly the row checks of `projects`: a project is well formed if
and only if its row passes `projects_name_not_blank` and `projects_default_model_pair`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/projects.ts#projects_name_not_blank")
  (ts := "packages/core/src/db/schema/projects.ts#projects_default_model_pair")]
theorem project_invariants_are_the_row_checks (p : Project) :
    ((otherChecks .projects).all fun n => workCheckHolds n (ofCells (projectCells p))) =
      p.wellFormed := by
  have h1 : (ofCells (projectCells p)).get "name" = some p.name := by rw [project_get]; rfl
  have h2 : (ofCells (projectCells p)).get "default_model_connection_id" =
      p.defaultModelConnection.map (·.val) := by rw [project_get]; rfl
  have h3 : (ofCells (projectCells p)).get "default_model" = p.defaultModel := by
    rw [project_get]; simp [projectCells, List.lookup_cons]
  simp only [otherChecks, catalogue, List.filterMap_cons, List.filterMap_nil, List.all_cons,
    List.all_nil, workCheckHolds, workCheck, h1, h2, h3, Option.all_some, Option.isNone_map,
    Bool.and_true, Project.wellFormed, Project.nameNotBlank, Project.defaultModelPair]

/-! ### Sessions, transcripts and messages -/

private theorem session_nd (s : Session) : ((sessionCells s).map Prod.fst).Nodup := by
  simp only [sessionCells, List.map_cons, List.map_nil]; decide

/-- Every session encodes to a row that fits `sessions`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/sessions.ts#sessions")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem session_row_fits (s : Session) : rowFits .sessions (sessionCells s) = true := by
  have g := fun c => get_ofCells (sessionCells s) c (session_nd s)
  simp only [rowFits, catalogue, List.all_cons, List.all_nil, notNullHolds, checkHolds, g]
  simp [sessionCells, List.lookup_cons, TableSpec.hasColumn]
  -- `sessions_engine_valid` admits exactly `EngineId`'s spellings, so a typed engine (or none)
  -- always renders a permitted value.
  all_goals (cases s.status <;> rcases s.engine with _ | _ | _ | _ | _ <;>
    simp [WireEnum.toWire, SessionStatus.toWire, Engines.EngineId.toWire])

private theorem transcript_nd (t : Transcript) : ((transcriptCells t).map Prod.fst).Nodup := by
  simp only [transcriptCells, List.map_cons, List.map_nil]; decide

/-- Every transcript encodes to a row that fits `session_transcripts`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/session-transcripts.ts#sessionTranscripts")]
theorem transcript_row_fits (t : Transcript) :
    rowFits .sessionTranscripts (transcriptCells t) = true := by
  have g := fun c => get_ofCells (transcriptCells t) c (transcript_nd t)
  simp only [rowFits, catalogue, List.all_cons, List.all_nil, notNullHolds, g]
  simp [transcriptCells, List.lookup_cons, TableSpec.hasColumn]

private theorem message_nd (m : TranscriptMessage) : ((messageCells m).map Prod.fst).Nodup := by
  simp only [messageCells, List.map_cons, List.map_nil]; decide

/-- Every transcript message encodes to a row that fits `session_messages`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/session-messages.ts#sessionMessages")]
theorem message_row_fits (m : TranscriptMessage) :
    rowFits .sessionMessages (messageCells m) = true := by
  have g := fun c => get_ofCells (messageCells m) c (message_nd m)
  simp only [rowFits, catalogue, List.all_cons, List.all_nil, notNullHolds, g]
  simp [messageCells, List.lookup_cons, TableSpec.hasColumn]

/-! ### Runs, events, tokens and usage records -/

private theorem run_nd (r : Run) : ((runCells r).map Prod.fst).Nodup := by
  simp only [runCells, List.map_cons, List.map_nil]; decide

private theorem run_get (r : Run) (c : String) :
    (ofCells (runCells r)).get c = ((runCells r).lookup c).bind id :=
  get_ofCells _ c (run_nd r)

/-- Every run encodes to a row that fits `runs` (including the three closed-set checks). -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/runs.ts#runs")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem run_row_fits (r : Run) : rowFits .runs (runCells r) = true := by
  simp only [rowFits, catalogue, List.all_cons, List.all_nil, notNullHolds, checkHolds, run_get,
    otherCheckHolds]
  simp [runCells, List.lookup_cons, TableSpec.hasColumn]
  all_goals (repeat' apply And.intro)
  all_goals first
    | (cases r.status <;> simp [WireEnum.toWire, RunStatus.toWire]; done)
    | (cases r.accountingState <;> simp [WireEnum.toWire, AccountingState.toWire]; done)
    | (rcases r.provider with _ | ⟨_ | _ | _ | _ | _⟩ <;>
        simp [WireEnum.toWire, ModelProvider.toWire]; done)

private theorem run_ended_check (r : Run) :
    workCheckHolds "runs_ended_at_iff_terminal" (ofCells (runCells r)) = r.endedAtIffTerminal := by
  have h1 : (ofCells (runCells r)).get "status" = some (WireEnum.toWire r.status) := by
    rw [run_get]; rfl
  have h2 : (ofCells (runCells r)).get "ended_at" = r.endedAt.map instant := by rw [run_get]; rfl
  simp only [workCheckHolds, workCheck, h1, h2, Option.all_some, Run.endedAtIffTerminal,
    Option.isSome_map]
  cases r.status <;> rfl

private theorem run_after_check (r : Run) :
    workCheckHolds "runs_ended_after_started" (ofCells (runCells r)) = r.endedAfterStarted := by
  have h1 : (ofCells (runCells r)).get "started_at" = r.startedAt.map instant := by
    rw [run_get]; rfl
  have h2 : (ofCells (runCells r)).get "ended_at" = r.endedAt.map instant := by rw [run_get]; rfl
  simp only [workCheckHolds, workCheck, notBefore, natCell?, h1, h2, Run.endedAfterStarted]
  cases r.startedAt <;> cases r.endedAt <;> simp [instant_round_trips]

private theorem run_counters_check (r : Run) :
    workCheckHolds "runs_counters_non_negative" (ofCells (runCells r)) = r.costNonNegative := by
  have h1 : (ofCells (runCells r)).get "input_tokens" = some (toString r.counters.inputTokens) := by
    rw [run_get]; rfl
  have h2 : (ofCells (runCells r)).get "output_tokens" =
      some (toString r.counters.outputTokens) := by rw [run_get]; rfl
  have h3 : (ofCells (runCells r)).get "cache_read_input_tokens" =
      some (toString r.counters.cacheReadInputTokens) := by rw [run_get]; rfl
  have h4 : (ofCells (runCells r)).get "cache_creation_input_tokens" =
      some (toString r.counters.cacheCreationInputTokens) := by rw [run_get]; rfl
  have h5 : (ofCells (runCells r)).get "tool_calls" = some (toString r.counters.toolCalls) := by
    rw [run_get]; rfl
  have h6 : (ofCells (runCells r)).get "cost_usd" = some r.costUsd := by rw [run_get]; rfl
  simp [workCheckHolds, workCheck, countersNonNegative, counterColumns, h1, h2, h3, h4, h5, h6,
    parse_repr, Run.costNonNegative]

private theorem run_currency_check (r : Run) :
    workCheckHolds "runs_cost_currency_usd" (ofCells (runCells r)) = r.currencyUsd := by
  have h : (ofCells (runCells r)).get "cost_currency" = some r.costCurrency := by rw [run_get]; rfl
  simp [workCheckHolds, workCheck, h, Run.currencyUsd, settlementCurrency]

private theorem run_price_check (r : Run) :
    workCheckHolds "runs_price_version_matches_accounting_state" (ofCells (runCells r)) =
      r.priceVersionMatches := by
  have h1 : (ofCells (runCells r)).get "accounting_state" =
      some (WireEnum.toWire r.accountingState) := by rw [run_get]; rfl
  have h2 : (ofCells (runCells r)).get "price_table_version" = r.priceTableVersion := by
    rw [run_get]; simp [runCells, List.lookup_cons]
  simp only [workCheckHolds, workCheck, h1, h2, Option.all_some, Run.priceVersionMatches]
  cases r.accountingState <;> rfl

private theorem run_unpriced_check (r : Run) :
    workCheckHolds "runs_unpriced_cost_zero" (ofCells (runCells r)) = r.unpricedCostZero := by
  have h1 : (ofCells (runCells r)).get "accounting_state" =
      some (WireEnum.toWire r.accountingState) := by rw [run_get]; rfl
  have h2 : (ofCells (runCells r)).get "cost_usd" = some r.costUsd := by rw [run_get]; rfl
  simp only [workCheckHolds, workCheck, h1, h2, Run.unpricedCostZero]
  cases r.accountingState <;> rfl

/-- The run invariants are exactly the six row checks of `runs` that are not closed sets: a run
is well formed if and only if its row passes all of them. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/runs.ts#runs_ended_at_iff_terminal")
  (ts := "packages/core/src/db/schema/runs.ts#runs_price_version_matches_accounting_state")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem run_invariants_are_the_row_checks (r : Run) :
    ((otherChecks .runs).all fun n => workCheckHolds n (ofCells (runCells r))) = r.wellFormed := by
  simp only [otherChecks, catalogue, List.filterMap_cons, List.filterMap_nil, List.all_cons,
    List.all_nil, Bool.and_true, run_ended_check, run_after_check, run_counters_check,
    run_currency_check, run_price_check, run_unpriced_check, Run.wellFormed, Bool.and_assoc]

private theorem event_nd (e : RunEvent) : ((runEventCells e).map Prod.fst).Nodup := by
  simp only [runEventCells, List.map_cons, List.map_nil]; decide

/-- Every run event encodes to a row that fits `run_events`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/run-events.ts#runEvents")]
theorem run_event_row_fits (e : RunEvent) : rowFits .runEvents (runEventCells e) = true := by
  have g := fun c => get_ofCells (runEventCells e) c (event_nd e)
  simp only [rowFits, catalogue, List.all_cons, List.all_nil, notNullHolds, g]
  simp [runEventCells, List.lookup_cons, TableSpec.hasColumn]

private theorem token_nd (t : RunToken) : ((runTokenCells t).map Prod.fst).Nodup := by
  simp only [runTokenCells, List.map_cons, List.map_nil]; decide

/-- Every run token encodes to a row that fits `run_tokens`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/run-tokens.ts#runTokens")]
theorem run_token_row_fits (t : RunToken) : rowFits .runTokens (runTokenCells t) = true := by
  have g := fun c => get_ofCells (runTokenCells t) c (token_nd t)
  simp only [rowFits, catalogue, List.all_cons, List.all_nil, notNullHolds, checkHolds,
    otherCheckHolds, g]
  simp [runTokenCells, List.lookup_cons, TableSpec.hasColumn]

/-- The run-token invariants are exactly the row checks of `run_tokens`: expiry after creation,
and a revocation, if any, not before creation. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/run-tokens.ts#run_tokens_expiry_after_created")
  (ts := "packages/core/src/db/schema/run-tokens.ts#run_tokens_revoked_after_created")]
theorem run_token_invariants_are_the_row_checks (t : RunToken) :
    ((otherChecks .runTokens).all fun n => workCheckHolds n (ofCells (runTokenCells t))) =
      t.wellFormed := by
  have g := fun c => get_ofCells (runTokenCells t) c (token_nd t)
  have h1 : (ofCells (runTokenCells t)).get "expires_at" = some (instant t.expiresAt) := by
    rw [g]; rfl
  have h2 : (ofCells (runTokenCells t)).get "created_at" = some (instant t.createdAt) := by
    rw [g]; rfl
  have h3 : (ofCells (runTokenCells t)).get "revoked_at" = t.revokedAt.map instant := by
    rw [g]; rfl
  simp only [otherChecks, catalogue, List.filterMap_cons, List.filterMap_nil, List.all_cons,
    List.all_nil, Bool.and_true, workCheckHolds, workCheck, notBefore, natCell?, h1, h2, h3,
    RunToken.wellFormed, RunToken.expiryAfterCreated, RunToken.revokedAfterCreated]
  cases t.revokedAt <;> simp [instant_round_trips]

private theorem usage_nd (u : UsageRecord) : ((usageCells u).map Prod.fst).Nodup := by
  simp only [usageCells, List.map_cons, List.map_nil]; decide

/-- Every usage record encodes to a row that fits `run_usage_records`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")]
theorem usage_row_fits (u : UsageRecord) : rowFits .runUsageRecords (usageCells u) = true := by
  have g := fun c => get_ofCells (usageCells u) c (usage_nd u)
  simp only [rowFits, catalogue, List.all_cons, List.all_nil, notNullHolds, checkHolds,
    otherCheckHolds, g]
  simp only [usageCells, List.lookup_cons, TableSpec.hasColumn]
  -- The closed set `run_usage_records_wire_protocol_known` gates is exactly `WireProtocol`'s
  -- spellings, so the typed column can only ever render a permitted value.
  cases u.wireProtocol <;> simp [WireEnum.toWire, WireProtocol.toWire]

/-- The usage-record invariants are exactly the row checks of `run_usage_records`. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_counters_non_negative")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_currency_usd")]
theorem usage_invariants_are_the_row_checks (u : UsageRecord) :
    ((otherChecks .runUsageRecords).all fun n => workCheckHolds n (ofCells (usageCells u))) =
      u.wellFormed := by
  have g := fun c => get_ofCells (usageCells u) c (usage_nd u)
  simp only [otherChecks, catalogue, List.filterMap_cons, List.filterMap_nil, List.all_cons,
    List.all_nil, Bool.and_true, workCheckHolds, workCheck, countersNonNegative, counterColumns, g]
  simp [usageCells, List.lookup_cons, parse_repr, UsageRecord.wellFormed, settlementCurrency]

/-! ### Audit events -/

private theorem audit_nd (e : AuditEvent) : ((auditCells e).map Prod.fst).Nodup := by
  simp only [auditCells, List.map_cons, List.map_nil]; decide

/-- Every audit event encodes to a row that fits `audit_events`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/audit-events.ts#auditEvents")]
theorem audit_row_fits (e : AuditEvent) : rowFits .auditEvents (auditCells e) = true := by
  have g := fun c => get_ofCells (auditCells e) c (audit_nd e)
  simp only [rowFits, catalogue, List.all_cons, List.all_nil, notNullHolds, checkHolds, g,
    otherCheckHolds]
  simp [auditCells, List.lookup_cons, TableSpec.hasColumn]
  all_goals (cases e.action <;> simp [WireEnum.toWire, AuditAction.toWire])

/-- The audit-event invariants are exactly the row checks of `audit_events`: two non-blank labels,
and a recorded subject id in the canonical UUID shape. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/audit-events.ts#audit_events_subject_id_shape")
  (ts := "packages/core/src/db/schema/audit-events.ts#audit_events_actor_label_not_blank")]
theorem audit_invariants_are_the_row_checks (e : AuditEvent) :
    ((otherChecks .auditEvents).all fun n => workCheckHolds n (ofCells (auditCells e))) =
      e.wellFormed := by
  have g := fun c => get_ofCells (auditCells e) c (audit_nd e)
  have h1 : (ofCells (auditCells e)).get "actor_label" = some e.actorLabel := by rw [g]; rfl
  have h2 : (ofCells (auditCells e)).get "subject_label" = some e.subjectLabel := by rw [g]; rfl
  have h3 : (ofCells (auditCells e)).get "subject_id" = e.subjectId := by
    rw [g]; simp [auditCells, List.lookup_cons]
  simp only [otherChecks, catalogue, List.filterMap_cons, List.filterMap_nil, List.all_cons,
    List.all_nil, Bool.and_true, workCheckHolds, workCheck, h1, h2, h3, Option.all_some,
    AuditEvent.wellFormed, Bool.and_assoc]

/-! ## The constraints are satisfiable -/

namespace Witness

/-- A project of workspace `w1` with every optional reference set. -/
def project : Project :=
  { id := ⟨"pr1"⟩, workspace := ⟨"w1"⟩, name := "Launch", instructions := some "Be brief.",
    defaultAgent := some ⟨"a1"⟩, visibility := .workspace,
    defaultModelConnection := some ⟨"c1"⟩, defaultModel := some "claude",
    createdBy := some ⟨"u1"⟩, ownerPrincipal := ⟨"p1"⟩, archivedAt := none, createdAt := 1,
    updatedAt := 1 }

/-- A session of the project whose SDK id has been reported (and equals its platform id). -/
def session : Session :=
  { id := ⟨"s1"⟩, workspace := ⟨"w1"⟩, user := some ⟨"u1"⟩, ownerPrincipal := ⟨"p1"⟩,
    agent := ⟨"a1"⟩, project := some ⟨"pr1"⟩, engineSessionId := some "s1",
    engine := some .claudeAgentSdk, agentVersion := some ⟨"av1"⟩,
    title := some "Hello", status := .active, createdAt := 2, updatedAt := 2 }

/-- The session's main transcript, under its workspace's own key. -/
def transcript : Transcript :=
  { key := ⟨⟨"w1"⟩, "w1", ⟨"s1"⟩, mainSubpath⟩, createdAt := 3, updatedAt := 3 }

/-- One delivered transcript entry. -/
def message : TranscriptMessage :=
  { key := ⟨transcript.key, 1⟩, position := 1, entryUuid := some "e1", entry := "{}",
    createdAt := 3 }

/-- A completed, fully priced run of the session. -/
def run : Run :=
  { Run.create ⟨"r1"⟩ ⟨"w1"⟩ ⟨"s1"⟩ 4 with
    status := .completed, model := some "claude", provider := some .anthropic,
    modelConnection := some ⟨"c1"⟩, startedAt := some 5, endedAt := some 9,
    counters := ⟨10, 20, 0, 0, 1⟩, costUsd := "0.001000", priceTableVersion := some "2026-09",
    accountingState := .complete }

/-- A queued run of the same session, as a store creates it. -/
def queuedRun : Run := Run.create ⟨"r2"⟩ ⟨"w1"⟩ ⟨"s1"⟩ 6

/-- The completed run's first durable event. -/
def event : RunEvent :=
  { key := ⟨⟨"r1"⟩, 1⟩, workspace := ⟨"w1"⟩, type := runStatusEvent,
    data := "{\"status\":\"running\",\"error\":null}", createdAt := 5 }

/-- A revoked gateway token of the completed run. -/
def token : RunToken :=
  { id := ⟨"t1"⟩, run := ⟨"r1"⟩, workspace := ⟨"w1"⟩, tokenHash := "h1", expiresAt := 100,
    revokedAt := some 9, createdAt := 4 }

/-- The completed run's single, priced ledger row. -/
def usage : UsageRecord :=
  { id := ⟨"ur1"⟩, workspace := ⟨"w1"⟩, run := ⟨"r1"⟩, providerResponseId := "msg_1",
    provider := "anthropic", model := "claude", counters := ⟨10, 20, 0, 0, 1⟩,
    wireProtocol := .anthropicMessages,
    costUsd := "0.001000", costCurrency := settlementCurrency,
    priceTableVersion := some "2026-09", createdAt := 8 }

/-- An audit row recording the project's creation. -/
def audit : AuditEvent :=
  { id := ⟨"ae1"⟩, workspace := ⟨"w1"⟩, actorUser := some ⟨"u1"⟩,
    actorPrincipal := some ⟨"p1"⟩, actorLabel := "Ito", action := .projectCreated,
    subjectId := some "0f8fad5b-d9cb-469f-a165-70867728950e", subjectLabel := "Launch",
    createdAt := 1 }

/-- The session's one engine session state stream: the Claude adapter's `stream_key` for the
witness transcript, which is its `project_key` and `subpath` joined by `/`. -/
def stateStreamCells : List (String × Option String) :=
  [("workspace_id", some "w1"), ("session_id", some "s1"),
   ("engine", some "claude-agent-sdk"), ("stream_key", some "w1/"),
   ("created_at", some (instant 3)), ("updated_at", some (instant 3))]

/-- One entry of that stream, carrying an idempotency key. -/
def stateEntryCells : List (String × Option String) :=
  [("workspace_id", some "w1"), ("session_id", some "s1"),
   ("engine", some "claude-agent-sdk"), ("stream_key", some "w1/"), ("sequence", some "1"),
   ("entry_key", some "e1"), ("entry", some "{}"), ("created_at", some (instant 3))]

/-- One blob snapshot of the same session's engine state. -/
def stateBlobCells : List (String × Option String) :=
  [("workspace_id", some "w1"), ("session_id", some "s1"),
   ("engine", some "claude-agent-sdk"), ("blob_key", some "state.tar"),
   ("storage_key", some "session-state/s1/claude-agent-sdk/state.tar"),
   ("size_bytes", some "3"), ("sha256", some "ab12"),
   ("created_at", some (instant 3)), ("updated_at", some (instant 3))]

/-- The `er-core` witness (two workspaces, a member, a principal, a connection, an agent) with a
row in every work table. -/
def state : State
  | .projects => [ofCells (projectCells project)]
  | .sessions => [ofCells (sessionCells session)]
  | .sessionTranscripts => [ofCells (transcriptCells transcript)]
  | .sessionMessages => [ofCells (messageCells message)]
  -- ENG-06's engine-scoped store, on the same session: one stream under the Claude adapter's
  -- `projectKey + '/' + subpath` key, one entry in it, and one blob snapshot beside it.
  | .sessionStateStreams => [ofCells stateStreamCells]
  | .sessionStateEntries => [ofCells stateEntryCells]
  | .sessionStateBlobs => [ofCells stateBlobCells]
  | .runs => [ofCells (runCells run), ofCells (runCells queuedRun)]
  | .runEvents => [ofCells (runEventCells event)]
  -- A thumbs up, with a comment, on the completed run's answer.
  | .runFeedback =>
    [ofCells [("id", some "f1"), ("workspace_id", some "w1"), ("run_id", some "r1"),
      ("rating", some "up"), ("comment", some "Clear answer"), ("created_at", some (instant 9))]]
  | .runTokens => [ofCells (runTokenCells token)]
  | .runUsageRecords => [ofCells (usageCells usage)]
  | .auditEvents => [ofCells (auditCells audit)]
  -- The resume key of the session, issued for its agent by a surface named `main`.
  | .surfaceSessionKeys =>
    [ofCells [("session_id", some "s1"), ("workspace_id", some "w1"), ("surface_name", some "main"),
      ("agent_id", some "a1"), ("key_hash", some "h1"), ("created_at", some (instant 3))]]
  -- The agent version the session is pinned to (issue #612), so `sessions_agent_version_fk` has
  -- a parent.
  | .agentVersions =>
    [ofCells [("id", some "av1"), ("workspace_id", some "w1"), ("agent_id", some "a1"),
      ("number", some "1"), ("summary", some "First version"), ("via", some "ui"),
      ("body", some "{}"), ("created_by_principal_id", some "p1"), ("created_at", some (instant 1))]]
  | t => AgentWorkspace.Theorems.Invariants.ErCore.Witness.state t

/-- Some row of `t` references a parent through `fk` in `st`. -/
def refersSome (st : State) (t : TableName) (fk : ForeignKey) : Bool :=
  (st t).any fun r =>
    r.present fk.columns && (st fk.refTable).any fun r' => r'.project fk.refColumns == r.project fk.columns

end Witness

/-- The work constraints are jointly satisfiable, and not only by an empty database: the witness
state is consistent under every constraint of the catalogue and every refined check, has a row in
every work table, and uses every one of the cluster's 41 foreign keys. -/
@[aw_spec (tier := T0)
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem work_constraints_are_satisfiable :
    workConsistent Witness.state = true ∧ (workTables.all fun t => !(Witness.state t).isEmpty) ∧
      workForeignKeys.all (fun p => Witness.refersSome Witness.state p.1 p.2) = true := by
  decide +kernel

/-! ## Decimal text and transcript keys, on their edge cases -/

/-- The decimal reading of `numeric(14, 6)` text agrees with PostgreSQL on the cases the `runs`
and `run_usage_records` checks turn on: every spelling of zero is zero and `≥ 0`, a nonzero amount
is not zero, a negative nonzero amount is a decimal but not `≥ 0`, a positive amount is `≥ 0`, and
text that is not a rendered `numeric` (an exponent, a bare or doubled sign, a missing digit on
either side of the point, a `+`, a space) is not a decimal at all. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/runs.ts#runs_unpriced_cost_zero")
  (ts := "packages/core/src/db/schema/runs.ts#runs_counters_non_negative")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_counters_non_negative")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
theorem decimal_text_edge_cases :
    (["0", "0.000000", "-0.0", "000.000", "-0"].all fun s => isZeroDecimal s && isNonNegDecimal s)
        = true ∧
      (["0.001000", "1", "10", "-0.000001", "100.000000", "0.000001"].all
        fun s => isDecimal s && !isZeroDecimal s) = true ∧
      (["-1", "-0.5", "-0.000001", "-12345678.123456"].all
        fun s => isDecimal s && !isNonNegDecimal s) = true ∧
      (["0.5", "0.001000", "12345678.123456", "7"].all isNonNegDecimal) = true ∧
      (["1e3", "", "-", ".5", "1.", "--1", "+1", "1.2.3", "0x10", " 1", "1 ", "-.5", "NaN"].all
        fun s => !isDecimal s && !isZeroDecimal s && !isNonNegDecimal s) = true := by
  decide

/-- `PROJECT_KEY_PATTERN`'s bounds are exact: 64 key characters pass and 65 do not, the empty key
does not, and neither does a key with a character outside `[A-Za-z0-9_-]`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/sessions.ts#PROJECT_KEY_PATTERN")
  (ts := "packages/core/src/schemas.ts#SDK_PROJECT_DIR_NAME")]
theorem project_key_edge_cases :
    isProjectKey (String.ofList (List.replicate 64 'a')) = true ∧
      isProjectKey (String.ofList (List.replicate 65 'a')) = false ∧
      isProjectKey "" = false ∧ isProjectKey "a/b" = false ∧ isProjectKey "a.b" = false ∧
      isProjectKey "A-z_09" = true := by
  decide

/-- `SDK_WINDOWS_DEVICE_NAME` matches the reserved names in any case and nothing longer or
shorter: `con`, `PRN`, `Aux`, `nul`, `com0`…`COM9`, `lpt0`…`LPT9`, but not `con1`, `com10`,
`coms` or `co`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/schemas.ts#SDK_WINDOWS_DEVICE_NAME")]
theorem windows_device_name_edge_cases :
    (["con", "PRN", "Aux", "nul", "com0", "COM9", "lpt1", "LPT9", "cOm5"].all isWindowsDeviceName)
        = true ∧
      (["con1", "com10", "coms", "co", "", "lpt", "console", "nul_"].all
        (!isWindowsDeviceName ·)) = true := by
  decide

/-! ## The model's counter fold -/

private theorem sum_from (acc : Counters) : ∀ cs : List Counters,
    cs.foldl Counters.add acc =
      ⟨acc.inputTokens + (cs.map (·.inputTokens)).sum,
        acc.outputTokens + (cs.map (·.outputTokens)).sum,
        acc.cacheReadInputTokens + (cs.map (·.cacheReadInputTokens)).sum,
        acc.cacheCreationInputTokens + (cs.map (·.cacheCreationInputTokens)).sum,
        acc.toolCalls + (cs.map (·.toolCalls)).sum⟩
  | [] => by simp
  | c :: cs => by
    rw [List.foldl_cons, sum_from (acc.add c) cs]
    simp only [Counters.add, List.map_cons, List.sum_cons, Counters.mk.injEq]
    omega

/-- The model's `Counters.sum` (a fold of `Counters.add` from zero) is the counter-by-counter
sum, tool calls included, as `recordUsage` adds each counter to the run's own column; it is a
coherence lemma about the model's fold, not a model of settlement (de-duplication by
`providerResponseId` is Phase-4 settlement). -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
theorem counters_sum_is_componentwise (cs : List Counters) :
    Counters.sum cs =
      ⟨(cs.map (·.inputTokens)).sum, (cs.map (·.outputTokens)).sum,
        (cs.map (·.cacheReadInputTokens)).sum, (cs.map (·.cacheCreationInputTokens)).sum,
        (cs.map (·.toolCalls)).sum⟩ := by
  rw [Counters.sum, sum_from]
  simp only [Counters.zero, Nat.zero_add]

/-- Two counter sets: `⟨1, 2, 3, 4, 5⟩` then `⟨10, 20, 30, 40, 50⟩` sum to 55 tool calls. -/
example : (Counters.sum [⟨1, 2, 3, 4, 5⟩, ⟨10, 20, 30, 40, 50⟩]).toolCalls = 55 := by
  rw [counters_sum_is_componentwise]; rfl

end AgentWorkspace.Theorems.WellFormed.ConceptWork
