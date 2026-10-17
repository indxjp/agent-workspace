import AgentWorkspace.Theorems.Invariants.ConceptWork

/-!
T1 — documented sentences about projects, sessions, runs, run events and usage.

* **Cardinalities, one per foreign key.** `aw_work_cardinality_theorems` generates, for every
  foreign key of the nine work tables, the theorem that in every consistent state a child row
  links exactly one parent (all key columns `NOT NULL`: "every run belongs to exactly one
  session", every session has exactly one agent and one owning principal, every event, token and
  ledger row belongs to exactly one run, …) or, when its key is set, exactly one parent (a
  session's project, a project's default agent, …).
* **Composed relationships.** A run reaches exactly one agent and exactly one owning principal,
  both through its session, and the concept join (`Run.agentVia`, `Run.ownerVia`) needs the
  session's id and workspace both to match and agrees with the row reference; a session's legacy
  user is a member of the session's workspace.
* **Row checks.** In every `workConsistent` state every run, token, usage, project and audit row
  satisfies the refined checks (T1 readings of the checks, stated as the schema's sentences).
* **Runs and usage.** Status and accounting are independent; a new run is queued, unpriced and
  well formed; unpriced usage costs zero and carries no price table version; `totalTokens` is the
  sum of four counters; `durationMs` exists only once both timestamps do; the ledger's
  accounting state.
* **Sessions and transcripts.** Resumability, launch mode and the reported SDK identity; the main
  transcript's empty subpath is not a wire subpath; a workspace id is always a valid transcript
  project key and passes the tenant session scope.
* **Run events.** Control frames are never durable, and the listed frame names are well formed
  and belong to exactly one kind; `EVENT_NAME_PATTERN` on its edges; a run's stored log is
  contiguous per run.
-/

namespace AgentWorkspace.Theorems.Normative.ConceptWork

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Work AgentWorkspace.Contracts
open AgentWorkspace.Concepts.Project AgentWorkspace.Concepts.Session AgentWorkspace.Concepts.Run
open AgentWorkspace.Concepts.RunEvent AgentWorkspace.Concepts.Usage
open AgentWorkspace.Theorems.WellFormed.ConceptWork AgentWorkspace.Theorems.Invariants.ConceptWork

/-! ## Cardinalities (generated) -/

section Generator

open Lean Elab Command

private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

private def ctorName (sql : String) : Name :=
  match sql.splitOn "_" with
  | [] => .anonymous
  | w :: ws => Name.mkSimple (w ++ String.join (ws.map String.capitalize))

/-- The document sentence a key's cardinality states, where one names it; otherwise the ER
diagram. -/
private def cardinalityDoc (fk : String) : String :=
  if fk == "runs_session_workspace_fk" then
    "docs/sdk/site/concepts/run-lifecycle.mdx#sessions-group-runs"
  else if ["sessions_agent_workspace_fk", "sessions_project_workspace_fk",
      "sessions_owner_principal_workspace_fk", "projects_owner_principal_workspace_fk",
      "run_events_run_workspace_fk", "audit_events_actor_principal_workspace_fk",
      "projects_default_agent_workspace_fk"].contains fk then
    "docs/sdk/04-api-specification.md#2-resource-model"
  else if fk == "sessions_member_workspace_fk" then
    "docs/formal/inventory.md#4-tenant-isolation-predicates"
  else "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces"

/-- One T1 theorem per foreign key of the work tables. -/
elab "aw_work_cardinality_theorems" : command => do
  for (t, fk) in workForeignKeys do
    let s := catalogue t
    let sql := TableName.toWire t
    let ref := TableName.toWire fk.refTable
    let tIdent := mkIdent (``TableName ++ ctorName sql)
    let fkTs := Syntax.mkStrLit ("packages/core/src/db/schema/" ++ s.source ++ "#" ++
      (if fk.inline then s.tsExport else fk.name))
    let docLit := Syntax.mkStrLit (cardinalityDoc fk.name)
    let n := Syntax.mkStrLit fk.name
    match fkCardinality catalogue t fk with
    | .exactlyOne =>
      let thm := mkIdent (Name.mkSimple s!"{fk.name}_links_exactly_one_parent")
      let doc := mkDocComment s!"In every consistent state, every `{sql}` row references exactly \
        one `{ref}` row through `{fk.name}`."
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T1)) (doc := $docLit) (ts := $fkTs)]
        theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : consistent catalogue st = true)
            {r : AgentWorkspace.Er.Core.Row} (hr : r ∈ st $tIdent) :
            (∃ r', References catalogue st $tIdent (workFk $tIdent $n) r r') ∧
              ∀ r1 r2, References catalogue st $tIdent (workFk $tIdent $n) r r1 →
                References catalogue st $tIdent (workFk $tIdent $n) r r2 → r1 = r2 :=
          ⟨required_reference_has_a_target catalogue st hc (by decide) (by decide) hr,
            fun _ _ h1 h2 => reference_has_one_target catalogue st hc (by decide) h1 h2⟩))
    | .atMostOne =>
      let thm := mkIdent (Name.mkSimple s!"{fk.name}_links_at_most_one_parent")
      let doc := mkDocComment s!"In every consistent state, a `{sql}` row references at most one \
        `{ref}` row through `{fk.name}`, and exactly one when the key's columns are set."
      elabCommand (← `(command|
        $doc:docComment
        @[aw_spec (tier := $(mkIdent `T1)) (doc := $docLit) (ts := $fkTs)]
        theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : consistent catalogue st = true)
            {r : AgentWorkspace.Er.Core.Row} (hr : r ∈ st $tIdent)
            (hset : r.present (workFk $tIdent $n).columns = true) :
            (∃ r', References catalogue st $tIdent (workFk $tIdent $n) r r') ∧
              ∀ r1 r2, References catalogue st $tIdent (workFk $tIdent $n) r r1 →
                References catalogue st $tIdent (workFk $tIdent $n) r r2 → r1 = r2 :=
          ⟨set_reference_has_a_target catalogue st hc (by decide) hr hset,
            fun _ _ h1 h2 => reference_has_one_target catalogue st hc (by decide) h1 h2⟩))

end Generator

aw_work_cardinality_theorems

/-! ## Composed relationships -/

/-- A run reaches exactly one agent, through its session: `Run(… → Session, → Agent …)`, with no
`agent_id` of its own ("the run reaches its agent through `session_id`. One join, no way to be
wrong"). -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/runs.ts#runs")]
theorem run_reaches_exactly_one_agent (st : State) (hc : consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .runs) :
    ∃ s a, References catalogue st .runs (workFk .runs "runs_session_workspace_fk") r s ∧
      References catalogue st .sessions (workFk .sessions "sessions_agent_workspace_fk") s a ∧
      ∀ s' a', References catalogue st .runs (workFk .runs "runs_session_workspace_fk") r s' →
        References catalogue st .sessions (workFk .sessions "sessions_agent_workspace_fk") s' a' →
        s' = s ∧ a' = a := by
  obtain ⟨⟨s, hs⟩, hsu⟩ := runs_session_workspace_fk_links_exactly_one_parent st hc hr
  have hsmem : s ∈ st .sessions := hs.2.2.1
  obtain ⟨⟨a, ha⟩, hau⟩ := sessions_agent_workspace_fk_links_exactly_one_parent st hc hsmem
  refine ⟨s, a, hs, ha, fun s' a' hs' ha' => ?_⟩
  have hss : s' = s := hsu s' s hs' hs
  subst hss
  exact ⟨rfl, hau a' a ha' ha⟩

