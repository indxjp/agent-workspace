import AgentWorkspace.Authz.Tenancy

/-!
T2 — tenant isolation that holds for **every** state and operation: a scoped read returns only
rows of its workspace; a repository write, committed under today's whole-schema constraints,
leaves every row of every other workspace (and every global row) exactly where it was; a scoped
object-store call only ever names keys whose first two segments are `workspaces/<its workspace>`,
so two workspaces never share a key or a listing. (That a committed write keeps the state
consistent is `Er.Current.commit`'s own guard, not a tenancy fact, so it is not restated here.)
-/

namespace AgentWorkspace.Theorems.Invariants.AuthzTenancy

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Authz.Tenancy

/-! ## Scoped reads -/

/-- A scoped read returns only rows whose workspace is the scope's. -/
@[aw_spec (tier := T2) (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")
  (ts := "packages/core/src/db/repositories/scope.ts#WorkspaceScope")]
theorem scoped_select_reads_only_its_workspace (st : State) (s : WorkspaceScope) (t : TableName)
    (p : Row → Bool) {r : Row} (h : r ∈ scopedSelect st s t p) :
    rowTenant t r = some s.workspaceId := by
  unfold scopedSelect at h
  rw [List.mem_filter, Bool.and_eq_true, beq_iff_eq] at h
  exact h.2.1

/-! ## Scoped writes -/

private theorem rowTenant_scoped {t : TableName} (h : isScopedTable t = true) (r : Row) :
    rowTenant t r = r.get "workspace_id" := by
  unfold isScopedTable at h
  unfold rowTenant tenantOf TableSpec.tenantColumn?
  rw [beq_iff_eq] at h
  rw [h]; rfl

private theorem rowTenant_withWorkspace {t : TableName} (h : isScopedTable t = true) (ws : String)
    (r : Row) : rowTenant t (withWorkspace ws r) = some ws := by
  rw [rowTenant_scoped h]
  simp [withWorkspace, Row.get]

private theorem apply_preserves_foreign {ws : String} {x : Er.Current.Stmt}
    (hx : stmtInWorkspace ws x = true) (st : State) (u : TableName) {r : Row}
    (hr : rowTenant u r ≠ some ws) : r ∈ x.apply st u ↔ r ∈ st u := by
  cases x with
  | insert t r' =>
    simp only [stmtInWorkspace, Bool.and_eq_true, beq_iff_eq] at hx
    simp only [Er.Current.Stmt.apply]
    split
    · rename_i hu
      subst hu
      simp only [List.mem_append, List.mem_singleton]
      constructor
      · rintro (h | h)
        · exact h
        · exact absurd (h ▸ hx.2) hr
      · exact Or.inl
    · exact Iff.rfl
  | delete t r' =>
    simp only [stmtInWorkspace, Bool.and_eq_true, beq_iff_eq] at hx
    simp only [Er.Current.Stmt.apply]
    split
    · rename_i hu
      subst hu
      rw [List.mem_filter]
      constructor
      · exact fun h => h.1
      · intro h
        refine ⟨h, ?_⟩
        simp only [bne_iff_ne, ne_eq]
        intro he
        exact hr (he ▸ hx.2)
    · exact Iff.rfl
  | update t o n =>
    simp only [stmtInWorkspace, Bool.and_eq_true, beq_iff_eq] at hx
    simp only [Er.Current.Stmt.apply]
    split
    · rename_i hu
      subst hu
      rw [List.mem_map]
      constructor
      · rintro ⟨y, hy, hfy⟩
        by_cases hyo : (y == o) = true
        · simp only [hyo, ite_true] at hfy
          exact absurd (hfy ▸ hx.2) hr
        · simp only [hyo] at hfy
          exact hfy ▸ hy
      · intro h
        refine ⟨r, h, ?_⟩
        have hro : (r == o) = false := by
          simp only [beq_eq_false_iff_ne, ne_eq]
          intro he
          exact hr (he ▸ hx.1.2)
        simp [hro]
    · exact Iff.rfl

private theorem run_preserves_foreign {ws : String} :
    ∀ (tx : List Er.Current.Stmt) (st : State), tx.all (stmtInWorkspace ws) = true →
      ∀ (u : TableName) {r : Row}, rowTenant u r ≠ some ws → (r ∈ Er.Current.run tx st u ↔ r ∈ st u)
  | [], _, _, _, _, _ => Iff.rfl
  | x :: xs, st, htx, u, r, hr => by
    simp only [List.all_cons, Bool.and_eq_true] at htx
    show r ∈ Er.Current.run xs (x.apply st) u ↔ r ∈ st u
    rw [run_preserves_foreign xs (x.apply st) htx.2 u hr]
    exact apply_preserves_foreign htx.1 st u hr

private theorem compile_in_workspace (st : State) (s : WorkspaceScope) (w : RepoWrite)
    (h : isScopedTable w.table = true) : (w.compile st s).all (stmtInWorkspace s.workspaceId) = true := by
  cases w with
  | insert t r =>
    simp only [RepoWrite.table] at h
    simp [RepoWrite.compile, stmtInWorkspace, h, rowTenant_withWorkspace h]
  | update t p f =>
    simp only [RepoWrite.table] at h
    simp only [RepoWrite.compile, List.all_map, List.all_eq_true, Function.comp]
    intro o ho
    simp [stmtInWorkspace, h, rowTenant_withWorkspace h,
      scoped_select_reads_only_its_workspace st s t p ho]
  | delete t p =>
    simp only [RepoWrite.table] at h
    simp only [RepoWrite.compile, List.all_map, List.all_eq_true, Function.comp]
    intro o ho
    simp [stmtInWorkspace, h, scoped_select_reads_only_its_workspace st s t p ho]

/-- A repository write bound to scope `s` on a tenant-scoped table, once PostgreSQL commits or
rolls it back, leaves every row that is not of `s`'s workspace — every other tenant's rows and
every global row — exactly as it was: no scoped operation reaches another workspace. -/
@[aw_spec (tier := T2) (doc := "docs/adr/W2-DB-02-the-repository-shape.md#decision")
  (ts := "packages/core/src/db/repositories/scope.ts#requireWorkspaceScope")]
theorem repository_write_touches_only_its_workspace (st : State) (s : WorkspaceScope)
    (w : RepoWrite) (h : isScopedTable w.table = true) (u : TableName) {r : Row}
    (hr : rowTenant u r ≠ some s.workspaceId) : r ∈ repoCommit st s w u ↔ r ∈ st u := by
  unfold repoCommit Er.Current.commit
  split
  · exact run_preserves_foreign _ st (compile_in_workspace st s w h) u hr
  · exact Iff.rfl

/-! ## The directory re-read -/

private theorem find_mem {α : Type} {p : α → Bool} {l : List α} {r : α} (h : l.find? p = some r) :
    r ∈ l ∧ p r = true := ⟨List.mem_of_find?_eq_some h, List.find?_some h⟩

/-- `principalById(ws, pid)` builds its record only from rows of workspace `ws`: a membership
principal's role comes from a membership of `ws` (and its label from that membership's user), an
API-key principal's role and label from a key of `ws` that is neither revoked nor expired at
`now`. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/repositories/directory.ts#principalById")
  (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")]
theorem principal_by_id_reads_only_its_workspace (st : State) (ws pid : String) (now : Nat)
    (rec : DirectoryRecord) (h : principalById st ws pid now = some rec) :
    rec.workspaceId = ws ∧
    (rec.kind = .membership → ∃ m ∈ st .memberships, m.get "workspace_id" = some ws ∧
        m.get "role" = some rec.role ∧ m.get "user_id" = rec.userId ∧
        ∃ u ∈ st .users, u.get "id" = rec.userId ∧ u.get "name" = some rec.label) ∧
    (rec.kind = .apiKey → ∃ k ∈ st .apiKeys, k.get "workspace_id" = some ws ∧
        k.get "id" = rec.apiKeyId ∧ k.get "role" = some rec.role ∧ k.get "name" = some rec.label ∧
        k.get "revoked_at" = none ∧
        ((k.get "expires_at").isNone = true ∨ after (k.get "expires_at") now = true)) := by
  unfold principalById at h
  simp only [Option.bind_eq_bind, Option.bind_eq_some_iff] at h
  obtain ⟨_, _, hk⟩ := h
  split at hk
  · simp only [Option.bind_eq_some_iff, Option.pure_def, Option.some.injEq] at hk
    obtain ⟨mid, _, m, hm, uid, huid, role, hrole, u, hu, name, hname, rfl⟩ := hk
    obtain ⟨hmmem, hmp⟩ := find_mem hm
    obtain ⟨humem, hup⟩ := find_mem hu
    simp only [colIs, Bool.and_eq_true, beq_iff_eq] at hmp hup
    refine ⟨rfl, fun _ => ⟨m, hmmem, hmp.1, hrole, huid, u, humem, hup, hname⟩, fun hk => ?_⟩
    cases hk
  · simp only [Option.bind_eq_some_iff] at hk
    obtain ⟨kid, _, k, hkf, hk⟩ := hk
    obtain ⟨hkmem, hkp⟩ := find_mem hkf
    simp only [colIs, Bool.and_eq_true, beq_iff_eq] at hkp
    split at hk
    · cases hk
    · rename_i hrev
      split at hk
      · cases hk
      · rename_i hexp
        simp only [Option.bind_eq_some_iff, Option.pure_def, Option.some.injEq] at hk
        obtain ⟨role, hrole, name, hname, rfl⟩ := hk
        refine ⟨rfl, fun hk => ?_, fun _ => ⟨k, hkmem, hkp.1, hkp.2, hrole, hname, ?_, ?_⟩⟩
        · cases hk
        · simpa using hrev
        · cases he : (k.get "expires_at").isNone
          · right
            have hs : (k.get "expires_at").isSome = true := by
              cases hx : k.get "expires_at" <;> simp_all
            simpa [hs] using hexp
          · left; rfl

/-! ## Object-store keys -/

private theorem ss_nil : Authz.Surface.splitSlash [] = [[]] := rfl

private theorem ss_cons (c : Char) (cs : List Char) :
    Authz.Surface.splitSlash (c :: cs) =
      (match Authz.Surface.splitSlash cs with
        | [] => [[c]]
        | seg :: segs => if c = '/' then [] :: seg :: segs else (c :: seg) :: segs) := rfl

private theorem splitSlash_ne_nil (xs : List Char) : Authz.Surface.splitSlash xs ≠ [] := by
  cases xs with
  | nil => simp [ss_nil]
  | cons c cs =>
    rw [ss_cons]
    split
    · simp
    · split <;> simp

private theorem splitSlash_append_slash :
    ∀ xs ys : List Char, Authz.Surface.splitSlash (xs ++ '/' :: ys) =
      Authz.Surface.splitSlash xs ++ Authz.Surface.splitSlash ys
  | [], ys => by
    simp only [List.nil_append, ss_cons, ss_nil]
    cases h : Authz.Surface.splitSlash ys with
    | nil => exact absurd h (splitSlash_ne_nil ys)
    | cons seg segs => simp
  | c :: xs, ys => by
    simp only [List.cons_append, ss_cons]
    rw [splitSlash_append_slash xs ys]
    cases h : Authz.Surface.splitSlash xs with
    | nil => exact absurd h (splitSlash_ne_nil xs)
    | cons seg segs =>
      simp only [List.cons_append]
      split <;> simp

private theorem splitSlash_no_slash : ∀ xs : List Char, xs.contains '/' = false →
    Authz.Surface.splitSlash xs = [xs]
  | [], _ => rfl
  | c :: xs, h => by
    simp only [List.contains_cons, Bool.or_eq_false_iff] at h
    rw [ss_cons, splitSlash_no_slash xs h.2]
    have hc : c ≠ '/' := by
      intro e
      subst e
      simp at h
    simp [hc]

private theorem fullKey_segments (ws rel : String) (hws : ws.toList.contains '/' = false) :
    ∃ R, Authz.Surface.splitSlash (fullKey ws rel).toList = "workspaces".toList :: ws.toList :: R := by
  unfold fullKey joinPrefixed workspaceKeyPrefix
  have hw : "workspaces/".toList = "workspaces".toList ++ ['/'] := by decide +kernel
  split
  · refine ⟨[], ?_⟩
    rw [String.toList_append, hw, List.append_assoc, List.singleton_append,
      splitSlash_append_slash, splitSlash_no_slash _ hws, splitSlash_no_slash _ (by decide +kernel)]
    rfl
  · refine ⟨Authz.Surface.splitSlash rel.toList, ?_⟩
    have h2 : "/".toList = ['/'] := by decide +kernel
    simp only [String.toList_append, hw, h2, List.append_assoc, List.nil_append,
      List.cons_append]
    rw [splitSlash_append_slash, splitSlash_no_slash _ (by decide +kernel), splitSlash_append_slash,
      splitSlash_no_slash _ hws]
    rfl

private theorem backend_keys_are_full (acceptWs : String → Bool) (ws : String) (op : ObjectOp)
    {ks : List String} (h : scopedObjectOp acceptWs ws op = .backend ks) :
    ∀ k ∈ ks, ∃ rel, k = fullKey ws rel := by
  unfold scopedObjectOp at h
  split at h
  · cases h
  · have one : ∀ (e : Except KeyRule String) (ks : List String),
        (match e with | .ok k => ObjectOutcome.backend [k] | .error e => .unsafeKey e) = .backend ks →
        (∃ raw a, e = guardJoin ws raw a) → ∀ k ∈ ks, ∃ rel, k = fullKey ws rel := by
      intro e ks he hj k hk
      obtain ⟨raw, a, rfl⟩ := hj
      unfold guardJoin at he
      cases hg : keyGuard raw a with
      | error x => simp [hg, Except.map] at he
      | ok v =>
        simp only [hg, Except.map, ObjectOutcome.backend.injEq] at he
        subst he
        simp only [List.mem_singleton] at hk
        exact ⟨v, hk⟩
    cases op with
    | put k => exact one _ ks h ⟨k, _, rfl⟩
    | get k => exact one _ ks h ⟨k, _, rfl⟩
    | delete k => exact one _ ks h ⟨k, _, rfl⟩
    | list p => exact one _ ks h ⟨p, _, rfl⟩
    | listPrefix p => exact one _ ks h ⟨p, _, rfl⟩
    | copy a b =>
      simp only at h
      cases ha : guardJoin ws a false with
      | error e => simp [ha] at h
      | ok x =>
        cases hb : guardJoin ws b false with
        | error e => simp [ha, hb] at h
        | ok y =>
          simp only [ha, hb, ObjectOutcome.backend.injEq] at h
          subst h
          intro k hk
          unfold guardJoin at ha hb
          simp only [List.mem_cons, List.mem_nil_iff, or_false] at hk
          rcases hk with rfl | rfl
          · cases hg : keyGuard a false with
            | error e => simp [hg, Except.map] at ha
            | ok v => simp only [hg, Except.map, Except.ok.injEq] at ha; exact ⟨v, ha.symm⟩
          · cases hg : keyGuard b false with
            | error e => simp [hg, Except.map] at hb
            | ok v => simp only [hg, Except.map, Except.ok.injEq] at hb; exact ⟨v, hb.symm⟩

/-- Every backend key or prefix a scoped object-store call reaches begins with the two segments
`workspaces` and the store's workspace id, whenever that id is a single segment (always, under the
target acceptance rule; for today's rule, whenever the id has no `/`). -/
@[aw_spec (tier := T2) (doc := "docs/adr/W2-CP-03-object-key-safety.md#decision")
  (ts := "packages/core/src/storage/object-store.ts#createScopedObjectStore")]
theorem object_keys_carry_their_workspace (acceptWs : String → Bool) (ws : String) (op : ObjectOp)
    (hws : ws.toList.contains '/' = false) {ks : List String}
    (h : scopedObjectOp acceptWs ws op = .backend ks) :
    ∀ k ∈ ks, ∃ R, Authz.Surface.splitSlash k.toList = "workspaces".toList :: ws.toList :: R := by
  intro k hk
  obtain ⟨rel, rfl⟩ := backend_keys_are_full acceptWs ws op h k hk
  exact fullKey_segments ws rel hws

/-- Under the target acceptance rule, no key or listing prefix of one workspace's object store is
a key of another workspace's, nor a segment prefix of one: a key of workspace A is never a key of
workspace B, and listing A never lists B. -/
@[aw_spec (tier := T2) (doc := "docs/adr/W2-CP-03-object-key-safety.md#decision")
  (ts := "packages/core/src/storage/object-store.ts#createScopedObjectStore")]
theorem object_keys_of_two_workspaces_are_disjoint (ws₁ ws₂ : String) (hne : ws₁ ≠ ws₂)
    (op₁ op₂ : ObjectOp) {ks₁ ks₂ : List String}
    (h₁ : scopedObjectOpTarget ws₁ op₁ = .backend ks₁) (h₂ : scopedObjectOpTarget ws₂ op₂ = .backend ks₂)
    {k₁ k₂ : String} (hk₁ : k₁ ∈ ks₁) (hk₂ : k₂ ∈ ks₂) :
    k₁ ≠ k₂ ∧ ¬ (Authz.Surface.splitSlash k₁.toList <+: Authz.Surface.splitSlash k₂.toList) := by
  have acc : ∀ ws op ks, scopedObjectOpTarget ws op = .backend ks → ws.toList.contains '/' = false := by
    intro ws op ks h
    unfold scopedObjectOpTarget scopedObjectOp at h
    split at h
    · cases h
    · rename_i hacc
      have hok : objectWorkspaceIdTarget ws = true := by simpa using hacc
      simp only [objectWorkspaceIdTarget, Bool.and_eq_true, Bool.not_eq_true'] at hok
      exact hok.2
  obtain ⟨R₁, hR₁⟩ := object_keys_carry_their_workspace _ ws₁ op₁ (acc _ _ _ h₁) h₁ k₁ hk₁
  obtain ⟨R₂, hR₂⟩ := object_keys_carry_their_workspace _ ws₂ op₂ (acc _ _ _ h₂) h₂ k₂ hk₂
  have hne' : ws₁.toList ≠ ws₂.toList := fun h => hne (String.toList_injective h)
  have npre : ¬ (Authz.Surface.splitSlash k₁.toList <+: Authz.Surface.splitSlash k₂.toList) := by
    rw [hR₁, hR₂]
    intro hp
    obtain ⟨t, ht⟩ := hp
    simp only [List.cons_append, List.cons.injEq] at ht
    exact hne' ht.2.1
  refine ⟨fun heq => npre ?_, npre⟩
  rw [heq]
  exact List.prefix_refl _

/-! ## Witnesses -/

/-- A two-workspace state: agent `a1` of `w1` and agent `a2` of `w2`. -/
private def twoAgents : State
  | .agents => [⟨[("id", "a1"), ("workspace_id", "w1")]⟩, ⟨[("id", "a2"), ("workspace_id", "w2")]⟩]
  | _ => []

example : scopedSelect twoAgents ⟨"w1"⟩ .agents (fun _ => true) =
    [⟨[("id", "a1"), ("workspace_id", "w1")]⟩] := by decide +kernel

example : isScopedTable (RepoWrite.delete .agents (fun _ => true)).table = true ∧
    rowTenant .agents ⟨[("id", "a1"), ("workspace_id", "w1")]⟩ ≠ some "w2" := by decide +kernel

example : (RepoWrite.insert .agents ⟨[("id", "a3"), ("workspace_id", "w1")]⟩).compile twoAgents ⟨"w2"⟩ =
    [.insert .agents ⟨[("workspace_id", "w2"), ("id", "a3")]⟩] := by decide +kernel

/- An audit event has no dependent rows. Deleting `w1`'s event in the fully consistent ER
witness exercises a committed write while the agent of `w2` remains present. -/
private def auditDelete : RepoWrite := .delete .auditEvents (colIs · "id" "ae1")

private def foreignAgent : Row := Er.Current.Witness.row
  ([("id", "a2"), ("workspace_id", "w2"), ("name", "Other"), ("instructions", "Help."),
    ("permissions", "{}"), ("owner_principal_id", "p4")] ++ Er.Current.Witness.stamps)

example : isScopedTable auditDelete.table = true ∧
    rowTenant .agents foreignAgent ≠ some "w1" ∧
    foreignAgent ∈ Er.Current.Witness.state .agents ∧
    foreignAgent ∈ repoCommit Er.Current.Witness.state ⟨"w1"⟩ auditDelete .agents ∧
    (repoCommit Er.Current.Witness.state ⟨"w1"⟩ auditDelete .auditEvents).length = 0 := by
  decide +kernel

/-- A directory with a membership principal `p1` and an API-key principal `p3` in `w1`. -/
private def directory : State
  | .memberships => [⟨[("id", "m1"), ("workspace_id", "w1"), ("user_id", "u1"), ("role", "owner")]⟩]
  | .users => [⟨[("id", "u1"), ("name", "Ada")]⟩]
  | .workspacePrincipals =>
    [⟨[("id", "p1"), ("workspace_id", "w1"), ("kind", "membership"), ("membership_id", "m1")]⟩,
     ⟨[("id", "p3"), ("workspace_id", "w1"), ("kind", "api_key"), ("api_key_id", "k1")]⟩]
  | .apiKeys => [⟨[("id", "k1"), ("workspace_id", "w1"), ("name", "CI"), ("role", "builder"),
      ("expires_at", "2000")]⟩]
  | _ => []

example : (principalById directory "w1" "p1" 1000).isSome = true ∧
    (principalById directory "w1" "p3" 1000).isSome = true := by decide +kernel

example : scopedObjectOpTarget "w1" (.put "docs/a.md") = .backend ["workspaces/w1/docs/a.md"] ∧
    scopedObjectOpTarget "w2" (.list "") = .backend ["workspaces/w2"] ∧
    ("w1".toList.contains '/') = false := by decide +kernel

end AgentWorkspace.Theorems.Invariants.AuthzTenancy
