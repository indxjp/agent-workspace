import AgentWorkspace.Theorems.Normative.AuthzTenancy

/-!
T4 — the two implementations and the two acceptance rules, related: the database run store's
lookup (one unscoped workspace-id query, then a scoped read) answers what the in-memory store's
does; the in-memory scope resolver answers what the database one does, by id and by slug (where
a later row with a repeated slug wins, as in a `Map`); and the object store's
workspace-id rule today (`…Current`, non-blank) agrees with the intended one (`…Target`, one key
segment) on every real workspace id, and diverges exactly where an id contains `/`, which lets
two workspaces address the same key.
-/

namespace AgentWorkspace.Theorems.Refinement.AuthzTenancy

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Authz.Tenancy

/-- With run ids unique, the database store's lookup (`findRunWorkspace`, then the scoped
repository) followed by the route's workspace check answers exactly what the in-memory store's
`findRunForPrincipal` does: `findRunWorkspace`'s one unscoped query decides nothing. -/
@[aw_spec (tier := T4) (doc := "docs/adr/W2-DB-02-the-run-port-is-not-scope-bound.md#decision")
  (ts := "packages/core/src/db/repositories/runs.ts#findRunWorkspace")
  (ts := "apps/web/server/runs/repository-store.ts#createRepositoryRunStore")]
theorem database_run_lookup_refines_memory_lookup (st : State) (ws runId : String)
    (hd : IdsDistinct (st .runs)) :
    ((dbStoreGet st runId).bind fun r => if colIs r "workspace_id" ws then some r else none) =
      findRunForPrincipal st ws runId := by
  have hdb : ∀ w, (scopedSelect st ⟨w⟩ .runs (colIs · "id" runId)).head? =
      findRunForPrincipal st w runId := by
    intro w
    rw [Normative.AuthzTenancy.run_lookup_is_scoped_to_the_caller _ _ _ hd, workspaceView,
      List.find?_filter]
    unfold scopedSelect
    rw [List.head?_filter]
    congr 1
    funext x
    cases rowTenant .runs x == some w <;> cases h : colIs x "id" runId <;> simp [h]
  unfold dbStoreGet findRunWorkspace
  cases hs : storeGet st runId with
  | none => simp [findRunForPrincipal, hs]
  | some r =>
    cases hw : r.get "workspace_id" with
    | none => simp [findRunForPrincipal, hs, hw, colIs]
    | some w =>
      simp only [Option.bind_some, hw]
      rw [hdb w]
      unfold findRunForPrincipal
      rw [hs]
      simp only [Option.bind_some, colIs, hw]
      by_cases hww : w = ws
      · subst hww; simp [hw]
      · have : (some w == some ws) = false := by simpa using hww
        simp [this, hw, hww]