/-- A run reaches exactly one owning principal, through its session: `runs` carries no
`owner_principal_id`, and a run is "own" or "other" by its session's owner. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "apps/web/server/runs/store.ts#ownerPrincipalId")]
theorem run_reaches_exactly_one_owner (st : State) (hc : consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .runs) :
    ∃ s p, References catalogue st .runs (workFk .runs "runs_session_workspace_fk") r s ∧
      References catalogue st .sessions
        (workFk .sessions "sessions_owner_principal_workspace_fk") s p ∧
      ∀ s' p', References catalogue st .runs (workFk .runs "runs_session_workspace_fk") r s' →
        References catalogue st .sessions
          (workFk .sessions "sessions_owner_principal_workspace_fk") s' p' → s' = s ∧ p' = p := by
  obtain ⟨⟨s, hs⟩, hsu⟩ := runs_session_workspace_fk_links_exactly_one_parent st hc hr
  obtain ⟨⟨p, hp⟩, hpu⟩ :=
    sessions_owner_principal_workspace_fk_links_exactly_one_parent st hc hs.2.2.1
  refine ⟨s, p, hs, hp, fun s' p' hs' hp' => ?_⟩
  have hss : s' = s := hsu s' s hs' hs
  subst hss
  exact ⟨rfl, hpu p' p hp' hp⟩

/-- A run reaches an agent through a session exactly when that session is the run's own session
in the run's own workspace, and the agent is then the session's; the owning principal likewise.
A session with the run's session id in another workspace yields nothing: the concept join is
the composite `(workspace_id, session_id)` key, never the bare id. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/runs.ts#runs")
  (ts := "apps/web/server/runs/store.ts#ownerPrincipalId")]
theorem run_reaches_agent_and_owner_only_through_its_own_session (r : Run) (s : Session) :
    (∀ a, r.agentVia s = some a ↔ s.id = r.session ∧ s.workspace = r.workspace ∧ a = s.agent) ∧
      (∀ p, r.ownerVia s = some p ↔
        s.id = r.session ∧ s.workspace = r.workspace ∧ p = s.ownerPrincipal) := by
  refine ⟨fun a => ?_, fun p => ?_⟩
  · unfold Run.agentVia
    split
    · rename_i h; simp only [Option.some.injEq]; exact ⟨fun e => ⟨h.1, h.2, e.symm⟩, fun e => e.2.2.symm⟩
    · rename_i h; simp only [reduceCtorEq, false_iff]; exact fun e => h ⟨e.1, e.2.1⟩
  · unfold Run.ownerVia
    split
    · rename_i h; simp only [Option.some.injEq]; exact ⟨fun e => ⟨h.1, h.2, e.symm⟩, fun e => e.2.2.symm⟩
    · rename_i h; simp only [reduceCtorEq, false_iff]; exact fun e => h ⟨e.1, e.2.1⟩

/-- The cross-tenant counterexamples: the witness run reaches the witness session's agent and
owner, but a session carrying the same session id in workspace `w2`, or another session of the
same workspace, reaches neither. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/runs.ts#runs")
  (ts := "apps/web/server/runs/store.ts#ownerPrincipalId")]
theorem run_join_refuses_another_workspace_or_session :
    Witness.run.agentVia Witness.session = some Witness.session.agent ∧
      Witness.run.ownerVia Witness.session = some Witness.session.ownerPrincipal ∧
      Witness.run.agentVia { Witness.session with workspace := ⟨"w2"⟩ } = none ∧
      Witness.run.ownerVia { Witness.session with workspace := ⟨"w2"⟩ } = none ∧
      Witness.run.agentVia { Witness.session with id := ⟨"s2"⟩ } = none ∧
      Witness.run.ownerVia { Witness.session with id := ⟨"s2"⟩ } = none := by
  decide

private theorem id_eq_of_val {k : IdKind} {a b : Id k} (h : a.val = b.val) : a = b := by
  cases a; cases b; cases h; rfl

/-- The concept join agrees with the row join: whenever a run's row references a session's row
through `runs_session_workspace_fk` (the one reference `run_reaches_exactly_one_agent` and
`run_reaches_exactly_one_owner` make unique), the run reaches that session's agent and owning
principal. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/runs.ts#runs_session_workspace_fk")]
theorem run_join_agrees_with_the_row_reference (st : State) (r : Run) (s : Session)
    (h : References catalogue st .runs (workFk .runs "runs_session_workspace_fk")
      (ofCells (runCells r)) (ofCells (sessionCells s))) :
    r.agentVia s = some s.agent ∧ r.ownerVia s = some s.ownerPrincipal := by
  have hcols : (workFk .runs "runs_session_workspace_fk").columns =
      ["session_id", "workspace_id"] := by decide
  have hrefs : (workFk .runs "runs_session_workspace_fk").refColumns =
      ["id", "workspace_id"] := by decide
  have hp := h.2.2.2.2
  rw [hcols, hrefs] at hp
  simp [Row.project, Row.get, ofCells, runCells, sessionCells, List.lookup_cons] at hp
  have hws : s.workspace = r.workspace := id_eq_of_val hp.2
  have hid : s.id = r.session := id_eq_of_val hp.1
  exact ⟨(run_reaches_agent_and_owner_only_through_its_own_session r s).1 _ |>.mpr
      ⟨hid, hws, rfl⟩,
    (run_reaches_agent_and_owner_only_through_its_own_session r s).2 _ |>.mpr ⟨hid, hws, rfl⟩⟩

