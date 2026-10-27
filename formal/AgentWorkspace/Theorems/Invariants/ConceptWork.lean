import AgentWorkspace.Theorems.WellFormed.ConceptWork
import AgentWorkspace.Theorems.Invariants.ErCore
import AgentWorkspace.Lifecycle.Run

/-!
T2 — invariants of the work cluster.

* **Keys and references, for any schema.** In every consistent state a key identifies at most
  one row (`key_identifies_one_row`), a reference therefore reaches at most one parent
  (`reference_has_one_target`), and a reference whose columns are set reaches one
  (`set_reference_has_a_target`, `required_reference_has_a_target`). The per-key cardinality
  theorems of `Theorems/Normative/ConceptWork.lean` instantiate these.
* **Composite-key tenancy, per foreign key.** `aw_work_tenant_theorems` generates, for every
  foreign key of the nine work tables whose target carries a tenant, the theorem that a reference
  through it joins two rows of one workspace — the `er-core` isolation lemma instantiated key by
  key, so a key that stops being tenant-paired fails a theorem by name.
* **Uniqueness consequences.** One event per `(run, sequence)`, one ledger row per provider
  response of a run (retries are not charged twice), one session per SDK session id in a
  workspace, one token per digest.
* **Operations.** `timedSteps` drives a run through any sequence of store operations
  (`markRunning`, `finish`) with a clock that never runs backwards; every run check is preserved
  by every such sequence (`store_operations_preserve_run_checks`), by induction. Recording the
  SDK's session id preserves the session identity invariant.
* **The event log.** The repository's `append` (allocate `max(sequence) + 1`, insert, prune the
  run's events at or below `next - maxEvents`) keeps every run's stored log contiguous, the
  appending run's and every other run's alike
  (`appending_an_event_keeps_every_log_contiguous`), by the window lemmas below.

