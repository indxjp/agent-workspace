import AgentWorkspace.Theorems.Invariants.ErCore
import AgentWorkspace.Theorems.Invariants.ConceptCatalog
import AgentWorkspace.Er.Current.Catalog

/-!
T3 — what a writer who controls the ids and strings it sends cannot achieve in the catalog
cluster.

* Whatever id is written into an assignment, a grant, a project link or an owner column, the row
  that id names is in the writer's workspace (generated, one theorem per id reference).
* A grant cannot name an API-key principal or a revoked one, and the grants body admits no two
  ids that differ only in letter case.
* A file path cannot smuggle a `..` segment in anywhere, and a subtree operation never reaches a
  sibling that merely shares the prefix's leading characters.
-/

namespace AgentWorkspace.Theorems.Adversarial.ConceptCatalog

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Catalog
open AgentWorkspace.Concepts
open AgentWorkspace.Theorems.Invariants.ErCore (paired_reference_preserves_tenant)

/-! ## Forged ids cannot cross a workspace -/

private theorem get_eq_of_mem_pairs {r r' : Row} :
    ∀ {cs rcs : List String} {c rc : String},
      (c, rc) ∈ cs.zip rcs → r'.project rcs = r.project cs → r'.get rc = r.get c
  | [], _, _, _, h, _ => by simp at h
  | _ :: _, [], _, _, h, _ => by simp at h
  | x :: xs, y :: ys, c, rc, h, hp => by
    simp only [Row.project, List.map_cons, List.cons.injEq] at hp
    simp only [List.zip_cons_cons, List.mem_cons, Prod.mk.injEq] at h
    rcases h with ⟨rfl, rfl⟩ | h
    · exact hp.1
    · exact get_eq_of_mem_pairs h hp.2

private theorem table_consistent' {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    (t : TableName) : tableConsistent S st t = true :=
  List.all_eq_true.mp hc t (WireEnum.complete t)

/-- A row is identified by its `id` when the table's primary key is `id`. -/
private theorem id_identifies {S : Schema} {st : State} (hc : Er.Core.consistent S st = true)
    {t : TableName} (hpk : (S t).primaryKey = ["id"]) {s p : Row} (hs : s ∈ st t) (hp : p ∈ st t)
    (hsome : (s.get "id").isSome = true) (he : s.get "id" = p.get "id") : s = p := by
  have h := table_consistent' hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have hkey := h.1.1.1.2
  rw [hpk] at hkey
  simp only [keyHolds, List.all_nil] at hkey
  rw [List.filter_eq_self.mpr (fun _ _ => rfl), List.all_eq_true] at hkey
  have := hkey s hs
  simp only [Row.present, List.all_cons, List.all_nil, Bool.and_true, hsome, Bool.not_true,
    Bool.false_or, List.all_eq_true] at this
  have := this p hp
  simpa [Row.project, he] using this

/-- Whatever value a writer puts in the id column `c` of a tenant-paired reference, any row of the
parent table carrying that id belongs to the writer's workspace: the database refuses every
other state. -/
@[aw_spec (tier := T3) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem forged_id_names_a_row_of_the_writers_workspace (S : Schema) (st : State)
    (hc : Er.Core.consistent S st = true) {t : TableName} {fk : ForeignKey}
    (hfk : fk ∈ (S t).foreignKeys) (hpair : isPaired S t fk = true) {c : String}
    (hcid : (c, "id") ∈ fk.pairs) (hpk : (S fk.refTable).primaryKey = ["id"]) {r s : Row}
    (hr : r ∈ st t) (hpres : r.present fk.columns = true) (hs : s ∈ st fk.refTable)
    (hid : s.get "id" = r.get c) : tenantOf S fk.refTable s = tenantOf S t r := by
  have h := table_consistent' hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have hfh := List.all_eq_true.mp (h.1.2 fk hfk) r hr
  simp only [hpres, Bool.not_true, Bool.false_or, List.any_eq_true, beq_iff_eq] at hfh
  obtain ⟨p, hp, hproj⟩ := hfh
  have hpid : p.get "id" = r.get c := get_eq_of_mem_pairs hcid hproj
  have hcsome : (r.get c).isSome = true := by
    have hcm : c ∈ fk.columns := (List.of_mem_zip hcid).1
    simp only [Row.present, List.all_eq_true] at hpres
    exact hpres c hcm
  have : s = p := id_identifies hc hpk hs hp (by rw [hid]; exact hcsome) (by rw [hid, hpid])
  subst this
  exact (paired_reference_preserves_tenant S st hpair ⟨hfk, hr, hs, hpres, hproj⟩).symm

/-- The id references of the cluster the generic theorem covers: tenant-paired, mandatory, one
column paired with the parent's `id`, the parent keyed by `id`, and not the tenant root itself. -/
def forgeableReferences : List (TableName × ForeignKey × String) :=
  clusterForeignKeys.filterMap fun (t, k) =>
    if k.refTable != .workspaces && isPaired catalogue t k && isMandatory t k &&
        (catalogue k.refTable).primaryKey == ["id"] then
      (k.pairs.find? (·.2 == "id")).map fun p => (t, k, p.1)
    else none

section Generator

open Lean Elab Command

private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

private def ctorName (sql : String) : Name :=
  match sql.splitOn "_" with
  | [] => .anonymous
  | w :: ws => Name.mkSimple (w ++ String.join (ws.map String.capitalize))

/-- One T3 theorem per forgeable id reference of the cluster, with its witness. -/
elab "aw_catalog_forgery_theorems" : command => do
  for (t, k, c) in forgeableReferences do
    let s := catalogue t
    let sql := TableName.toWire t
    let tIdent := mkIdent (``TableName ++ ctorName sql)
    let path := "packages/core/src/db/schema/" ++ s.source
    let parentSql := TableName.toWire k.refTable
    let nameLit := Syntax.mkStrLit k.name
    let colLit := Syntax.mkStrLit c
    let thm := mkIdent (Name.mkSimple s!"{sql}_{c}_cannot_name_another_workspaces_{parentSql}")
    let doc := mkDocComment s!"Whatever id a writer puts in `{sql}.{c}`, the `{parentSql}` row \
      with that id is in the writer's workspace (through `{k.name}`)."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T3)) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
        (ts := $(Syntax.mkStrLit (path ++ "#" ++ k.name)))]
      theorem $thm (st : AgentWorkspace.Er.Core.State)
          (hc : AgentWorkspace.Er.Current.Catalog.consistent st = true)
          {r s : AgentWorkspace.Er.Core.Row} (hr : r ∈ st $tIdent)
          (hs : s ∈ st (fk $tIdent $nameLit).refTable) (hid : s.get "id" = r.get $colLit) :
          tenantOf catalogue (fk $tIdent $nameLit).refTable s = tenantOf catalogue $tIdent r :=
        forged_id_names_a_row_of_the_writers_workspace catalogue st
          (Bool.and_eq_true _ _ |>.mp hc).1 (by decide) (by decide) (by decide) (by decide) hr
          (AgentWorkspace.Theorems.Invariants.ConceptCatalog.mandatory_reference_is_set catalogue
            st (Bool.and_eq_true _ _ |>.mp hc).1 _ _ (by decide) hr) hs hid))
    elabCommand (← `(command|
      example : tenantOf catalogue (fk $tIdent $nameLit).refTable
            (Sample.parent $tIdent (fk $tIdent $nameLit)) =
          tenantOf catalogue $tIdent (Sample.child $tIdent (fk $tIdent $nameLit)) :=
        $thm Sample.state (by decide +kernel) (by decide +kernel) (by decide +kernel)
          (by decide +kernel)))

end Generator

aw_catalog_forgery_theorems

/-- The generated forgery theorems cover every assignment, grant, version, project-link and owner
reference to an id-keyed row: 23 references. -/
@[aw_spec (tier := T3) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem forgery_theorems_cover_every_id_reference :
    (forgeableReferences.map fun (t, k, c) => (TableName.toWire t, c, TableName.toWire k.refTable)) =
      [("agent_files", "agent_id", "agents"), ("agent_files", "file_id", "files"),
        ("agent_grants", "agent_id", "agents"),
        ("agent_mcp_servers", "agent_id", "agents"),
        ("agent_mcp_servers", "mcp_server_id", "mcp_servers"),
        ("agent_skills", "agent_id", "agents"), ("agent_skills", "skill_id", "skills"),
        ("agent_pointer_moves", "agent_id", "agents"),
        ("agent_pointer_moves", "version_id", "agent_versions"),
        ("agent_version_evaluations", "version_id", "agent_versions"),
        ("agent_version_evaluations", "created_by_principal_id", "workspace_principals"),
        ("agent_version_pointers", "agent_id", "agents"),
        ("agent_version_pointers", "version_id", "agent_versions"),
        ("agent_versions", "agent_id", "agents"),
        ("agent_versions", "created_by_principal_id", "workspace_principals"),
        ("agents", "owner_principal_id", "workspace_principals"),
        ("files", "owner_principal_id", "workspace_principals"),
        ("mcp_servers", "owner_principal_id", "workspace_principals"),
        ("project_files", "project_id", "projects"), ("project_files", "file_id", "files"),
        ("project_mcp_servers", "project_id", "projects"),
        ("project_mcp_servers", "mcp_server_id", "mcp_servers"),
        ("skills", "owner_principal_id", "workspace_principals")] := by
  decide

/-! ## Grants -/

/-- No grant replacement, whatever ids it names, grants an agent to an API-key principal, a
revoked principal or a principal of another workspace: every id written names an active
membership principal of this workspace. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#membership-roles")
  (ts := "packages/core/src/db/repositories/agent-grants.ts#createDatabaseAgentGrantRepositoryProvider")]
theorem grants_name_only_active_membership_principals (ps : List Grant.PrincipalView)
    (req : List PrincipalId) (users : List UserId)
    (h : Grant.grantsReplace true ps req = .updated users) :
    ∀ r ∈ req, ∃ p ∈ ps, p.id = r ∧ p.user.isSome = true ∧ p.revoked = false := by
  simp only [Grant.grantsReplace, Bool.not_true, Bool.false_eq_true, ite_false] at h
  split at h
  · simp at h
  · rename_i hf
    intro r hr
    have := List.find?_eq_none.mp hf r hr
    simp only [Option.isNone_iff_eq_none] at this
    obtain ⟨q, hq⟩ := Option.ne_none_iff_exists'.mp this
    unfold Grant.lookupGrantable at hq
    have hm := List.mem_of_find?_eq_some hq
    have hp := List.find?_some hq
    simp only [Bool.and_eq_true, beq_iff_eq, Grant.PrincipalView.grantable,
      Bool.not_eq_true'] at hp
    exact ⟨q, hm, hp.1, hp.2.1, hp.2.2⟩

example : ∀ r ∈ [(⟨"p2"⟩ : PrincipalId)], ∃ p ∈ [(⟨⟨"p2"⟩, some ⟨"u2"⟩, false⟩ : Grant.PrincipalView)],
    p.id = r ∧ p.user.isSome = true ∧ p.revoked = false :=
  grants_name_only_active_membership_principals _ _ [⟨"u2"⟩] (by decide)

private theorem mem_map_lower {l : List String} {x : String} (h : x ∈ l.map Grant.lowerAscii) :
    ∃ y ∈ l, x = Grant.lowerAscii y := by
  obtain ⟨y, hy, rfl⟩ := List.mem_map.mp h
  exact ⟨y, hy, rfl⟩

/-- Whatever ids a caller sends, the grants body the schema admits is a list of distinct ids, each
the lower-cased form of a canonical UUID the caller sent, as many as were sent: two spellings of
one id never reach the repository as two rows. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")
  (ts := "packages/contracts/src/agents.ts#AgentGrantsSchema")]
theorem grants_body_admits_only_distinct_uuids (ids l : List String)
    (h : Grant.grantsBody ids = some l) :
    l.Nodup ∧ l.length = ids.length ∧
      ∀ x ∈ l, ∃ y ∈ ids, Uuid.isCanonical y = true ∧ x = Grant.lowerAscii y := by
  unfold Grant.grantsBody at h
  dsimp only at h
  split at h
  · rename_i hall
    split at h
    · rename_i hnd
      simp only [Option.some.injEq] at h
      subst h
      refine ⟨of_decide_eq_true hnd, by simp, fun x hx => ?_⟩
      obtain ⟨y, hy, rfl⟩ := mem_map_lower hx
      exact ⟨y, hy, List.all_eq_true.mp hall y hy, rfl⟩
    · cases h
  · cases h

/-- Two spellings of one id that differ only in letter case are refused, not written twice. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")
  (ts := "packages/contracts/src/agents.ts#AgentGrantsSchema")]
theorem case_variant_duplicate_grant_ids_are_refused :
    Grant.grantsBody ["123E4567-E89B-12D3-A456-426614174000",
      "123e4567-e89b-12d3-a456-426614174000"] = none ∧
    Grant.grantsBody ["123E4567-E89B-12D3-A456-426614174000"] =
      some ["123e4567-e89b-12d3-a456-426614174000"] := by
  decide

example : ["123e4567-e89b-12d3-a456-426614174000"].Nodup ∧
    ["123e4567-e89b-12d3-a456-426614174000"].length =
      ["123E4567-E89B-12D3-A456-426614174000"].length ∧
    ∀ x ∈ ["123e4567-e89b-12d3-a456-426614174000"],
      ∃ y ∈ ["123E4567-E89B-12D3-A456-426614174000"], Uuid.isCanonical y = true ∧
        x = Grant.lowerAscii y :=
  grants_body_admits_only_distinct_uuids _ _ (by decide)

/-! ## Path handling -/

private theorem splitSlash_ne_nil (xs : List Char) : File.splitSlash xs ≠ [] := by
  cases xs with
  | nil => simp [File.splitSlash]
  | cons c cs =>
    simp only [File.splitSlash]
    split
    · simp
    · split <;> simp

private theorem splitSlash_append_slash :
    ∀ xs ys : List Char, File.splitSlash (xs ++ '/' :: ys) = File.splitSlash xs ++ File.splitSlash ys
  | [], ys => by
    simp only [List.nil_append, File.splitSlash]
    cases h : File.splitSlash ys with
    | nil => exact absurd h (splitSlash_ne_nil ys)
    | cons s rest => simp
  | c :: xs, ys => by
    have ih := splitSlash_append_slash xs ys
    simp only [List.cons_append, File.splitSlash, ih]
    cases hx : File.splitSlash xs with
    | nil => exact absurd hx (splitSlash_ne_nil xs)
    | cons s rest =>
      simp only [List.cons_append]
      split <;> simp

/-- Whatever a caller puts before and after it, a path that contains a `..` segment is refused by
`files_path_no_dot_segments`, whether the segment leads, trails or sits in the middle. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")
  (ts := "packages/core/src/db/schema/files.ts#files")]
theorem dot_dot_segment_is_refused_anywhere (pre suf : String) :
    File.noDotSegments (pre ++ "/../" ++ suf) = false ∧
      File.noDotSegments ("../" ++ suf) = false ∧ File.noDotSegments (pre ++ "/..") = false := by
  have key : ∀ l : List (List Char), ['.', '.'] ∈ l →
      (l.all fun s => s != ['.'] && s != ['.', '.']) = false := by
    intro l hl
    rw [List.all_eq_false]
    exact ⟨_, hl, by decide⟩
  have hdd : ∀ ys : List Char, File.splitSlash ('.' :: '.' :: '/' :: ys) =
      ['.', '.'] :: File.splitSlash ys := by
    intro ys
    have := splitSlash_append_slash ['.', '.'] ys
    simpa [File.splitSlash] using this
  refine ⟨?_, ?_, ?_⟩
  · apply key
    simp only [File.segments, String.toList_append]
    have : pre.toList ++ "/../".toList ++ suf.toList =
        pre.toList ++ '/' :: ('.' :: '.' :: '/' :: suf.toList) := by simp
    rw [this, splitSlash_append_slash, hdd]
    simp
  · apply key
    simp only [File.segments, String.toList_append]
    have : "../".toList ++ suf.toList = '.' :: '.' :: '/' :: suf.toList := by simp
    rw [this, hdd]
    simp
  · apply key
    simp only [File.segments, String.toList_append]
    have : pre.toList ++ "/..".toList = pre.toList ++ '/' :: ['.', '.'] := by simp
    rw [this, splitSlash_append_slash]
    simp [File.splitSlash]

private theorem isPrefixOf_append_cancel :
    ∀ (l a b : List Char), (l ++ a).isPrefixOf (l ++ b) = a.isPrefixOf b
  | [], _, _ => rfl
  | x :: l, a, b => by simp [isPrefixOf_append_cancel l a b]

/-- A subtree move or delete of `pre` never touches a sibling whose path merely starts with the
same characters: `docs2/x` is not under `docs`, whatever the prefix and the suffix. -/
@[aw_spec (tier := T3)
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#pathUnderPrefix")]
theorem sibling_sharing_leading_characters_is_not_under_the_prefix (pre suf : String)
    (hne : suf.toList ≠ []) (hslash : suf.toList.head? ≠ some '/') :
    File.underPrefix pre (pre ++ suf) = false := by
  unfold File.underPrefix
  have h1 : (pre ++ suf == pre) = false := by
    rw [beq_eq_false_iff_ne]
    intro heq
    have := congrArg String.toList heq
    rw [String.toList_append] at this
    exact hne (by simpa using this)
  have h2 : (pre.toList ++ ['/']).isPrefixOf (pre ++ suf).toList = false := by
    rw [String.toList_append, isPrefixOf_append_cancel]
    cases hs : suf.toList with
    | nil => exact absurd hs hne
    | cons c rest =>
      rw [hs] at hslash
      simp only [List.head?_cons, ne_eq, Option.some.injEq] at hslash
      simp [List.isPrefixOf]
      exact fun h => hslash h.symm
  rw [h1, h2]
  rfl

example : File.underPrefix "docs" ("docs" ++ "2/x.txt") = false :=
  sibling_sharing_leading_characters_is_not_under_the_prefix _ _ (by decide) (by decide)

/-! ## Running an agent without a grant -/

/-- A caller who does not own an agent and whose user no `agent_grants` row of that agent names
is never `permitted` to run it, whatever else the input holds (an API-key caller, which has no
user, never is). -/
@[aw_spec (tier := T3) (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (ts := "apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership")
  (ts := "packages/core/src/db/repositories/agent-grants.ts#AgentGrantRepository")]
theorem no_grant_row_no_run_permission (i : Grant.RunOwnershipInput)
    (hno : ∀ u, i.callerUser = some u → u ∉ i.grantUsers) :
    Grant.runOwnership i ≠ .permitted := by
  obtain ⟨conf, owner, wired, caller, user, users⟩ := i
  intro h
  cases conf <;> cases owner <;> cases wired <;> cases user <;>
    simp [Grant.runOwnership, Grant.hasGrant] at h <;> (try split at h) <;> simp_all

example : Grant.runOwnership ⟨true, some ⟨"p1"⟩, true, ⟨"p2"⟩, some ⟨"u2"⟩, [⟨"u1"⟩]⟩ ≠
    .permitted :=
  no_grant_row_no_run_permission _ (by decide)
example : Grant.runOwnership ⟨true, some ⟨"p1"⟩, true, ⟨"k1"⟩, none, [⟨"u1"⟩]⟩ ≠ .permitted :=
  no_grant_row_no_run_permission _ (by simp)

end AgentWorkspace.Theorems.Adversarial.ConceptCatalog