/-- "The person a session belongs to must hold a membership in the workspace the session is
in": a session row with a user has a membership row for that user in its own workspace. -/
@[aw_spec (tier := T1) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/sessions.ts#sessions_member_workspace_fk")]
theorem session_user_is_a_member_of_its_workspace (st : State)
    (hc : consistent catalogue st = true) {r : Row} (hr : r ∈ st .sessions) {u : String}
    (hu : r.get "user_id" = some u) :
    ∃ m ∈ st .memberships, m.get "workspace_id" = r.get "workspace_id" ∧
      m.get "user_id" = some u := by
  have hws : (r.get "workspace_id").isSome = true :=
    AgentWorkspace.Theorems.Invariants.ErCore.tenant_row_has_workspace catalogue st hc
      (t := .sessions) (tc := "workspace_id") rfl (by decide) hr
  have hset : r.present (workFk .sessions "sessions_member_workspace_fk").columns = true := by
    have : (workFk .sessions "sessions_member_workspace_fk").columns =
        ["workspace_id", "user_id"] := by decide
    rw [this]
    simp [Row.present, hu, hws]
  obtain ⟨⟨m, hm⟩, _⟩ := sessions_member_workspace_fk_links_at_most_one_parent st hc hr hset
  obtain ⟨_, _, hmem, _, hproj⟩ := hm
  have hcols : (workFk .sessions "sessions_member_workspace_fk").columns =
      ["workspace_id", "user_id"] := by decide
  have hrcols : (workFk .sessions "sessions_member_workspace_fk").refColumns =
      ["workspace_id", "user_id"] := by decide
  have href : (workFk .sessions "sessions_member_workspace_fk").refTable = .memberships := by
    decide
  rw [hcols, hrcols] at hproj
  rw [href] at hmem
  simp only [Row.project, List.map_cons, List.map_nil, List.cons.injEq] at hproj
  exact ⟨m, hmem, hproj.1, hproj.2.1.trans hu⟩

/-! ## Row checks in every consistent state

Corollaries of `workConsistent` (a state passes every refined check), stated as the sentences
the schema comments give. They are T1 readings of the checks, not operation invariants. -/

/- In every state the work cluster admits, every refined check of a work table holds on every
row of that table: the unfolding of `workConsistent` the corollaries below share (a private
helper since the Phase-1 debt round, because as a public T1 theorem it restated the definition). -/
private theorem work_check_holds_on_every_row (st : State) (hc : workConsistent st = true)
    {t : TableName} {n : String} (ht : t ∈ workTables) (hn : n ∈ otherChecks t) {r : Row}
    (hr : r ∈ st t) : workCheckHolds n r = true := by
  simp only [workConsistent, workChecksHold, Bool.and_eq_true, List.all_eq_true] at hc
  exact hc.2 t ht n hn r hr

/-- "A finished run has an end time and an unfinished one does not": in every consistent state a
run row has `ended_at` exactly when its status is terminal. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/runs.ts#runs_ended_at_iff_terminal")]
theorem run_row_has_ended_at_iff_terminal (st : State) (hc : workConsistent st = true) {r : Row}
    (hr : r ∈ st .runs) {s : String} (hs : r.get "status" = some s) :
    terminalWires.contains s = (r.get "ended_at").isSome := by
  have h := work_check_holds_on_every_row st hc (t := .runs) (n := "runs_ended_at_iff_terminal")
    (by decide) (by decide) hr
  simpa [workCheckHolds, workCheck, hs] using h

/-- In every consistent state a run row never ends before it starts. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/runs.ts#runs_ended_after_started")]
theorem run_row_ends_after_it_starts (st : State) (hc : workConsistent st = true) {r : Row}
    (hr : r ∈ st .runs) {a b : Nat} (hs : natCell? r "started_at" = some a)
    (he : natCell? r "ended_at" = some b) : a ≤ b := by
  have h := work_check_holds_on_every_row st hc (t := .runs) (n := "runs_ended_after_started")
    (by decide) (by decide) hr
  simp only [workCheckHolds, workCheck, notBefore] at h
  cases hge : r.get "ended_at" with
  | none => simp [natCell?, hge] at he
  | some ev =>
    cases hgs : r.get "started_at" with
    | none => simp [natCell?, hgs] at hs
    | some sv =>
      simp only [hge, hgs, hs, he] at h
      simpa using h

/-- In every consistent state a run row carries a price table version exactly when its
accounting state is `complete` or `partial`. -/
@[aw_spec (tier := T1)
  (ts := "packages/core/src/db/schema/runs.ts#runs_price_version_matches_accounting_state")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
theorem run_row_price_version_iff_priced (st : State) (hc : workConsistent st = true) {r : Row}
    (hr : r ∈ st .runs) {a : String} (ha : r.get "accounting_state" = some a) :
    pricedWires.contains a = (r.get "price_table_version").isSome := by
  have h := work_check_holds_on_every_row st hc (t := .runs)
    (n := "runs_price_version_matches_accounting_state") (by decide) (by decide) hr
  simpa [workCheckHolds, workCheck, ha] using h

/-- In every consistent state a run row whose usage is not priced costs exactly zero. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/runs.ts#runs_unpriced_cost_zero")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
theorem unpriced_run_row_costs_zero (st : State) (hc : workConsistent st = true) {r : Row}
    (hr : r ∈ st .runs) {a c : String} (ha : r.get "accounting_state" = some a)
    (hunpriced : pricedWires.contains a = false) (hcost : r.get "cost_usd" = some c) :
    isZeroDecimal c = true := by
  have h := work_check_holds_on_every_row st hc (t := .runs) (n := "runs_unpriced_cost_zero")
    (by decide) (by decide) hr
  simpa only [workCheckHolds, workCheck, ha, hcost, hunpriced, Bool.false_or] using h

/-- In every consistent state every run row and every ledger row settles in USD. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/runs.ts#runs_cost_currency_usd")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_currency_usd")]
theorem work_rows_settle_in_usd (st : State) (hc : workConsistent st = true) {r : Row}
    {c : String} (hcur : r.get "cost_currency" = some c)
    (hr : r ∈ st .runs ∨ r ∈ st .runUsageRecords) : c = "USD" := by
  rcases hr with hr | hr
  · have h := work_check_holds_on_every_row st hc (t := .runs) (n := "runs_cost_currency_usd")
      (by decide) (by decide) hr
    simpa [workCheckHolds, workCheck, hcur] using h
  · have h := work_check_holds_on_every_row st hc (t := .runUsageRecords)
      (n := "run_usage_records_currency_usd") (by decide) (by decide) hr
    simpa [workCheckHolds, workCheck, hcur] using h

/-- In every consistent state every token counter of a run row or a ledger row is a
non-negative integer. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/runs.ts#runs_counters_non_negative")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_counters_non_negative")]
theorem work_row_counters_are_natural (st : State) (hc : workConsistent st = true) {r : Row}
    (hr : r ∈ st .runs ∨ r ∈ st .runUsageRecords) {col v : String} (hcol : col ∈ counterColumns)
    (hv : r.get col = some v) : (parseNat? v).isSome = true := by
  have h : countersNonNegative r = true := by
    rcases hr with hr | hr
    · simpa [workCheckHolds, workCheck] using work_check_holds_on_every_row st hc (t := .runs)
        (n := "runs_counters_non_negative") (by decide) (by decide) hr
    · simpa [workCheckHolds, workCheck] using work_check_holds_on_every_row st hc
        (t := .runUsageRecords) (n := "run_usage_records_counters_non_negative") (by decide)
        (by decide) hr
  simp only [countersNonNegative, Bool.and_eq_true, List.all_eq_true] at h
  simpa [hv] using h.1 col hcol

/-- In every consistent state a run token expires strictly after it was minted. -/
@[aw_spec (tier := T1)
  (ts := "packages/core/src/db/schema/run-tokens.ts#run_tokens_expiry_after_created")]
theorem run_token_row_expires_after_creation (st : State) (hc : workConsistent st = true)
    {r : Row} (hr : r ∈ st .runTokens) {c e : Nat} (hcr : natCell? r "created_at" = some c)
    (hex : natCell? r "expires_at" = some e) : c < e := by
  have h := work_check_holds_on_every_row st hc (t := .runTokens)
    (n := "run_tokens_expiry_after_created") (by decide) (by decide) hr
  simp only [workCheckHolds, workCheck] at h
  cases hge : r.get "expires_at" with
  | none => simp [natCell?, hge] at hex
  | some ev =>
    cases hgc : r.get "created_at" with
    | none => simp [natCell?, hgc] at hcr
    | some cv =>
      simp only [hge, hgc, hex, hcr] at h
      simpa using h

/-- In every consistent state a project row's name has a character other than a space, and its
default model connection and default model are set together or not at all. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/projects.ts#projects_name_not_blank")
  (ts := "packages/core/src/db/schema/projects.ts#projects_default_model_pair")]
theorem project_row_invariants (st : State) (hc : workConsistent st = true) {r : Row}
    (hr : r ∈ st .projects) :
    (r.get "name").all hasNonSpace = true ∧
      ((r.get "default_model_connection_id").isNone = (r.get "default_model").isNone) := by
  have h1 := work_check_holds_on_every_row st hc (t := .projects) (n := "projects_name_not_blank")
    (by decide) (by decide) hr
  have h2 := work_check_holds_on_every_row st hc (t := .projects)
    (n := "projects_default_model_pair") (by decide) (by decide) hr
  simp only [workCheckHolds, workCheck] at h1 h2
  exact ⟨h1, by simpa using h2⟩

/-- In every consistent state an audit row has two non-blank labels, and a recorded subject id
has the canonical UUID shape (so its link can resolve). -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/audit-events.ts#audit_events_subject_id_shape")
  (ts := "packages/core/src/db/schema/audit-events.ts#audit_events_subject_label_not_blank")]