The row-check corollaries of `workConsistent` (a consistent state's run rows end iff terminal, …)
are T1 readings of the checks and live in `Theorems/Normative/ConceptWork.lean`.
-/

namespace AgentWorkspace.Theorems.Invariants.ConceptWork

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Work AgentWorkspace.Contracts
open AgentWorkspace.Concepts.Project AgentWorkspace.Concepts.Session AgentWorkspace.Concepts.Run
open AgentWorkspace.Concepts.RunEvent AgentWorkspace.Concepts.Usage AgentWorkspace.Lifecycle
open AgentWorkspace.Theorems.WellFormed.ConceptWork

/-! ## Keys and references -/

private theorem table_consistent {S : Schema} {st : State} (hc : consistent S st = true)
    (t : TableName) : tableConsistent S st t = true :=
  List.all_eq_true.mp hc t (WireEnum.complete t)

private theorem get_eq_of_project {r1 r2 : Row} :
    ∀ {cs : List String} {c : String}, c ∈ cs → r1.project cs = r2.project cs → r1.get c = r2.get c
  | [], _, h, _ => by simp at h
  | x :: xs, c, h, hp => by
    simp only [Row.project, List.map_cons, List.cons.injEq] at hp
    rcases List.mem_cons.mp h with rfl | h
    · exact hp.1
    · exact get_eq_of_project h hp.2

private theorem project_of_subset {r1 r2 : Row} {a b : List String} (h : ∀ c ∈ a, c ∈ b)
    (hp : r1.project b = r2.project b) : r1.project a = r2.project a := by
  simp only [Row.project]
  exact List.map_congr_left fun c hc => get_eq_of_project (h c hc) hp

private theorem present_of_subset {r : Row} {a b : List String} (h : ∀ c ∈ a, c ∈ b)
    (hp : r.present b = true) : r.present a = true := by
  simp only [Row.present, List.all_eq_true] at hp ⊢
  exact fun c hc => hp c (h c hc)

private theorem present_eq (r : Row) (cs : List String) :
    r.present cs = (r.project cs).all Option.isSome := by
  simp [Row.present, Row.project, List.all_map, Function.comp_def]

private theorem keyHolds_elim {rows : List Row} {k : List String} (h : keyHolds rows k [] = true)
    {r1 r2 : Row} (h1 : r1 ∈ rows) (h2 : r2 ∈ rows) (hpres : r1.present k = true)
    (hp : r1.project k = r2.project k) : r1 = r2 := by
  simp only [keyHolds, List.all_nil] at h
  rw [List.filter_eq_self.mpr (fun _ _ => rfl), List.all_eq_true] at h
  have h' := h r1 h1
  simp only [hpres, Bool.not_true, Bool.false_or, List.all_eq_true] at h'
  have := h' r2 h2
  simpa [hp] using this

private theorem subset_of_same {a b : List String} (h : sameColumns a b = true) :
    ∀ c ∈ a, c ∈ b := by
  simp only [sameColumns, Bool.and_eq_true, List.all_eq_true] at h
  intro c hc
  simpa using h.1.2 c hc

/-- In every consistent state, under any schema, a key of a table (its primary key, or a unique
key that is not partial) identifies at most one row: two rows with the same non-`NULL` key
values are the same row. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem key_identifies_one_row (S : Schema) (st : State) (hc : consistent S st = true)
    {t : TableName} {cols : List String} (hkey : (S t).isKey cols = true) {r1 r2 : Row}
    (h1 : r1 ∈ st t) (h2 : r2 ∈ st t) (hpres : r1.present cols = true)
    (hp : r1.project cols = r2.project cols) : r1 = r2 := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  simp only [TableSpec.isKey, Bool.or_eq_true, List.any_eq_true, Bool.and_eq_true,
    List.isEmpty_iff] at hkey
  rcases hkey with hpk | ⟨u, hu, ⟨hpn, -⟩, hsame⟩
  · have hsub := subset_of_same (by simpa using hpk)
    exact keyHolds_elim h.1.1.1.2 h1 h2 (present_of_subset hsub hpres) (project_of_subset hsub hp)
  · have hk := h.1.1.2 u hu
    rw [hpn] at hk
    have hsub := subset_of_same hsame
    exact keyHolds_elim hk h1 h2 (present_of_subset hsub hpres) (project_of_subset hsub hp)

/-- In every consistent state, a reference through a foreign key whose target columns form a key
of the parent reaches at most one parent row. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem reference_has_one_target (S : Schema) (st : State) (hc : consistent S st = true)
    {t : TableName} {fk : ForeignKey} (hkey : (S fk.refTable).isKey fk.refColumns = true)
    {r r1 r2 : Row} (h1 : References S st t fk r r1) (h2 : References S st t fk r r2) :
    r1 = r2 := by
  obtain ⟨_, _, hr1, hpres, hp1⟩ := h1
  obtain ⟨_, _, hr2, _, hp2⟩ := h2
  have hpres1 : r1.present fk.refColumns = true := by
    rw [present_eq, hp1, ← present_eq]; exact hpres
  exact key_identifies_one_row S st hc hkey hr1 hr2 hpres1 (hp1.trans hp2.symm)

private theorem fk_holds {S : Schema} {st : State} (hc : consistent S st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (S t).foreignKeys) : fkHolds st t fk = true := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  exact h.1.2 fk hfk

/-- In every consistent state, a row whose foreign-key columns are all set references a parent
row through that key (PostgreSQL's `MATCH SIMPLE`). -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem set_reference_has_a_target (S : Schema) (st : State) (hc : consistent S st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (S t).foreignKeys) {r : Row} (hr : r ∈ st t)
    (hset : r.present fk.columns = true) : ∃ r', References S st t fk r r' := by
  have h := List.all_eq_true.mp (fk_holds hc hfk) r hr
  simp only [hset, Bool.not_true, Bool.false_or, List.any_eq_true, beq_iff_eq] at h
  obtain ⟨r', hr', hp⟩ := h
  exact ⟨r', hfk, hr, hr', hset, hp⟩

/-- In every consistent state, a row references a parent through every foreign key whose columns
are all `NOT NULL`. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem required_reference_has_a_target (S : Schema) (st : State) (hc : consistent S st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (S t).foreignKeys)
    (hnn : fk.columns.all (S t).isNotNull = true) {r : Row} (hr : r ∈ st t) :
    ∃ r', References S st t fk r r' := by
  apply set_reference_has_a_target S st hc hfk hr
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  simp only [Row.present, List.all_eq_true]
  intro c hcol
  have hc' := List.all_eq_true.mp hnn c hcol
  obtain ⟨col, hmem, hcol'⟩ := List.any_eq_true.mp hc'
  simp only [Bool.and_eq_true, beq_iff_eq] at hcol'
  have := h.1.1.1.1 col hmem
  simp only [notNullHolds, hcol'.2, Bool.not_true, Bool.false_or, List.all_eq_true] at this
  rw [← hcol'.1]
  exact this r hr

/-! ## Composite-key tenancy, per foreign key (generated) -/

section Generator

open Lean Elab Command

private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

private def ctorName (sql : String) : Name :=
  match sql.splitOn "_" with
  | [] => .anonymous
  | w :: ws => Name.mkSimple (w ++ String.join (ws.map String.capitalize))

/-- One T2 theorem per work foreign key whose target carries a tenant. -/
elab "aw_work_tenant_theorems" : command => do
  for (t, fk) in workForeignKeys do
    unless ((catalogue fk.refTable).tenantColumn?).isSome do continue
    let s := catalogue t
    let sql := TableName.toWire t
    let ref := TableName.toWire fk.refTable
    let tIdent := mkIdent (``TableName ++ ctorName sql)
    let rIdent := mkIdent (``TableName ++ ctorName ref)
    let fkTs := Syntax.mkStrLit ("packages/core/src/db/schema/" ++ s.source ++ "#" ++
      (if fk.inline then s.tsExport else fk.name))
    let thm := mkIdent (Name.mkSimple s!"{fk.name}_preserves_tenant")
    let n := Syntax.mkStrLit fk.name
    let doc := mkDocComment s!"In every consistent state, a `{sql}` row and the `{ref}` row it \
      references through `{fk.name}` belong to the same workspace."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T2))
        (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
        (ts := $fkTs) (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
      theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : consistent catalogue st = true)
          {r r' : AgentWorkspace.Er.Core.Row}
          (href : References catalogue st $tIdent (workFk $tIdent $n) r r') :
          tenantOf catalogue $tIdent r = tenantOf catalogue $rIdent r' := by
        have h := AgentWorkspace.Theorems.Invariants.ErCore.no_cross_tenant_reference catalogue
          (by decide +kernel) st hc (by decide +kernel) href
        rwa [show (workFk $tIdent $n).refTable = $rIdent by decide +kernel] at h))

end Generator

aw_work_tenant_theorems

private theorem consistent_of_work {st : State} (hc : workConsistent st = true) :
    consistent catalogue st = true := by
  simp only [workConsistent, Bool.and_eq_true] at hc; exact hc.1

/-! ## Uniqueness consequences -/

private theorem project_two (r : Row) (a b : String) : r.project [a, b] = [r.get a, r.get b] := rfl

/-- In every consistent state a run has at most one stored event per sequence number, so the
resume cursor names one event. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/run-events.ts#runEvents")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#resuming")]
theorem run_event_sequence_is_unique (st : State) (hc : consistent catalogue st = true)
    {e1 e2 : Row} (h1 : e1 ∈ st .runEvents) (h2 : e2 ∈ st .runEvents)
    (hrun : e1.get "run_id" = e2.get "run_id") (hseq : e1.get "sequence" = e2.get "sequence")
    (hpres : e1.present ["run_id", "sequence"] = true) : e1 = e2 :=
  key_identifies_one_row catalogue st hc (t := .runEvents) (by decide +kernel) h1 h2 hpres
    (by rw [project_two, project_two, hrun, hseq])

/-- In every consistent state a run's ledger holds at most one row per provider response, which
is what lets a delayed usage frame be retried "without charging the run twice". -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_response_unique")]
theorem usage_response_is_recorded_once (st : State) (hc : consistent catalogue st = true)
    {u1 u2 : Row} (h1 : u1 ∈ st .runUsageRecords) (h2 : u2 ∈ st .runUsageRecords)
    (hrun : u1.get "run_id" = u2.get "run_id")
    (hresp : u1.get "provider_response_id" = u2.get "provider_response_id")
    (hpres : u1.present ["run_id", "provider_response_id"] = true) : u1 = u2 :=
  key_identifies_one_row catalogue st hc (t := .runUsageRecords) (by decide +kernel) h1 h2 hpres
    (by rw [project_two, project_two, hrun, hresp])

/-- In every consistent state an SDK session id resolves to at most one session of a workspace:
"one workspace can never resolve another's session", and within one workspace the resume key is
unambiguous. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/sessions.ts#sessions_workspace_engine_session_key")]
theorem sdk_session_id_is_unique_per_workspace (st : State) (hc : consistent catalogue st = true)
    {s1 s2 : Row} (h1 : s1 ∈ st .sessions) (h2 : s2 ∈ st .sessions)
    (hws : s1.get "workspace_id" = s2.get "workspace_id")
    (hsdk : s1.get "engine_session_id" = s2.get "engine_session_id")
    (hpres : s1.present ["workspace_id", "engine_session_id"] = true) : s1 = s2 :=
  key_identifies_one_row catalogue st hc (t := .sessions) (by decide +kernel) h1 h2 hpres
    (by rw [project_two, project_two, hws, hsdk])

/-- In every consistent state a gateway token digest identifies at most one token, across all
workspaces. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/run-tokens.ts#run_tokens_hash_key")]
theorem run_token_digest_is_unique (st : State) (hc : consistent catalogue st = true)
    {t1 t2 : Row} (h1 : t1 ∈ st .runTokens) (h2 : t2 ∈ st .runTokens)
    (hhash : t1.get "token_hash" = t2.get "token_hash")
    (hpres : t1.present ["token_hash"] = true) : t1 = t2 :=
  key_identifies_one_row catalogue st hc (t := .runTokens) (by decide +kernel) h1 h2 hpres
    (by simp [Row.project, hhash])

/-- The witness state with one more row in table `t`. -/
private def withRow (t : TableName) (extra : Row) : State :=
  fun t' => if t' = t then Witness.state t' ++ [extra] else Witness.state t'

/-- A second event at a stored `(run, sequence)`, with other data. -/
private def eventTwin : Row := ofCells (runEventCells { Witness.event with data := "{}" })

/-- A second ledger row for a recorded provider response. -/
private def usageTwin : Row := ofCells (usageCells { Witness.usage with id := ⟨"ur2"⟩ })

/-- A second session of the workspace claiming a recorded SDK session id. -/
private def sessionTwin : Row := ofCells (sessionCells { Witness.session with id := ⟨"s2"⟩ })

/-- A second token carrying a stored digest. -/
private def tokenTwin : Row := ofCells (runTokenCells { Witness.token with id := ⟨"t2"⟩ })

/-- The uniqueness keys exclude a second, distinct row: adding to the witness state another event
at a stored `(run, sequence)`, another ledger row for a recorded provider response, another
session of the workspace with a recorded SDK session id, or another token with a stored digest
leaves a state PostgreSQL cannot hold. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/run-events.ts#runEvents")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_response_unique")
  (ts := "packages/core/src/db/schema/sessions.ts#sessions_workspace_engine_session_key")
  (ts := "packages/core/src/db/schema/run-tokens.ts#run_tokens_hash_key")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#resuming")]
theorem uniqueness_keys_refuse_a_second_row :
    consistent catalogue (withRow .runEvents eventTwin) = false ∧
      consistent catalogue (withRow .runUsageRecords usageTwin) = false ∧
      consistent catalogue (withRow .sessions sessionTwin) = false ∧
      consistent catalogue (withRow .runTokens tokenTwin) = false := by
  refine ⟨?_, ?_, ?_, ?_⟩
  · cases h : consistent catalogue (withRow .runEvents eventTwin)
    · rfl
    · exact absurd (run_event_sequence_is_unique _ h (e1 := ofCells (runEventCells Witness.event))
        (e2 := eventTwin) (by decide +kernel) (by decide +kernel) (by decide +kernel)
        (by decide +kernel) (by decide +kernel)) (by decide +kernel)
  · cases h : consistent catalogue (withRow .runUsageRecords usageTwin)
    · rfl
    · exact absurd (usage_response_is_recorded_once _ h (u1 := ofCells (usageCells Witness.usage))
        (u2 := usageTwin) (by decide +kernel) (by decide +kernel) (by decide +kernel)
        (by decide +kernel) (by decide +kernel)) (by decide +kernel)
  · cases h : consistent catalogue (withRow .sessions sessionTwin)
    · rfl
    · exact absurd (sdk_session_id_is_unique_per_workspace _ h
        (s1 := ofCells (sessionCells Witness.session)) (s2 := sessionTwin) (by decide +kernel)
        (by decide +kernel) (by decide +kernel) (by decide +kernel) (by decide +kernel))
        (by decide +kernel)
  · cases h : consistent catalogue (withRow .runTokens tokenTwin)
    · rfl
    · exact absurd (run_token_digest_is_unique _ h (t1 := ofCells (runTokenCells Witness.token))
        (t2 := tokenTwin) (by decide +kernel) (by decide +kernel) (by decide +kernel)
        (by decide +kernel)) (by decide +kernel)

/-! ## Run operations preserve the run checks -/

/-- One store operation at instant `now`: the status machine decides whether the run moves
(`Lifecycle.runStep`), and a move writes the timestamps `Run.stamp` gives. -/
@[aw_spec (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")
  (ts := "packages/core/src/db/repositories/runs.ts#finish")]
def timedStep (r : Run) (op : RunOp) (now : Nat) : Run :=
  match runStep r.status op with
  | .moved next => r.stamp next now
  | .noOp | .invalidCall => r

/-- A sequence of store operations, each with the instant the store's clock reads. -/
def timedSteps (r : Run) : List (RunOp × Nat) → Run
  | [] => r
  | (op, now) :: rest => timedSteps (timedStep r op now) rest

/-- The instants never run backwards and start no earlier than `t0`. -/
def clockFrom (t0 : Nat) : List Nat → Bool
  | [] => true
  | t :: ts => t0 ≤ t && clockFrom t ts

private theorem clockFrom_cons (a t : Nat) (ts : List Nat) :
    clockFrom a (t :: ts) = (decide (a ≤ t) && clockFrom t ts) := rfl

private theorem clockFrom_mono {a b : Nat} (hab : b ≤ a) :
    ∀ {ts : List Nat}, clockFrom a ts = true → clockFrom b ts = true
  | [], _ => rfl
  | t :: ts, h => by
    simp only [clockFrom_cons, Bool.and_eq_true, decide_eq_true_eq] at h ⊢
    exact ⟨Nat.le_trans hab h.1, h.2⟩

private theorem stamp_le {r : Run} {now : Nat} (hle : r.lastStamp ≤ now) (op : RunOp) :
    (timedStep r op now).lastStamp ≤ now := by
  unfold timedStep
  split
  · rename_i next _
    unfold Run.lastStamp at hle ⊢
    unfold Run.stamp
    cases hs : r.startedAt <;> cases he : r.endedAt <;>
      simp only [hs, he, Option.getD_some, Option.getD_none] at hle <;>
      split <;> (try split) <;> simp <;> omega
  · exact hle
  · exact hle

private theorem step_well_formed {r : Run} {now : Nat} (hwf : r.wellFormed = true)
    (hle : r.lastStamp ≤ now) (op : RunOp) : (timedStep r op now).wellFormed = true := by
  simp only [Run.wellFormed, Run.endedAtIffTerminal, Run.endedAfterStarted, Run.costNonNegative,
    Run.currencyUsd, Run.priceVersionMatches, Run.unpricedCostZero, Run.pendingWhenAwaiting,
    Run.deadlineWhenAwaiting, Bool.and_eq_true] at hwf ⊢
  obtain ⟨⟨⟨⟨⟨⟨⟨hiff, hafter⟩, hcost⟩, hcur⟩, hprice⟩, hzero⟩, hpend⟩, hdead⟩ := hwf
  unfold Run.lastStamp at hle
  unfold timedStep
  cases op with
  | markRunning =>
    cases hs : r.status <;> simp only [runStep, Run.stamp] <;>
      simp_all [RunStatus.isTerminal, RunStatus.isStopped] <;> cases hst : r.startedAt <;> simp_all
  | finish target =>
    cases hs : r.status <;> cases target <;> simp only [runStep, Run.stamp] <;>
      simp_all [RunStatus.isTerminal, RunStatus.isStopped] <;> cases hst : r.startedAt <;>
      cases hen : r.endedAt <;>
      simp_all <;> omega

/-- Every run check is preserved by every sequence of store operations whose clock never runs
behind the run's own timestamps: `markRunning` and `finish` never produce a row that
`runs_ended_at_iff_terminal` or `runs_ended_after_started` refuses, and leave the accounting
checks untouched. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")
  (ts := "packages/core/src/db/schema/runs.ts#runs_ended_at_iff_terminal")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")]
theorem store_operations_preserve_run_checks :
    ∀ (steps : List (RunOp × Nat)) (r : Run), r.wellFormed = true →
      clockFrom r.lastStamp (steps.map (·.2)) = true → (timedSteps r steps).wellFormed = true
  | [], _, hwf, _ => hwf
  | (op, now) :: rest, r, hwf, hclock => by
    simp only [List.map_cons, clockFrom_cons, Bool.and_eq_true, decide_eq_true_eq] at hclock
    exact store_operations_preserve_run_checks rest (timedStep r op now)
      (step_well_formed hwf hclock.1 op) (clockFrom_mono (stamp_le hclock.1 op) hclock.2)

/-- A run that a `finish` moves to a terminal status always has a duration: "a run that is
finished without ever having been marked running still gets a start". -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")
  (ts := "apps/web/server/runs/api.ts#renderRun")]
theorem finished_run_has_a_duration (r : Run) (target : RunStatus) (now : Nat)
    (hlive : r.status.isTerminal = false) (hterm : target.isTerminal = true) :
    (timedStep r (.finish target) now).durationMs.isSome = true := by
  unfold timedStep
  simp only [runStep, hterm, hlive, Bool.not_true, Bool.false_eq_true, ite_false]
  simp [Run.stamp, hterm, Run.durationMs]

/-- What each store operation writes, status by status: `markRunning` on a queued run moves it to
`running` and stamps `startedAt` with the store's clock (and nothing else); `finish` with a
terminal target on a live run moves it there, stamps `endedAt`, and stamps `startedAt` only if
the run never had one; every other call writes nothing, because the store refuses it (`markRunning`
on a non-queued run answers `false`, `finish` with a non-terminal target rejects or throws) or
ignores it (`finish` on an already terminal run). -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/store.ts#RunStore")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")
  (ts := "packages/core/src/db/repositories/runs.ts#markRunning")
  (ts := "packages/core/src/db/repositories/runs.ts#finish")]
theorem store_stamps_follow_the_status (r : Run) (target : RunStatus) (now : Nat) :
    (r.status = .queued →
        timedStep r .markRunning now = { r with status := .running, startedAt := some now }) ∧
      (r.status ≠ .queued → timedStep r .markRunning now = r) ∧
      (r.status.isTerminal = false → target.isTerminal = true →
        timedStep r (.finish target) now =
          { r with status := target, startedAt := some (r.startedAt.getD now),
                   endedAt := some now }) ∧
      (r.status.isTerminal = true ∨ target.isTerminal = false →
        timedStep r (.finish target) now = r) := by
  refine ⟨fun hq => ?_, fun hq => ?_, fun hlive hterm => ?_, fun h => ?_⟩
  · simp [timedStep, runStep, hq, Run.stamp, RunStatus.isTerminal]
  · simp [timedStep, runStep, hq]
  · simp [timedStep, runStep, hlive, hterm, Run.stamp]
  · rcases h with h | h
    · by_cases ht : target.isTerminal = true
      · simp [timedStep, runStep, h, ht]
      · simp [timedStep, runStep, ht]
    · simp [timedStep, runStep, h]

/-- The model's durations are exact: every run the store operations produce from a well-formed
run (with a clock that never runs backwards) ends no earlier than it starts, so the natural-number
`durationMs` is the integer difference `endedAt - startedAt` that `renderRun` computes, never a
truncated negative one. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/runs/api.ts#renderRun")
  (ts := "packages/core/src/db/schema/runs.ts#runs_ended_after_started")]
