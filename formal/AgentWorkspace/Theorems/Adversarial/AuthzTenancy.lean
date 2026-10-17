import AgentWorkspace.Theorems.Normative.AuthzTenancy

/-!
T3 — what a principal of one workspace cannot learn or reach in another, over **all** attacker
inputs: a forged scope is refused; a scoped read and every run route answer the same whatever
another workspace holds (so a foreign run is indistinguishable from an absent one); the
workspace-route resolvers answer the same whatever workspaces the caller does not belong to; and no
key the object store accepts has a segment (`..`, `.`, empty, the metadata marker) that could step
outside the workspace root.
-/

namespace AgentWorkspace.Theorems.Adversarial.AuthzTenancy

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Authz.Tenancy
  AgentWorkspace.Authz.Decide

/-- A value `WorkspaceScope` did not mint — a cast object literal, an
`Object.create(WorkspaceScope.prototype)`, anything that is not an object — is refused by
`requireWorkspaceScope`, whatever workspace id it carries; only a minted scope passes, unchanged. -/
@[aw_spec (tier := T3) (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")
  (ts := "packages/core/src/db/repositories/scope.ts#requireWorkspaceScope")
  (ts := "packages/core/src/db/repositories/scope-forgery.test.ts")]
theorem forged_scope_is_refused (v : ScopeValue) (s : WorkspaceScope)
    (h : requireWorkspaceScope v = some s) : v = .minted s := by
  cases v with
  | minted s' =>
    simp only [requireWorkspaceScope, isWorkspaceScope, ScopeValue.carried, ite_true,
      Option.map_some, Option.some.injEq] at h
    subst h
    rfl
  | castLiteral w => simp [requireWorkspaceScope, isWorkspaceScope] at h
  | prototypeInstance w => simp [requireWorkspaceScope, isWorkspaceScope] at h
  | notAnObject => simp [requireWorkspaceScope, isWorkspaceScope] at h

/-- A scoped read cannot observe another workspace: two states that agree on workspace `ws`'s
rows of a table give every read scoped to `ws` the same answer, whatever else they hold. -/
@[aw_spec (tier := T3) (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")
  (ts := "packages/core/src/db/repositories/scope.ts#WorkspaceScope")]
theorem scoped_read_is_blind_to_other_workspaces (st₁ st₂ : State) (t : TableName) (ws : String)
    (p : Row → Bool) (h : workspaceView st₁ t ws = workspaceView st₂ t ws) :
    scopedSelect st₁ ⟨ws⟩ t p = scopedSelect st₂ ⟨ws⟩ t p := by
  have e : ∀ st : State, scopedSelect st ⟨ws⟩ t p = (workspaceView st t ws).filter p := by
    intro st
    simp only [scopedSelect, workspaceView, List.filter_filter]
    congr 1
    funext r
    exact Bool.and_comm _ _
  rw [e, e, h]

/-- No run route lets a caller observe another workspace's runs: two states whose runs of the
caller's workspace are the same give every run route the same answer, for every route, caller,
run id and continuation. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (doc := "docs/adr/W1-CP-04-start-run-request-shape.md#decision")
  (ts := "apps/web/server/runs/api.ts#findRunForPrincipal")]
theorem run_route_sees_only_the_callers_workspace {α : Type} (route : RunRoute) (st₁ st₂ : State)
    (caller : RunCaller) (runId : String) (k : Row → Except RunProblem α)
    (hd₁ : IdsDistinct (st₁ .runs)) (hd₂ : IdsDistinct (st₂ .runs))
    (h : workspaceView st₁ .runs caller.workspaceId = workspaceView st₂ .runs caller.workspaceId) :
    runRoute route st₁ caller runId k = runRoute route st₂ caller runId k := by
  unfold runRoute
  rw [Normative.AuthzTenancy.run_lookup_is_scoped_to_the_caller _ _ _ hd₁,
    Normative.AuthzTenancy.run_lookup_is_scoped_to_the_caller _ _ _ hd₂, h]

/-- A run of another workspace is indistinguishable from no run at all: adding a foreign run row
(with any id, including the one asked for) changes no run route's answer. -/
@[aw_spec (tier := T3) (doc := "docs/adr/W1-CP-04-start-run-request-shape.md#decision")
  (doc := "docs/sdk/04-api-specification.md#4-conventions")
  (ts := "apps/web/server/runs/api.ts#findRunForPrincipal")]
theorem foreign_run_is_indistinguishable_from_absent {α : Type} (route : RunRoute) (st : State)
    (caller : RunCaller) (runId : String) (k : Row → Except RunProblem α) (r : Row)
    (hforeign : rowTenant .runs r ≠ some caller.workspaceId)
    (hd : IdsDistinct (addRow st .runs r .runs)) :
    runRoute route (addRow st .runs r) caller runId k = runRoute route st caller runId k := by
  have hst : addRow st .runs r .runs = st .runs ++ [r] := by simp [addRow]
  have hd' : IdsDistinct (st .runs) := by
    rw [hst] at hd
    exact (List.pairwise_append.mp hd).1
  refine run_route_sees_only_the_callers_workspace route _ _ caller runId k hd hd' ?_
  simp only [workspaceView, hst, List.filter_append, List.filter_cons, List.filter_nil]
  have : (rowTenant .runs r == some caller.workspaceId) = false := by
    simpa using hforeign
  simp [this]

private theorem getForMember_eq (repo : WorkspaceRepo)
    (hc : ∀ m ∈ repo.members, repo.workspaces.contains m.workspaceId = true) (id u : String) :
    getForMember repo id u =
      ((repo.members.filter (·.userId == u)).find? (·.workspaceId == id)).map (·.role) := by
  rw [List.find?_filter]
  unfold getForMember
  split
  · congr 1
    congr 1
    funext m
    cases m.workspaceId == id <;> cases m.userId == u <;> decide
  · rename_i hn
    symm
    rw [Option.map_eq_none_iff, List.find?_eq_none]
    intro m hm hq
    simp only [beq_iff_eq, decide_eq_true_eq] at hq
    exact hn (hq.2 ▸ hc m hm)

/-- The workspace routes cannot be used to enumerate workspaces: two repositories that hold the
same memberships for the caller give both resolvers the same answer, however many other
workspaces (or other people's memberships) either holds — "no such workspace" and "not a member"
are one `404`. -/
@[aw_spec (tier := T3) (doc := "docs/adr/W9-WS-119-workspace-resource-authorisation-and-lifecycle.md")
  (ts := "apps/web/server/workspaces/access.ts#memberOwnershipResolver")
  (ts := "packages/core/src/db/repositories/workspaces.ts#getForMember")]
theorem workspace_resolvers_conceal_foreign_workspaces (repo₁ repo₂ : WorkspaceRepo) (id : String)
    (p : RequestPrincipal) (directory : List MemberSummary)
    (hc₁ : ∀ m ∈ repo₁.members, repo₁.workspaces.contains m.workspaceId = true)
    (hc₂ : ∀ m ∈ repo₂.members, repo₂.workspaces.contains m.workspaceId = true)
    (hagree : ∀ u, resolveMemberUserId directory p.actor = some u →
      repo₁.members.filter (·.userId == u) = repo₂.members.filter (·.userId == u)) :
    memberResolver repo₁ id p directory = memberResolver repo₂ id p directory ∧
      ownerResolver repo₁ id p directory = ownerResolver repo₂ id p directory := by
  have hv : resolveMembershipView repo₁ id p directory = resolveMembershipView repo₂ id p directory := by
    unfold resolveMembershipView
    split
    · rfl
    · split
      · rfl
      · split
        · rfl
        · rename_i u hu
          rw [getForMember_eq repo₁ hc₁, getForMember_eq repo₂ hc₂, hagree u hu]
  simp only [memberResolver, ownerResolver, hv]
  exact ⟨trivial, trivial⟩

private theorem segmentRule_cons (s : List Char) (rest : List (List Char)) :
    segmentRule (s :: rest) =
      if s.isEmpty then some .emptySegment
      else if s == ['.'] || s == ['.', '.'] then some .dotSegment
      else if containsReservedMarker s then some .reservedName
      else segmentRule rest := rfl

private theorem segmentRule_none :
    ∀ segs : List (List Char), segmentRule segs = none →
      ∀ seg ∈ segs, seg ≠ [] ∧ seg ≠ ['.'] ∧ seg ≠ ['.', '.'] ∧ containsReservedMarker seg = false
  | [], _, _, h => by cases h
  | s :: rest, hr, seg, hm => by
    rw [segmentRule_cons] at hr
    split at hr
    · cases hr
    · rename_i he
      split at hr
      · cases hr
      · rename_i hd
        split at hr
        · cases hr
        · rename_i hc
          rcases List.mem_cons.mp hm with rfl | hm'
          · simp only [Bool.or_eq_true, beq_iff_eq, not_or] at hd
            refine ⟨fun h => he (by simp [h]), hd.1, hd.2, by simpa using hc⟩
          · exact segmentRule_none rest hr seg hm'

/-- A key or prefix the object store accepts cannot step outside the workspace root, whatever the
caller sends: a non-empty accepted key has no empty segment, no `.` or `..` segment, and no segment
spelling the reserved metadata marker in any case. -/
@[aw_spec (tier := T3) (doc := "docs/adr/W2-CP-03-object-key-safety.md#decision")
  (ts := "packages/core/src/storage/key-safety.ts#evaluateRelativePath")]
theorem accepted_key_cannot_escape_the_workspace_root (raw : String) (allowRoot : Bool) (k : String)
    (h : keyGuard raw allowRoot = .ok k) (hne : raw ≠ "") :
    ∀ seg ∈ Authz.Surface.splitSlash raw.toList,
      seg ≠ [] ∧ seg ≠ ['.'] ∧ seg ≠ ['.', '.'] ∧ containsReservedMarker seg = false := by
  have hcs : raw.toList.isEmpty = false := by
    cases hl : raw.toList with
    | nil => exact absurd (String.toList_injective (hl.trans String.toList_empty.symm)) hne
    | cons _ _ => rfl
  unfold keyGuard at h
  dsimp only at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · split at h
        · cases h
        · split at h
          · cases h
          · rw [hcs] at h
            simp only [Bool.false_eq_true, ite_false] at h
            split at h
            · cases h
            · rename_i hseg
              exact segmentRule_none _ hseg

/-! ## Witnesses -/

example : keyGuard "a/b.md" false = .ok "a/b.md" ∧ "a/b.md" ≠ "" := ⟨rfl, by decide⟩

private def oneRun : State
  | .runs => [⟨[("id", "r1"), ("workspace_id", "w1")]⟩]
  | _ => []

example : rowTenant .runs ⟨[("id", "r1"), ("workspace_id", "w2")]⟩ ≠ some "w1" ∧
    IdsDistinct (addRow oneRun .runs ⟨[("id", "r2"), ("workspace_id", "w2")]⟩ .runs) := by decide

example : workspaceView oneRun .runs "w1" =
    workspaceView (addRow oneRun .runs ⟨[("id", "r2"), ("workspace_id", "w2")]⟩) .runs "w1" := by decide

example : requireWorkspaceScope (.minted ⟨"w1"⟩) = some ⟨"w1"⟩ := by decide

example : ∀ m ∈ ([⟨"w", "u", "owner"⟩] : List WorkspaceMember), (["w"] : List String).contains m.workspaceId = true := by
  decide

end AgentWorkspace.Theorems.Adversarial.AuthzTenancy