theorem audit_row_invariants (st : State) (hc : workConsistent st = true) {r : Row}
    (hr : r ∈ st .auditEvents) :
    (r.get "actor_label").all hasNonSpace = true ∧ (r.get "subject_label").all hasNonSpace = true ∧
      (r.get "subject_id").all Uuid.isCanonical = true := by
  have h1 := work_check_holds_on_every_row st hc (t := .auditEvents)
    (n := "audit_events_actor_label_not_blank") (by decide) (by decide) hr
  have h2 := work_check_holds_on_every_row st hc (t := .auditEvents)
    (n := "audit_events_subject_label_not_blank") (by decide) (by decide) hr
  have h3 := work_check_holds_on_every_row st hc (t := .auditEvents)
    (n := "audit_events_subject_id_shape") (by decide) (by decide) hr
  simp only [workCheckHolds, workCheck] at h1 h2 h3
  exact ⟨h1, h2, h3⟩

/-! ## Runs and usage -/

private def sampleRun (s : RunStatus) (a : AccountingState) : Run :=
  { Run.create ⟨"r"⟩ ⟨"w"⟩ ⟨"s"⟩ 0 with
    status := s, startedAt := if s = .queued then none else some 1,
    endedAt := if s.isTerminal then some 2 else none, accountingState := a,
    priceTableVersion := if a.isPriced then some "v1" else none,
    costUsd := if a.isPriced then "0.500000" else zeroCost }

/-- "A run's `status` reaching a terminal value and its `accountingState` reaching `'complete'`
are two separate facts", at the level of the row checks only: every one of the 25 combinations of
status and accounting state passes the six `runs` checks, so no check ties one to the other (this
says nothing about which combinations a store path reaches; the document itself only says a
completed run's accounting may still be `pending` or `partial`). -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/schema/runs.ts#accountingStates")]
theorem status_and_accounting_are_independent (s : RunStatus) (a : AccountingState) :
    ∃ r : Run, r.wellFormed = true ∧ r.status = s ∧ r.accountingState = a :=
  ⟨sampleRun s a, by cases s <;> cases a <;> decide, rfl, rfl⟩

/-- A run exists as soon as it is started, as `queued` ("the run already exists, with
`status: 'queued'`"), with zero usage, the zero cost `'0.000000'` in USD, no price table version
and accounting `pending`, and it passes every check. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "apps/web/server/runs/store.ts#InMemoryRunStore")]
theorem new_run_is_queued_unpriced_and_well_formed (id : RunId) (ws : WorkspaceId)
    (session : SessionId) (now : Nat) :
    let r := Run.create id ws session now
    r.status = .queued ∧ r.accountingState = .pending ∧ r.counters.totalTokens = 0 ∧
      r.costUsd = "0.000000" ∧ r.priceTableVersion = none ∧ r.durationMs = none ∧
      r.wellFormed = true := by
  refine ⟨rfl, rfl, rfl, rfl, rfl, rfl, ?_⟩
  simp only [Run.create, Run.wellFormed, Run.endedAtIffTerminal, Run.endedAfterStarted,
    Run.costNonNegative, Run.currencyUsd, Run.priceVersionMatches, Run.unpricedCostZero]
  decide

/-- A well-formed run carries a price table version exactly when its usage is priced
(`priceTableVersion` "`null` until priced"), and a run whose usage is not priced costs zero. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/core/src/db/schema/runs.ts#runs_unpriced_cost_zero")]
theorem unpriced_run_has_no_version_and_costs_zero (r : Run) (hwf : r.wellFormed = true)
    (hun : r.accountingState.isPriced = false) :
    r.priceTableVersion = none ∧ isZeroDecimal r.costUsd = true := by
  simp only [Run.wellFormed, Run.priceVersionMatches, Run.unpricedCostZero, hun,
    Bool.and_eq_true, Bool.false_or] at hwf
  refine ⟨?_, hwf.2⟩
  have h := hwf.1.2
  cases hv : r.priceTableVersion
  · rfl
  · simp [hv] at h

/-- A well-formed run has an end time exactly when its status is terminal. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/runs.ts#runs_ended_at_iff_terminal")]
theorem well_formed_run_ends_iff_terminal (r : Run) (hwf : r.wellFormed = true) :
    r.endedAt.isSome = r.status.isTerminal := by
  simp only [Run.wellFormed, Run.endedAtIffTerminal, Bool.and_eq_true, beq_iff_eq] at hwf
  exact hwf.1.1.1.1.1.symm

/-- `totalTokens` is "the sum of the four" token counters: it never counts tool calls, and it
adds up across settlements (the total of a sum of counters is the sum of their totals). -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/contracts/src/runs.ts#RunUsageSchema")]
theorem total_tokens_is_the_sum_of_four_counters (c d : Counters) :
    c.totalTokens = { c with toolCalls := 0 }.totalTokens ∧
      (c.add d).totalTokens = c.totalTokens + d.totalTokens ∧
      Counters.totalTokens ⟨1, 2, 4, 8, 16⟩ = 15 := by
  refine ⟨rfl, ?_, by decide⟩
  simp only [Counters.add, Counters.totalTokens]
  omega