theorem store_durations_are_exact (steps : List (RunOp × Nat)) (r : Run)
    (hwf : r.wellFormed = true) (hclock : clockFrom r.lastStamp (steps.map (·.2)) = true)
    {s e d : Nat} (hs : (timedSteps r steps).startedAt = some s)
    (he : (timedSteps r steps).endedAt = some e) (hd : (timedSteps r steps).durationMs = some d) :
    s ≤ e ∧ (d : Int) = (e : Int) - (s : Int) := by
  have h := store_operations_preserve_run_checks steps r hwf hclock
  simp only [Run.wellFormed, Run.endedAfterStarted, hs, he, Bool.and_eq_true,
    decide_eq_true_eq] at h
  have hle : s ≤ e := h.1.1.1.1.1.1.2
  simp only [Run.durationMs, hs, he, Option.some.injEq] at hd
  subst hd
  exact ⟨hle, by omega⟩

/-! ## The event log: append and prune -/

/-- The sequence the repository allocates next: one past the run's largest stored sequence, or
`1` for a run with none (`max(runEvents.sequence) + 1`). -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs/events.ts#createDatabaseRunEventRepositoryProvider")]
def nextSequence (events : List RunEvent) (run : RunId) : Nat :=
  (sequencesOf events run).foldl max 0 + 1