/-- The in-memory scope resolver answers by id exactly what the database resolver does, over the
workspaces of any state whose rows all carry a slug (`workspaces.slug` is `NOT NULL`). -/
@[aw_spec (tier := T4) (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")
  (ts := "packages/core/src/db/repositories/scope.ts#inMemoryResolver")
  (ts := "packages/core/src/db/repositories/scope.ts#databaseResolver")]
theorem in_memory_resolver_refines_database_resolver (st : State)
    (hslug : ∀ r ∈ st .workspaces, (r.get "slug").isSome = true) (id : String) :
    inMemoryForId (knownOf st) id = forWorkspaceId st id := by
  unfold inMemoryForId forWorkspaceId
  cases hf : (st .workspaces).find? (colIs · "id" id) with
  | some r =>
    have hmem := List.mem_of_find?_eq_some hf
    have hid : r.get "id" = some id := by simpa [colIs] using List.find?_some hf
    have hany : (knownOf st).any (·.id == id) = true := by
      rw [List.any_eq_true]
      obtain ⟨s, hs⟩ := Option.isSome_iff_exists.mp (hslug r hmem)
      refine ⟨⟨id, s⟩, ?_, by simp⟩
      unfold knownOf
      rw [List.mem_filterMap]
      exact ⟨r, hmem, by simp [hid, hs]⟩
    simp [hany, hid]
  | none =>
    have hany : (knownOf st).any (·.id == id) = false := by
      rw [Bool.eq_false_iff, ne_eq, List.any_eq_true]
      rintro ⟨k, hk, hkid⟩
      unfold knownOf at hk
      rw [List.mem_filterMap] at hk
      obtain ⟨r, hr, hkr⟩ := hk
      simp only [Option.bind_eq_bind, Option.bind_eq_some_iff, Option.pure_def,
        Option.some.injEq] at hkr
      obtain ⟨i, hi, s, _, rfl⟩ := hkr
      have := List.find?_eq_none.mp hf r hr
      simp only [beq_iff_eq] at hkid
      subst hkid
      simp [colIs, hi] at this
    simp [hany]

private theorem reverse_find_unique (s : String) :
    ∀ l : List KnownWorkspace, l.Pairwise (fun a b => a.slug ≠ b.slug) →
      l.reverse.find? (·.slug == s) = l.find? (·.slug == s)
  | [], _ => rfl
  | a :: l, hp => by
    rw [List.pairwise_cons] at hp
    rw [List.reverse_cons, List.find?_append, reverse_find_unique s l hp.2, List.find?_cons]
    by_cases ha : a.slug = s
    · have hn : l.find? (·.slug == s) = none := by
        rw [List.find?_eq_none]
        intro b hb hbs
        simp only [beq_iff_eq] at hbs
        exact hp.1 b hb (ha.trans hbs.symm)
      simp [hn, ha]
    · have : (a.slug == s) = false := by simpa using ha
      simp [this]

private theorem known_find (s : String) :
    ∀ rows : List Row, (∀ r ∈ rows, (r.get "id").isSome = true ∧ (r.get "slug").isSome = true) →
      ((rows.filterMap fun r => do
          let i ← r.get "id"
          let s ← r.get "slug"
          pure (KnownWorkspace.mk i s)).find? (·.slug == s)).map (fun k => WorkspaceScope.mk k.id) =
        (rows.find? (colIs · "slug" s)).bind fun r => (r.get "id").map WorkspaceScope.mk
  | [], _ => rfl
  | r :: rows, hall => by
    have hr := hall r (List.mem_cons_self ..)
    have ih := known_find s rows fun x hx => hall x (List.mem_cons_of_mem _ hx)
    obtain ⟨i, hi⟩ := Option.isSome_iff_exists.mp hr.1
    obtain ⟨sl, hsl⟩ := Option.isSome_iff_exists.mp hr.2
    rw [List.filterMap_cons, List.find?_cons]
    by_cases h : sl = s
    · subst h; simp [hi, hsl, colIs]
    · have h1 : (sl == s) = false := by simpa using h
      have h2 : (some sl == some s) = false := by simpa using h
      simpa [hi, hsl, colIs, h1, h2] using ih

/-- The in-memory slug resolver is a `Map` filled row by row, so a later row with the same slug
wins; and over the workspaces of any state whose rows carry an id and a slug and whose slugs are
distinct (`workspaces.slug` is `UNIQUE`), it answers exactly what the database resolver does. -/
@[aw_spec (tier := T4) (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")
  (ts := "packages/core/src/db/repositories/scope.ts#inMemoryResolver")
  (ts := "packages/core/src/db/repositories/scope.ts#databaseResolver")]
theorem in_memory_slug_resolver_refines_database_resolver (st : State)
    (hall : ∀ r ∈ st .workspaces, (r.get "id").isSome = true ∧ (r.get "slug").isSome = true)
    (huniq : (knownOf st).Pairwise (fun a b => a.slug ≠ b.slug)) (slug : String) :
    (∀ (known : List KnownWorkspace) (k : KnownWorkspace),
      inMemoryForSlug (known ++ [k]) k.slug = some ⟨k.id⟩) ∧
    inMemoryForSlug (knownOf st) slug = forWorkspaceSlug st slug := by
  refine ⟨fun known k => by simp [inMemoryForSlug], ?_⟩
  unfold inMemoryForSlug forWorkspaceSlug
  rw [reverse_find_unique slug _ huniq]
  exact known_find slug _ hall

private theorem uuid_no_slash (ws : String) (h : Uuid.isCanonical ws = true) :
    ws.toList.contains '/' = false := by
  rw [Bool.eq_false_iff, ne_eq, List.contains_iff_mem]
  intro hm
  rcases Contracts.Identifiers.canonical_chars ws h '/' hm with hx | hx
  · simp [Uuid.isHexDigit] at hx
  · cases hx

/-- On every real workspace id (a canonical UUID), today's object store and the intended one
behave identically, for every operation and key. -/
@[aw_spec (tier := T4) (doc := "docs/adr/W2-CP-03-object-key-safety.md#decision")
  (ts := "packages/core/src/storage/object-store.ts#createScopedObjectStore")]
theorem object_store_current_agrees_with_target_on_uuids (ws : String)
    (h : Uuid.isCanonical ws = true) (op : ObjectOp) :
    scopedObjectOpCurrent ws op = scopedObjectOpTarget ws op := by
  have hno := uuid_no_slash ws h
  have : objectWorkspaceIdCurrent ws = objectWorkspaceIdTarget ws := by
    simp only [objectWorkspaceIdCurrent, objectWorkspaceIdTarget, hno, Bool.not_false,
      Bool.and_true]
  simp only [scopedObjectOpCurrent, scopedObjectOpTarget, scopedObjectOp, this]

/-- Today's object store accepts a workspace id containing `/`, and then two workspaces address
one object: workspace `a`'s key `b/c` and workspace `a/b`'s key `c` are both the backend key
`workspaces/a/b/c`. The intended rule refuses the id `a/b`. -/
@[aw_spec (tier := T4) (doc := "docs/adr/W2-CP-03-object-key-safety.md#decision")
  (ts := "packages/core/src/storage/object-store.ts#createScopedObjectStore")]
theorem object_store_current_diverges_at_slash_workspace_id :
    scopedObjectOpCurrent "a" (.put "b/c") = .backend ["workspaces/a/b/c"] ∧
      scopedObjectOpCurrent "a/b" (.put "c") = .backend ["workspaces/a/b/c"] ∧
      scopedObjectOpCurrent "a" (.list "") = .backend ["workspaces/a"] ∧
      scopedObjectOpTarget "a/b" (.put "c") = .invalidWorkspaceId ∧
      scopedObjectOpTarget "a" (.put "b/c") = .backend ["workspaces/a/b/c"] := by
  decide +kernel

/-! ## Witnesses -/

private def twoRuns : State
  | .runs => [⟨[("id", "r1"), ("workspace_id", "w1")]⟩, ⟨[("id", "r2"), ("workspace_id", "w2")]⟩]
  | .workspaces => [⟨[("id", "w1"), ("slug", "one")]⟩]
  | _ => []

example : IdsDistinct (twoRuns .runs) ∧ dbStoreGet twoRuns "r2" = some ⟨[("id", "r2"), ("workspace_id", "w2")]⟩ := by
  decide +kernel

example : (∀ r ∈ twoRuns .workspaces, (r.get "slug").isSome = true) ∧
    inMemoryForId (knownOf twoRuns) "w1" = some ⟨"w1"⟩ := by decide +kernel

example : Uuid.isCanonical "7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff" = true := by decide +kernel

example : (∀ r ∈ twoRuns .workspaces, (r.get "id").isSome = true ∧ (r.get "slug").isSome = true) ∧
    (knownOf twoRuns).Pairwise (fun a b => a.slug ≠ b.slug) ∧
    inMemoryForSlug (knownOf twoRuns) "one" = some ⟨"w1"⟩ := by decide +kernel

end AgentWorkspace.Theorems.Refinement.AuthzTenancy