/-- "`durationMs` is `null` until both `startedAt` and `endedAt` exist". -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/runs.ts#RunResourceSchema")
  (doc := "docs/sdk/site/resources/runs.mdx#the-run-record")]
theorem duration_needs_both_timestamps (r : Run) :
    r.durationMs.isSome = (r.startedAt.isSome && r.endedAt.isSome) := by
  unfold Run.durationMs
  cases r.startedAt <;> cases r.endedAt <;> rfl

/-- Once both timestamps exist, `durationMs` is the end time minus the start time, so a
well-formed finished run's duration added to its start is its end. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/runs/api.ts#renderRun")]
theorem duration_is_end_minus_start (r : Run) (s e : Nat) (hs : r.startedAt = some s)
    (he : r.endedAt = some e) :
    r.durationMs = some (e - s) ∧ (r.endedAfterStarted = true → s + (e - s) = e) := by
  refine ⟨by simp [Run.durationMs, hs, he], fun h => ?_⟩
  simp only [Run.endedAfterStarted, hs, he, decide_eq_true_eq] at h
  omega

/-- Settlement is a separate question from pricing: only `'complete'` is "a settled answer",
every settled state is priced, and `'partial'` is priced without being settled. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/contracts/src/runs.ts#ACCOUNTING_STATES")
  (ts := "packages/core/src/db/schema/runs.ts#runs_price_version_matches_accounting_state")]
theorem only_complete_is_settled (a : AccountingState) :
    (a.isSettled = true ↔ a = .complete) ∧ (a.isSettled = true → a.isPriced = true) ∧
      (AccountingState.«partial».isPriced = true ∧ AccountingState.«partial».isSettled = false) := by
  cases a <;> decide

/-! ## Decimal amounts -/

/-- A decimal the model reads as zero has no digit other than `0`, which is what
`runs_unpriced_cost_zero`'s `cost_usd = 0` compares. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/runs.ts#runs_unpriced_cost_zero")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
theorem zero_decimal_has_no_nonzero_digit (s : String) (h : isZeroDecimal s = true) :
    ∀ c ∈ s.toList, c.isDigit = true → c = '0' := by
  intro c hc hd
  simp only [isZeroDecimal, Bool.and_eq_true, List.all_eq_true] at h
  have := h.2 c hc
  simp only [Bool.or_eq_true, beq_iff_eq] at this
  rcases this with (h0 | h0) | h0
  · exact h0
  · subst h0; simp at hd
  · subst h0; simp at hd

/-- A leading `-` on a nonzero decimal is refused by the `≥ 0` half of the counter checks: the
only negative-signed amount a run or a ledger row may carry is a spelling of zero. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/runs.ts#runs_counters_non_negative")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_counters_non_negative")]
theorem negative_nonzero_decimal_is_refused (s : String) (hneg : s.toList.head? = some '-')
    (hnz : isZeroDecimal s = false) : isNonNegDecimal s = false := by
  simp [isNonNegDecimal, hneg, hnz]

/-- The run checks refuse cost the accounting state does not allow: a run whose usage is not
priced but whose cost is nonzero, and a priced run with a negative cost, are both ill formed. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/runs.ts#runs_unpriced_cost_zero")
  (ts := "packages/core/src/db/schema/runs.ts#runs_counters_non_negative")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
theorem run_checks_refuse_unpriced_or_negative_cost :
    ({ Witness.queuedRun with costUsd := "0.001000" } : Run).wellFormed = false ∧
      ({ Witness.run with costUsd := "-0.001000" } : Run).wellFormed = false ∧
      ({ Witness.queuedRun with costUsd := "-0.0" } : Run).wellFormed = true ∧
      Witness.run.wellFormed = true := by
  decide

/-- The ledger's accounting state: no settlement is `pending`; after one, it is priced exactly
when some ledger row is priced, `complete` when every row is and `unavailable` when none is. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/runs.ts#pricedCount")
  (ts := "packages/core/src/db/schema/runs.ts#accountingStates")]
theorem ledger_accounting_follows_the_priced_rows (records : List UsageRecord) :
    (records = [] → ledgerAccounting records = .pending) ∧
      (records ≠ [] → (ledgerAccounting records).isPriced = records.any UsageRecord.isPriced) ∧
      (records ≠ [] → records.all UsageRecord.isPriced → ledgerAccounting records = .complete) ∧
      (records ≠ [] → records.all (!UsageRecord.isPriced ·) →
        ledgerAccounting records = .unavailable) := by
  refine ⟨fun h => by simp [h, ledgerAccounting], fun hne => ?_, fun hne hall => ?_,
    fun hne hnone => ?_⟩
  · have hemp : records.isEmpty = false := by simpa using hne
    simp only [ledgerAccounting, hemp]
    by_cases h0 : (records.filter UsageRecord.isPriced).length = 0
    · have hany : records.any UsageRecord.isPriced = false := by
        rw [List.length_eq_zero_iff, List.filter_eq_nil_iff] at h0
        simpa using h0
      simp [h0, hany, AccountingState.isPriced]
    · have hany : records.any UsageRecord.isPriced = true := by
        rw [List.length_eq_zero_iff, List.filter_eq_nil_iff] at h0
        simpa using h0
      by_cases hall : (records.filter UsageRecord.isPriced).length = records.length <;>
        simp [h0, hall, hany, hne, AccountingState.isPriced]
  · have hemp : records.isEmpty = false := by simpa using hne
    have hf : records.filter UsageRecord.isPriced = records := List.filter_eq_self.mpr (by simpa using hall)
    have hlen : records.length ≠ 0 := by simpa using hne
    simp [ledgerAccounting, hemp, hf, hlen]
  · have hemp : records.isEmpty = false := by simpa using hne
    have hf : records.filter UsageRecord.isPriced = [] :=
      List.filter_eq_nil_iff.mpr (by simpa using hnone)
    simp [ledgerAccounting, hemp, hf]

/-- A ledger with at least one priced and at least one unpriced row is `partial`: the run's
cost is known for some of its responses but not all of them. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/repositories/runs.ts#pricedCount")
  (ts := "packages/core/src/db/schema/runs.ts#accountingStates")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
theorem mixed_ledger_is_partial (records : List UsageRecord)
    (hp : records.any UsageRecord.isPriced = true)
    (hu : records.any (!UsageRecord.isPriced ·) = true) :
    ledgerAccounting records = .«partial» := by
  have hne : records ≠ [] := by rintro rfl; simp at hp
  have hemp : records.isEmpty = false := by simpa using hne
  have h0 : (records.filter UsageRecord.isPriced).length ≠ 0 := by
    rw [ne_eq, List.length_eq_zero_iff, List.filter_eq_nil_iff]
    simpa using hp
  have hall : (records.filter UsageRecord.isPriced).length ≠ records.length := by
    intro h
    have hsame := List.length_filter_eq_length_iff.mp h
    obtain ⟨r, hr, hnp⟩ := List.any_eq_true.mp hu
    simp [hsame r hr] at hnp
  simp [ledgerAccounting, hemp, h0, hall]

