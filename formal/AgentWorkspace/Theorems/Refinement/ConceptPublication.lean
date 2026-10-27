import AgentWorkspace.Theorems.Invariants.ConceptPublication

/-!
T4 — today's publication tables against the Target reading.

`Target.consistent` adds three constraints the service maintains or the documents promise but no
database constraint enforces: an agent share always has a mode, only a runnable share has a
budget, and `shares.subject_id` names a subject row of the share's own workspace. The Target
refines the Current reading (every target state is a current state), the service's shares meet
the two row-local target checks, and the Current reading diverges at exactly the stated points:
each has a consistent current state that the Target refuses.
-/

namespace AgentWorkspace.Theorems.Refinement.ConceptPublication

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Share
open AgentWorkspace.Er.Current
open AgentWorkspace.Theorems.Invariants.ConceptPublication (share_row_encodes_fields)
open AgentWorkspace.Theorems.Invariants.ConceptPublication.Witness (stateWith)

/-- Every state the Target reading admits is a state today's schema admits: the Target only adds
constraints. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem target_refines_current (st : State) (h : Publication.Target.consistent st = true) :
    Publication.consistent st = true := by
  unfold Publication.Target.consistent at h
  exact ((Bool.and_eq_true _ _).mp h).1

/-- A share as the service publishes it meets the two row-local Target checks: it has a mode when
it is an agent share, and a budget only when it is runnable. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
theorem well_published_share_meets_the_target_checks (s : Share) (h : s.wellPublished = true) :
    Publication.Target.agentHasMode s.toRow = true ∧
      Publication.Target.budgetOnlyRunnable s.toRow = true := by
  obtain ⟨hst, hm, hb, -⟩ := share_row_encodes_fields s
  simp only [Share.wellPublished, Bool.and_eq_true, beq_iff_eq] at h
  obtain ⟨⟨⟨⟨-, hmode⟩, hbud⟩, -⟩, -⟩ := h
  simp only [Publication.Target.agentHasMode, Publication.Target.budgetOnlyRunnable, hst, hm, hb]
  constructor
  · cases hs : s.subjectType <;> cases hmo : s.mode <;> simp_all [SubjectType.toWire]
  · cases hbc : s.budgetCapUsd <;> cases hmo : s.mode <;> simp_all
    rename_i m
    cases m <;> simp_all [Mode.toWire]

/-- The witness state (a runnable agent share of an existing agent) meets the Target. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem witness_state_meets_the_target :
    Publication.Target.consistent Invariants.ConceptPublication.Witness.state = true := by
  decide +kernel

/-- An agent share without a mode is consistent today but refused by the Target: the database
lets `mode` be `NULL` on an agent share, although the service always writes one. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "apps/web/server/shares/core/service.ts#ShareService")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
theorem current_admits_an_agent_share_without_mode :
    let st := stateWith [{ Invariants.ConceptPublication.Witness.share with
      mode := none, budgetCapUsd := none }.toRow]
    Publication.consistent st = true ∧ Publication.Target.consistent st = false := by
  decide +kernel

/-- A definition share with a budget cap is consistent today but refused by the Target: no check
ties `budget_cap_usd` to `mode = 'runnable'`. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")
  (doc := "docs/spec.md#2063-publishing-an-agent")]
theorem current_admits_a_budget_on_a_definition_share :
    let st := stateWith [{ Invariants.ConceptPublication.Witness.share with
      mode := some .definition }.toRow]
    Publication.consistent st = true ∧ Publication.Target.consistent st = false := by
  decide +kernel

/-- A share whose subject id names no row is consistent today but refused by the Target:
`shares.subject_id` is polymorphic text with no foreign key. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "apps/web/server/composition/wiring/projects.ts#subjectOwnership")
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#beyond-one-workspace")]
theorem current_admits_a_dangling_subject :
    let st := stateWith [{ Invariants.ConceptPublication.Witness.share with
      subjectId := "missing" }.toRow]
    Publication.consistent st = true ∧ Publication.Target.consistent st = false := by
  decide +kernel

/-- A share that names an existing agent's id as a session is consistent today but refused by the
Target: nothing ties `subject_id` to the table `subject_type` names. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
theorem current_admits_a_subject_of_the_wrong_type :
    let st := stateWith [{ Invariants.ConceptPublication.Witness.share with
      subjectType := .session, mode := none, budgetCapUsd := none }.toRow]
    Publication.consistent st = true ∧ Publication.Target.consistent st = false := by
  decide +kernel

/-- The witness state extended with a second workspace's member, principal and agent `a2`. -/
private def crossState (rows : List Row) : State
  | .memberships => stateWith rows .memberships ++
    [⟨[("id", "m2"), ("workspace_id", "w2"), ("user_id", "u1"), ("role", "owner"),
       ("created_at", "0"), ("updated_at", "0")]⟩]
  | .workspacePrincipals => stateWith rows .workspacePrincipals ++
    [⟨[("id", "p2"), ("workspace_id", "w2"), ("kind", "membership"), ("membership_id", "m2"),
       ("activated_at", "0"), ("created_at", "0")]⟩]
  | .agents => stateWith rows .agents ++
    [⟨[("id", "a2"), ("workspace_id", "w2"), ("name", "Other"), ("instructions", "Help."),
       ("permissions", "{}"), ("created_by", "u1"), ("owner_principal_id", "p2"),
       ("created_at", "0"), ("updated_at", "0")]⟩]
  | t => stateWith rows t

/-- A share of workspace `w1` that names agent `a2` of workspace `w2` is consistent today but
refused by the Target: nothing ties `subject_id` to a subject of the share's own workspace, so the
Target's same-workspace conjunct is what refuses it. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "apps/web/server/composition/wiring/projects.ts#subjectOwnership")
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#beyond-one-workspace")]
theorem current_admits_a_cross_workspace_subject :
    let st := crossState [{ Invariants.ConceptPublication.Witness.share with
      subjectId := "a2" }.toRow]
    Publication.consistent st = true ∧ Publication.Target.consistent st = false ∧
      Publication.Target.subjectResolves (crossState [])
        { Invariants.ConceptPublication.Witness.share with subjectId := "a2", workspace := ⟨"w2"⟩ }.toRow
        = true := by
  decide +kernel

example : Publication.consistent Invariants.ConceptPublication.Witness.state = true :=
  target_refines_current _ witness_state_meets_the_target

example : Publication.Target.agentHasMode Invariants.ConceptPublication.Witness.share.toRow = true ∧
    Publication.Target.budgetOnlyRunnable Invariants.ConceptPublication.Witness.share.toRow = true :=
  well_published_share_meets_the_target_checks _ (by decide +kernel)

end AgentWorkspace.Theorems.Refinement.ConceptPublication