/-- The event the repository inserts: the run's next sequence, in the caller's workspace. -/
def nextEvent (events : List RunEvent) (run : RunId) (workspace : WorkspaceId)
    (type data : String) (now : Nat) : RunEvent :=
  { key := ⟨run, nextSequence events run⟩, workspace, type, data, createdAt := now }

/-- The repository's `append` on the stored events of one table: insert the next event, then,
when `cutoff = next - maxEvents` is positive, delete the run's events at or below it. -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs/events.ts#createDatabaseRunEventRepositoryProvider")
  (ts := "packages/core/src/db/schema/run-events.ts#runEvents")]
def appendEvent (events : List RunEvent) (run : RunId) (workspace : WorkspaceId)
    (type data : String) (now maxEvents : Nat) : List RunEvent :=
  let cutoff := nextSequence events run - maxEvents
  let inserted := events ++ [nextEvent events run workspace type data now]
  if 0 < cutoff then
    inserted.filter fun ev => !(ev.key.run == run && decide (ev.key.sequence ≤ cutoff))
  else inserted

private theorem foldl_max_range' : ∀ (n s acc : Nat), acc < s →
    (List.range' s n).foldl max acc = if n = 0 then acc else s + n - 1
  | 0, _, _, _ => by simp
  | n + 1, s, acc, h => by
    rw [List.range'_succ, List.foldl_cons, show max acc s = s by omega,
      foldl_max_range' n (s + 1) s (by omega)]
    simp only [Nat.add_one_ne_zero, ite_false]
    split <;> omega

private theorem window_shape : ∀ {l : List Nat}, isWindow l = true → l ≠ [] →
    ∃ lo n, 1 ≤ lo ∧ l = lo :: List.range' (lo + 1) n
  | [], _, h => absurd rfl h
  | lo :: rest, hw, _ => by
    simp only [isWindow, Bool.and_eq_true, decide_eq_true_eq, beq_iff_eq] at hw
    exact ⟨lo, rest.length, hw.1, by rw [← hw.2]⟩

private theorem window_of_shape (lo n : Nat) (h : 1 ≤ lo) :
    isWindow (lo :: List.range' (lo + 1) n) = true := by
  simp [isWindow, h]

private theorem window_extend (l : List Nat) (h : isWindow l = true) :
    isWindow (l ++ [l.foldl max 0 + 1]) = true := by
  by_cases hnil : l = []
  · subst hnil; decide +kernel
  · obtain ⟨lo, n, hlo, hl⟩ := window_shape h hnil
    rw [hl, List.foldl_cons, show max 0 lo = lo by omega,
      foldl_max_range' n (lo + 1) lo (by omega), List.cons_append]
    have : (if n = 0 then lo else lo + 1 + n - 1) + 1 = lo + 1 + 1 * n := by split <;> omega
    rw [this, ← List.range'_concat]
    exact window_of_shape lo (n + 1) hlo

private theorem window_filter_shape (c : Nat) : ∀ (n lo : Nat), 1 ≤ lo →
    isWindow ((lo :: List.range' (lo + 1) n).filter fun m => !decide (m ≤ c)) = true
  | n, lo, hlo => by
    by_cases hc : c < lo
    · rw [List.filter_eq_self.mpr]
      · exact window_of_shape lo n hlo
      · intro m hm
        simp only [List.mem_cons, List.mem_range'_1] at hm
        simp; omega
    · rw [List.filter_cons_of_neg (by simp; omega)]
      cases n with
      | zero => simp [isWindow]
      | succ m =>
        rw [List.range'_succ]
        exact window_filter_shape c m (lo + 1) (by omega)

private theorem window_filter (c : Nat) (l : List Nat) (h : isWindow l = true) :
    isWindow (l.filter fun m => !decide (m ≤ c)) = true := by
  by_cases hnil : l = []
  · subst hnil; rfl
  · obtain ⟨lo, n, hlo, hl⟩ := window_shape h hnil
    rw [hl]; exact window_filter_shape c n lo hlo

private theorem seq_append (events : List RunEvent) (e : RunEvent) (run : RunId) :
    sequencesOf (events ++ [e]) run =
      sequencesOf events run ++ (if e.key.run = run then [e.key.sequence] else []) := by
  unfold sequencesOf
  by_cases h : e.key.run = run <;> simp [List.filter_append, h]

private theorem seq_prune (events : List RunEvent) (run run' : RunId) (c : Nat) :
    sequencesOf (events.filter fun ev => !(ev.key.run == run && decide (ev.key.sequence ≤ c)))
        run' =
      if run' = run then (sequencesOf events run').filter (fun m => !decide (m ≤ c))
      else sequencesOf events run' := by
  unfold sequencesOf
  induction events with
  | nil => split <;> rfl
  | cons ev rest ih =>
    by_cases h1 : ev.key.run = run' <;> by_cases h2 : run' = run <;>
      by_cases h3 : ev.key.sequence ≤ c <;> by_cases h4 : ev.key.run = run <;> simp_all

/-- The repository's `append` keeps every run's stored event log contiguous: allocating
`max(sequence) + 1` extends the appending run's window by one, pruning its events at or below
`next - maxEvents` cuts the window from below and leaves it a window, and no other run's
events change ("assigning one contiguous sequence per run"). -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/runs/events.ts#createDatabaseRunEventRepositoryProvider")
  (ts := "packages/core/src/db/schema/run-events.ts#runEvents")]
theorem appending_an_event_keeps_every_log_contiguous (events : List RunEvent) (run run' : RunId)
    (ws : WorkspaceId) (type data : String) (now maxEvents : Nat)
    (h : logContiguous events run' = true) :
    logContiguous (appendEvent events run ws type data now maxEvents) run' = true := by
  unfold logContiguous at h ⊢
  have hins : isWindow (sequencesOf (events ++ [nextEvent events run ws type data now]) run')
      = true := by
    rw [seq_append]
    by_cases hr : run = run'
    · subst hr
      have hk : (nextEvent events run ws type data now).key.run = run := rfl
      simp only [hk, ↓reduceIte]
      exact window_extend _ h
    · have hk : ((nextEvent events run ws type data now).key.run = run') = False :=
        propext ⟨hr, False.elim⟩
      simp only [hk, ↓reduceIte, List.append_nil]
      exact h
  unfold appendEvent
  simp only
  split
  · rw [seq_prune]
    split
    · exact window_filter _ _ hins
    · exact hins
  · exact hins

/-- Two runs' events interleaved in one table: run `ra` holds 1, 2, 3 and run `rb` holds 5, 6. -/
private def interleavedLog : List RunEvent :=
  [(⟨"ra"⟩, 1), (⟨"rb"⟩, 5), (⟨"ra"⟩, 2), (⟨"rb"⟩, 6), (⟨"ra"⟩, 3)].map fun (run, n) =>
    { key := ⟨run, n⟩, workspace := ⟨"w1"⟩, type := runStatusEvent, data := "{}", createdAt := n }

/-- Appending to `ra` with room for three events allocates 4 and prunes 1, and leaves `rb`'s
events alone. -/
example : sequencesOf (appendEvent interleavedLog ⟨"ra"⟩ ⟨"w1"⟩ "result" "{}" 9 3) ⟨"ra"⟩ =
      [2, 3, 4] ∧
    sequencesOf (appendEvent interleavedLog ⟨"ra"⟩ ⟨"w1"⟩ "result" "{}" 9 3) ⟨"rb"⟩ = [5, 6] := by
  decide +kernel

example := appending_an_event_keeps_every_log_contiguous interleavedLog ⟨"ra"⟩ ⟨"rb"⟩ ⟨"w1"⟩
  "result" "{}" 9 3 (by decide +kernel)

/-- The repository's `append` prunes exactly at the cutoff: once `cutoff = next - maxEvents` is
positive, every event the run keeps has a sequence above it; and with room for at least one
event, the event just appended is always kept. Together with contiguity this bounds a run's
stored log to its newest `maxEvents` events. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/repositories/runs/events.ts#createDatabaseRunEventRepositoryProvider")]
theorem append_prunes_at_the_cutoff_and_keeps_the_newest (events : List RunEvent)
    (run : RunId) (ws : WorkspaceId) (type data : String) (now maxEvents : Nat) :
    (0 < nextSequence events run - maxEvents →
        ∀ s ∈ sequencesOf (appendEvent events run ws type data now maxEvents) run,
          nextSequence events run - maxEvents < s) ∧
      (0 < maxEvents →
        nextSequence events run ∈ sequencesOf (appendEvent events run ws type data now maxEvents)
          run) := by
  have hk : (nextEvent events run ws type data now).key.run = run := rfl
  have hq : (nextEvent events run ws type data now).key.sequence = nextSequence events run := rfl
  refine ⟨fun hc s hs => ?_, fun hm => ?_⟩
  · unfold appendEvent at hs
    simp only [hc, ↓reduceIte, seq_prune, List.mem_filter] at hs
    have := hs.2
    simp only [Bool.not_eq_eq_eq_not, Bool.not_true, decide_eq_false_iff_not] at this
    omega
  · unfold appendEvent
    simp only
    split
    · simp only [seq_prune, ↓reduceIte, List.mem_filter, seq_append, hk, hq, List.mem_append,
        List.mem_singleton, or_true, true_and, Bool.not_eq_eq_eq_not, Bool.not_true,
        decide_eq_false_iff_not]
      omega
    · simp [seq_append, hk, hq]

/-- With room for three events, appending to `ra` (next sequence 4) keeps only sequences above
the cutoff 1, and keeps the new event. -/
example := append_prunes_at_the_cutoff_and_keeps_the_newest interleavedLog ⟨"ra"⟩ ⟨"w1"⟩
  "result" "{}" 9 3

/-! ## The session identity -/

/-- Recording the SDK's reported session id keeps today's identity invariant (the SDK id is the
platform id), and makes an active session resumable. -/
@[aw_spec (tier := T2)
  (ts := "apps/web/server/composition/session-launch.ts#recordReportedSessionIdentity")]
theorem recording_keeps_the_session_identity (s s' : Session) (reported : String)
    (h : s.recordReported reported = some s') :
    s'.identityCurrent = true ∧ s'.engineSessionId = some s.id.val ∧
      s'.resumable = (s.status == .active) := by
  unfold Session.recordReported at h
  split at h
  · rename_i heq
    simp only [Option.some.injEq] at h
    subst h
    have : reported = s.id.val := by simpa using heq
    subst this
    simp [Session.identityCurrent, Session.resumable]
  · cases h

/-! ## Witnesses -/

private theorem witness_work : workConsistent Witness.state = true :=
  work_constraints_are_satisfiable.1

private theorem witness : consistent catalogue Witness.state = true :=
  consistent_of_work witness_work

example : tenantOf catalogue .runs (ofCells (runCells Witness.run)) =
    tenantOf catalogue .sessions (ofCells (sessionCells Witness.session)) :=
  runs_session_workspace_fk_preserves_tenant Witness.state witness
    (by unfold References; decide +kernel)

example : ofCells (runEventCells Witness.event) = ofCells (runEventCells Witness.event) :=
  run_event_sequence_is_unique Witness.state witness (by decide +kernel) (by decide +kernel) rfl rfl
    (by decide +kernel)

example : ofCells (usageCells Witness.usage) = ofCells (usageCells Witness.usage) :=
  usage_response_is_recorded_once Witness.state witness (by decide +kernel) (by decide +kernel) rfl
    rfl (by decide +kernel)

example : ofCells (sessionCells Witness.session) = ofCells (sessionCells Witness.session) :=
  sdk_session_id_is_unique_per_workspace Witness.state witness (by decide +kernel)
    (by decide +kernel) rfl rfl (by decide +kernel)

example : ofCells (runTokenCells Witness.token) = ofCells (runTokenCells Witness.token) :=
  run_token_digest_is_unique Witness.state witness (by decide +kernel) (by decide +kernel) rfl
    (by decide +kernel)

/-- A queued run, started at 7 and cancelled at 8, stays well formed. -/
example : (timedSteps Witness.queuedRun [(.markRunning, 7), (.finish .cancelled, 8)]).wellFormed =
    true :=
  store_operations_preserve_run_checks _ _ (by decide +kernel) (by decide +kernel)

example : (timedStep Witness.queuedRun (.finish .cancelled) 7).durationMs.isSome = true :=
  finished_run_has_a_duration Witness.queuedRun .cancelled 7 rfl rfl

/-- The queued witness run, marked running at 7: status `running`, `startedAt = 7`. -/
example : timedStep Witness.queuedRun .markRunning 7 =
    { Witness.queuedRun with status := .running, startedAt := some 7 } :=
  (store_stamps_follow_the_status Witness.queuedRun .cancelled 7).1 rfl

/-- Cancelling the queued witness run at 7 also gives it a start at 7. -/
example : timedStep Witness.queuedRun (.finish .cancelled) 7 =
    { Witness.queuedRun with status := .cancelled, startedAt := some 7, endedAt := some 7 } :=
  (store_stamps_follow_the_status Witness.queuedRun .cancelled 7).2.2.1 rfl rfl

/-- A second `markRunning` on the completed witness run changes nothing. -/
example : timedStep Witness.run .markRunning 20 = Witness.run :=
  (store_stamps_follow_the_status Witness.run .cancelled 20).2.1 (by decide +kernel)

example : timedStep Witness.run (.finish .failed) 20 = Witness.run :=
  (store_stamps_follow_the_status Witness.run .failed 20).2.2.2 (.inl rfl)

/-- Started at 7 and cancelled at 8: a duration of exactly 1. -/
example : (1 : Int) = (8 : Int) - (7 : Int) :=
  (store_durations_are_exact [(.markRunning, 7), (.finish .cancelled, 8)] Witness.queuedRun
    (by decide +kernel) (by decide +kernel) (by decide +kernel) (by decide +kernel) (by decide +kernel)).2

example : Witness.session.identityCurrent = true :=
  (recording_keeps_the_session_identity { Witness.session with engineSessionId := none }
    Witness.session "s1" (by decide +kernel)).1

end AgentWorkspace.Theorems.Invariants.ConceptWork