/-- One priced and one unpriced settlement make a `partial` ledger. -/
example : ledgerAccounting [Witness.usage, { Witness.usage with priceTableVersion := none }] = .«partial» :=
  mixed_ledger_is_partial _ (by decide) (by decide)

/-! ## Sessions and transcripts -/

/-- A session is resumable exactly when it is active and the SDK has reported its id; so an
archived session is never resumable, and a session the SDK never started launches fresh. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/sessions.ts#SessionResourceSchema")
  (ts := "apps/web/server/composition/session-launch.ts#sessionForLaunch")
  (doc := "docs/sdk/04-api-specification.md#511-sessions-and-transcripts--awsessions")]
theorem resumable_means_active_and_reported (s : Session) :
    (s.status = .archived → s.resumable = false) ∧
      (s.engineSessionId = none → s.launchMode = .fresh) ∧
      (s.resumable = true → s.launchMode = .resume) := by
  refine ⟨fun h => by simp [Session.resumable, h], fun h => by simp [Session.launchMode, h],
    fun h => ?_⟩
  simp only [Session.resumable, Bool.and_eq_true, beq_iff_eq] at h
  simp [Session.launchMode, Option.isNone_iff_eq_none, Option.isSome_iff_ne_none.mp h.2]

/-- The runtime's reported SDK session id is recorded exactly when it is the platform id; any
other id is refused ("the runtime reported a Claude session id that differs from the platform
id"). -/
@[aw_spec (tier := T1)
  (ts := "apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity")]
theorem reported_identity_must_be_the_platform_id (s : Session) (reported : String) :
    (s.recordReported reported).isSome = true ↔ reported = s.id.val := by
  unfold Session.recordReported
  split <;> simp_all

/-- The main transcript is stored under the empty subpath, which the wire refuses as a subpath
("the empty string is refused rather than read as 'none'"), and every wire subpath is at most
128 characters. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/sessions.ts#TRANSCRIPT_SUBPATH_PATTERN")
  (ts := "packages/core/src/db/schema/session-transcripts.ts#subpath")
  (doc := "docs/sdk/04-api-specification.md#511-sessions-and-transcripts--awsessions")]
theorem main_transcript_has_no_wire_subpath :
    mainSubpath = "" ∧ isWireSubpath mainSubpath = false ∧
      ∀ s, isWireSubpath s = true → s.length ≤ 128 := by
  refine ⟨rfl, by decide, fun s h => ?_⟩
  simp only [isWireSubpath, subpathMaxLength, Bool.and_eq_true] at h
  exact of_decide_eq_true h.1

private theorem zip_all : ∀ {l1 : List Char} {l2 : List Bool}, l1.length = l2.length →
    (l1.zip l2).all (fun (c, hex) => if hex then Uuid.isHexDigit c else c == '-') = true →
    ∀ c ∈ l1, Uuid.isHexDigit c = true ∨ c = '-'
  | [], _, _, _, c, hc => by simp at hc
  | _ :: _, [], hlen, _, _, _ => by simp at hlen
  | _ :: xs, b :: bs, hlen, h, c, hc => by
    simp only [List.zip_cons_cons, List.all_cons, Bool.and_eq_true] at h
    rcases List.mem_cons.mp hc with rfl | hc
    · cases b <;> simp_all
    · exact zip_all (by simpa using hlen) h.2 c hc

private theorem key_char_of_hex (c : Char) (h : Uuid.isHexDigit c = true ∨ c = '-') :
    isKeyChar c = true := by
  rcases h with h | rfl
  · simp only [Uuid.isHexDigit, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq] at h
    simp only [isKeyChar, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq]
    rcases h with (h | h) | h
    · exact Or.inl (Or.inl (Or.inr h))
    · exact Or.inl (Or.inl (Or.inl (Or.inr ⟨h.1, Char.le_trans h.2 (by decide)⟩)))
    · exact Or.inl (Or.inl (Or.inl (Or.inl ⟨h.1, Char.le_trans h.2 (by decide)⟩)))
  · decide

private theorem device_name_is_short (s : String) (h : isWindowsDeviceName s = true) :
    s.toList.length ≤ 4 := by
  unfold isWindowsDeviceName at h
  split at h
  all_goals first
    | (simp at h; done)
    | (rename_i heq; have := congrArg List.length heq; simp at this; omega)

/-- The transcript project key "is the caller's workspace id by construction", and that is always
safe: every canonical UUID matches `PROJECT_KEY_PATTERN` (the SDK's own validator) and is not a
Windows device name, so a workspace id never makes the SDK silently fall back to a key shared
across tenants. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/sessions.ts#PROJECT_KEY_PATTERN")
  (ts := "packages/core/src/schemas.ts#validateTenantSessionScope")
  (doc := "docs/sdk/04-api-specification.md#511-sessions-and-transcripts--awsessions")]
theorem workspace_id_is_a_safe_project_key (s : String) (h : Uuid.isCanonical s = true) :
    isProjectKey s = true ∧ isWindowsDeviceName s = false := by
  simp only [Uuid.isCanonical, Bool.and_eq_true, beq_iff_eq] at h
  have hlen : s.toList.length = 36 := by rw [h.1]; decide
  refine ⟨?_, ?_⟩
  · simp only [isProjectKey, hlen, Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true]
    exact ⟨⟨by omega, by omega⟩, fun c hc => key_char_of_hex c (zip_all h.1 h.2 c hc)⟩
  · cases hd : isWindowsDeviceName s
    · rfl
    · have := device_name_is_short s hd; omega

/-- With a non-blank configuration directory, the tenant session scope keyed by a workspace id is
always accepted by `validateTenantSessionScope`. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/schemas.ts#validateTenantSessionScope")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem tenant_scope_accepts_a_workspace_key (ws configDir : String)
    (hws : Uuid.isCanonical ws = true) (hdir : Concepts.ModelConnection.isBlank configDir = false) :
    tenantScopeOk ws configDir = true := by
  obtain ⟨hk, hd⟩ := workspace_id_is_a_safe_project_key ws hws
  simp [tenantScopeOk, hk, hd, hdir]

/-- `validateTenantSessionScope` accepts only a scope the SDK keeps apart from every other: the
key is one directory name of 1 to 64 characters with no path separator and no `.` (so no `..`
and no hidden or relative path), it is not a Windows device name, and the configuration directory
is not blank. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/schemas.ts#validateTenantSessionScope")
  (ts := "packages/contracts/src/sessions.ts#PROJECT_KEY_PATTERN")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem tenant_scope_refuses_unsafe_keys (k d : String) (h : tenantScopeOk k d = true) :
    1 ≤ k.length ∧ k.length ≤ 64 ∧ (∀ c ∈ k.toList, c ≠ '/' ∧ c ≠ '\\' ∧ c ≠ '.') ∧
      isWindowsDeviceName k = false ∧ Concepts.ModelConnection.isBlank d = false := by
  simp only [tenantScopeOk, isProjectKey, Bool.and_eq_true, Bool.not_eq_true',
    decide_eq_true_eq, List.all_eq_true] at h
  obtain ⟨⟨hd, ⟨⟨h1, h64⟩, hall⟩⟩, hdev⟩ := h
  rw [← String.length_toList]
  refine ⟨h1, h64, fun c hc => ?_, hdev, hd⟩
  have hk := hall c hc
  refine ⟨?_, ?_, ?_⟩ <;> (rintro rfl; revert hk; decide)

/-- The refusals, by case: a device-name key (`con`, `COM1`, `lpt9`), an empty or 65-character
key, a key with a `/` or `.`, and a blank configuration directory (ASCII blanks, or the Unicode
blanks `String.prototype.trim` also strips: U+3000, U+2028, U+205F, U+1680, U+FEFF) are all
refused, while a 64-character key under a real directory is accepted, and a directory holding a
zero-width space (U+200B, not whitespace to ECMAScript) is not blank. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/schemas.ts#validateTenantSessionScope")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem tenant_scope_refusals :
    (["con", "COM1", "lpt9", "", "a/b", "..", String.ofList (List.replicate 65 'k')].all
        fun k => !tenantScopeOk k "/var/lib/aw") = true ∧
      tenantScopeOk "workspace-1" " \t\n" = false ∧ tenantScopeOk "workspace-1" "" = false ∧
      (["\u3000", "\u2028", "\u205F", "\u1680", "\uFEFF", " \u2029\u00A0"].all
        fun d => !tenantScopeOk "workspace-1" d) = true ∧
      tenantScopeOk "workspace-1" "\u200B" = true ∧
      tenantScopeOk (String.ofList (List.replicate 64 'k')) "/var/lib/aw" = true := by
  decide

/-- A redelivered transcript entry keeps the position of its first delivery, so a message whose
position is at most its sequence keeps that shape at every later sequence; a position after the
message's own sequence is refused. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/session-messages.ts#position")]
theorem redelivery_keeps_an_earlier_position (m : TranscriptMessage) (s' : Nat)
    (h : m.positionAtMostSequence = true) (hlater : m.key.sequence ≤ s') :
    ({ m with key := { m.key with sequence := s' } } : TranscriptMessage).positionAtMostSequence
        = true ∧
      ({ m with position := m.key.sequence + 1 } : TranscriptMessage).positionAtMostSequence
        = false := by
  simp only [TranscriptMessage.positionAtMostSequence, decide_eq_true_eq, decide_eq_false_iff_not]
    at h ⊢
  omega

/-! ## Run events -/

/-- Control frames "carry no `id:` and never move the resume cursor", while `run.status` and the
relayed runtime events are durable; the three name lists are disjoint, so every listed name has
exactly one kind. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#the-event-stream")
  (ts := "packages/contracts/src/run-events.ts#CONTROL_FRAME_NAMES")
  (ts := "packages/contracts/src/run-events.ts#RELAYED_EVENT_NAMES")]
theorem frame_kinds_are_disjoint_and_only_control_is_transient :
    controlFrameNames.all (fun n => frameKind? n == some .control) ∧
      frameKind? runStatusEvent = some .platform ∧
      relayedEventNames.all (fun n => frameKind? n == some .relayed) ∧
      (controlFrameNames ++ runStatusEvent :: relayedEventNames).Nodup ∧
      FrameKind.durable .control = false ∧ FrameKind.durable .platform = true ∧
      FrameKind.durable .relayed = true := by
  decide

private theorem window_facts : ∀ (l : List Nat), isWindow l = true → l.Nodup ∧ ∀ n ∈ l, 1 ≤ n
  | [], _ => by simp
  | lo :: rest, h => by
    simp only [isWindow, Bool.and_eq_true, decide_eq_true_eq, beq_iff_eq] at h
    obtain ⟨hlo, hr⟩ := h
    rw [hr]
    refine ⟨List.nodup_cons.mpr ⟨?_, List.nodup_range'⟩, fun n hn => ?_⟩
    · simp only [List.mem_range'_1]; omega
    · simp only [List.mem_cons, List.mem_range'_1] at hn
      omega

/-- Two runs' events interleaved in one table: run `ra` holds 1, 2, 3 and run `rb` holds 5, 6. -/
private def interleaved : List RunEvent :=
  [(⟨"ra"⟩, 1), (⟨"rb"⟩, 5), (⟨"ra"⟩, 2), (⟨"rb"⟩, 6), (⟨"ra"⟩, 3)].map fun (run, n) =>
    { key := ⟨run, n⟩, workspace := ⟨"w1"⟩, type := runStatusEvent, data := "{}", createdAt := n }

/-- "Durable, ordered SSE events for one run. Sequence numbers are contiguous per run": when the
events a table stores for one run form a contiguous log, that run's sequences are distinct and
positive; contiguity is judged per run, so another run's events interleaved in the same table do
not break it, while a gap, a repeat, a reordering or a `0` in the run's own sequences does. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/run-events.ts#runEvents")]
theorem contiguous_log_has_distinct_positive_sequences (events : List RunEvent) (run : RunId)
    (h : logContiguous events run = true) :
    (sequencesOf events run).Nodup ∧ (∀ n ∈ sequencesOf events run, 1 ≤ n) ∧
      logContiguous interleaved ⟨"ra"⟩ = true ∧ logContiguous interleaved ⟨"rb"⟩ = true ∧
      isWindow (interleaved.map (·.key.sequence)) = false ∧
      logContiguous (interleaved.filter (·.key.sequence != 2)) ⟨"ra"⟩ = false ∧
      isWindow [3, 4, 5] = true ∧ isWindow [1, 3] = false ∧ isWindow [2, 2] = false ∧
      isWindow [2, 1] = false ∧ isWindow [0, 1] = false :=
  ⟨(window_facts _ h).1, (window_facts _ h).2, by decide, by decide, by decide, by decide,
    by decide, by decide, by decide, by decide, by decide⟩

/-- Every listed frame name satisfies `EVENT_NAME_PATTERN`, the grammar every `event:` name must
satisfy. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/run-events.ts#EVENT_NAME_PATTERN")]
theorem listed_frame_names_are_well_formed :
    (controlFrameNames ++ runStatusEvent :: relayedEventNames).all isEventName = true := by
  decide

/-- `EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/` on its edges: a one-letter name and
a 64-character name pass, a 65-character name fails, and a name that is empty, starts with a
digit, `_`, `-` or `.`, or holds a space, `:` or a non-ASCII letter fails; every accepted name is
at most 64 characters. -/
@[aw_spec (tier := T1) (ts := "packages/contracts/src/run-events.ts#EVENT_NAME_PATTERN")]
theorem event_name_pattern_edges :
    isEventName "a" = true ∧ isEventName ("a" ++ String.ofList (List.replicate 63 '9')) = true ∧
      isEventName ("a" ++ String.ofList (List.replicate 64 '9')) = false ∧
      isEventName "Z.b_c-9" = true ∧
      (["", "1abc", "_abc", "-abc", ".abc", "a b", "a:b", "é"].all (!isEventName ·)) = true ∧
      ∀ s, isEventName s = true → s.length ≤ 64 := by
  refine ⟨by decide, by decide, by decide, by decide, by decide, fun s h => ?_⟩
  unfold isEventName at h
  rw [← String.length_toList]
  split at h
  · simp at h
  · rename_i c rest heq
    simp only [Bool.and_eq_true, decide_eq_true_eq] at h
    rw [heq, List.length_cons]
    omega

/-! ## Projects -/

/-- A well-formed project's default model travels with its default connection (the project rung
of the rule "no layer of the model-resolution ladder may mix a connection from one level with a
model from another"). -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/core/src/db/schema/projects.ts#projects_default_model_pair")
  (ts := "packages/core/src/db/schema/projects.ts#defaultModel")
  (ts := "packages/contracts/src/runs.ts#StartRunRequestSchema")]
theorem project_default_model_travels_with_its_connection (p : Project)
    (hwf : p.wellFormed = true) : p.defaultModelConnection.isSome = p.defaultModel.isSome := by
  simp only [Project.wellFormed, Project.defaultModelPair, Bool.and_eq_true, beq_iff_eq] at hwf
  cases h1 : p.defaultModelConnection <;> cases h2 : p.defaultModel <;> simp_all

/-- The `?archived=` filters partition projects: every project is listed by exactly one of
`active` and `archived`, and by `all`; its state is `archived` exactly when `archivedAt` is set. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#510-projects--awprojects")
  (ts := "packages/core/src/db/repositories/projects.ts#archivedPredicate")]
theorem project_list_filters_partition (p : Project) :
    p.listedBy .active = !p.listedBy .archived ∧ p.listedBy .all = true ∧
      (p.state = .archived ↔ p.archivedAt.isSome) := by
  unfold Project.listedBy Project.state
  cases p.archivedAt <;> simp

/-! ## Witnesses -/

private theorem witness : consistent catalogue Witness.state = true := by
  have h := work_constraints_are_satisfiable.1
  simp only [workConsistent, Bool.and_eq_true] at h
  exact h.1

private theorem witness_work : workConsistent Witness.state = true :=
  work_constraints_are_satisfiable.1

example : terminalWires.contains "completed" = (
    (ofCells (runCells Witness.run)).get "ended_at").isSome :=
  run_row_has_ended_at_iff_terminal Witness.state witness_work (by decide +kernel) (by decide +kernel)

example : 5 ≤ 9 :=
  run_row_ends_after_it_starts Witness.state witness_work (r := ofCells (runCells Witness.run))
    (by decide +kernel) (by decide +kernel) (by decide +kernel)

example : pricedWires.contains "complete" =
    ((ofCells (runCells Witness.run)).get "price_table_version").isSome :=
  run_row_price_version_iff_priced Witness.state witness_work (by decide +kernel) (by decide +kernel)

example : isZeroDecimal "0.000000" = true :=
  unpriced_run_row_costs_zero Witness.state witness_work (r := ofCells (runCells Witness.queuedRun))
    (a := "pending") (c := "0.000000") (by decide +kernel) (by decide +kernel) (by decide) (by decide +kernel)

example : "USD" = "USD" :=
  work_rows_settle_in_usd Witness.state witness_work (r := ofCells (usageCells Witness.usage))
    (by decide +kernel) (.inr (by decide +kernel))

example : (parseNat? "10").isSome = true :=
  work_row_counters_are_natural Witness.state witness_work (r := ofCells (runCells Witness.run))
    (.inl (by decide +kernel)) (col := "input_tokens") (by decide) (by decide +kernel)

example : 4 < 100 :=
  run_token_row_expires_after_creation Witness.state witness_work
    (r := ofCells (runTokenCells Witness.token)) (by decide +kernel) (by decide +kernel)
    (by decide +kernel)

example : ((ofCells (projectCells Witness.project)).get "name").all hasNonSpace = true :=
  (project_row_invariants Witness.state witness_work (by decide +kernel)).1

example : ((ofCells (auditCells Witness.audit)).get "subject_id").all Uuid.isCanonical = true :=
  (audit_row_invariants Witness.state witness_work (by decide +kernel)).2.2

example := runs_session_workspace_fk_links_exactly_one_parent Witness.state witness
  (by decide +kernel : ofCells (runCells Witness.run) ∈ Witness.state .runs)

example := sessions_project_workspace_fk_links_at_most_one_parent Witness.state witness
  (by decide +kernel : ofCells (sessionCells Witness.session) ∈ Witness.state .sessions)
  (by decide +kernel)

example := run_reaches_exactly_one_agent Witness.state witness
  (r := ofCells (runCells Witness.run)) (by decide +kernel)

example := run_reaches_exactly_one_owner Witness.state witness
  (r := ofCells (runCells Witness.run)) (by decide +kernel)

example := run_join_agrees_with_the_row_reference Witness.state Witness.run Witness.session
  (by unfold References; decide +kernel)

example := session_user_is_a_member_of_its_workspace Witness.state witness
  (r := ofCells (sessionCells Witness.session)) (u := "u1") (by decide +kernel) (by decide +kernel)

example := unpriced_run_has_no_version_and_costs_zero Witness.queuedRun (by decide) (by decide)

example := well_formed_run_ends_iff_terminal Witness.run (by decide)

example := project_default_model_travels_with_its_connection Witness.project (by decide)

example := duration_is_end_minus_start Witness.run 5 9 rfl rfl

example := zero_decimal_has_no_nonzero_digit "0.000000" (by decide)

example := negative_nonzero_decimal_is_refused "-0.001000" (by decide) (by decide)

example := tenant_scope_refuses_unsafe_keys "0f8fad5b-d9cb-469f-a165-70867728950e"
  "/var/lib/aw/config" (by decide)

example := redelivery_keeps_an_earlier_position Witness.message 4 (by decide) (by decide)

example := contiguous_log_has_distinct_positive_sequences interleaved ⟨"rb"⟩ (by decide)

example := tenant_scope_accepts_a_workspace_key "0f8fad5b-d9cb-469f-a165-70867728950e"
  "/var/lib/aw/config" (by decide) (by decide)

/-- The acceptance needs a directory that is not blank to ECMAScript: U+3000 alone is refused. -/
example : tenantScopeOk "0f8fad5b-d9cb-469f-a165-70867728950e" "\u3000" = false := by decide

example := workspace_id_is_a_safe_project_key "0f8fad5b-d9cb-469f-a165-70867728950e" (by decide)

example := (ledger_accounting_follows_the_priced_rows [Witness.usage]).2.2.1 (by simp) (by decide)

end AgentWorkspace.Theorems.Normative.ConceptWork
