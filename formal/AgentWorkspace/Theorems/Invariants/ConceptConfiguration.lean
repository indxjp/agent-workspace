import AgentWorkspace.Er.Current.Configuration
import AgentWorkspace.Theorems.Invariants.ErCore

/-!
T2 — what holds in every state PostgreSQL can hold for the configuration cluster.

* **Tenancy, per foreign key.** One theorem per key in `clusterForeignKeys` (generated): a reference
  through it never joins rows of two workspaces. Each instantiates the generic
  `no_cross_tenant_reference` of the `er-core` unit, and each has a witness in the state
  `Witness.state`, where the key is populated.
* **Cardinalities.** Every model connection, runtime profile and secret belongs to exactly one
  workspace; a runtime profile names at most one runtime connection, and it is a secret of the
  profile's own workspace; an id identifies one row.
* **Uniqueness consequences.** A name identifies at most one connection, profile or secret in a
  workspace.
* **Closed sets.** A stored provider, driver, network policy, filesystem mode and algorithm is a
  member of its enumeration.
* **Refined checks.** In a state where the cluster's own checks hold (`consistentConfig`), a stored
  secret has a valid name and a well-formed envelope, and a default model is set together with its
  connection.

As in `er-core`, these are properties of every consistent state, which is the invariant each
operation of the cluster (Phase 4) must preserve.
-/

namespace AgentWorkspace.Theorems.Invariants.ConceptConfiguration

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts
open AgentWorkspace.Er.Current.Configuration
open AgentWorkspace.Theorems.Invariants.ErCore (no_cross_tenant_reference)

/-! ## Helpers -/

private theorem pairing : pairingComplete catalogue = true := by decide

private theorem table_consistent {st : State} (hc : consistent catalogue st = true)
    (t : TableName) : tableConsistent catalogue st t = true :=
  List.all_eq_true.mp hc t (WireEnum.complete t)

private theorem fk_holds {st : State} (hc : consistent catalogue st = true)
    {t : TableName} {fk : ForeignKey} (hfk : fk ∈ (catalogue t).foreignKeys) :
    fkHolds st t fk = true := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  exact h.1.2 fk hfk

private theorem not_null_holds {st : State} (hc : consistent catalogue st = true)
    {t : TableName} {c : String} (hnn : (catalogue t).isNotNull c = true) {r : Row}
    (hr : r ∈ st t) : (r.get c).isSome = true := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  obtain ⟨col, hcol, hc'⟩ := List.any_eq_true.mp hnn
  simp only [Bool.and_eq_true, beq_iff_eq] at hc'
  have := h.1.1.1.1 col hcol
  simp only [notNullHolds, hc'.2, Bool.not_true, Bool.false_or, List.all_eq_true] at this
  rw [← hc'.1]
  exact this r hr

private theorem key_holds_elim {rows : List Row} {cols : List String}
    (h : keyHolds rows cols [] = true) {r1 r2 : Row} (h1 : r1 ∈ rows) (h2 : r2 ∈ rows)
    (hp : r1.present cols = true) (hv : r1.project cols = r2.project cols) : r1 = r2 := by
  simp only [keyHolds, List.all_nil] at h
  rw [List.filter_eq_self.mpr (fun _ _ => rfl), List.all_eq_true] at h
  have := h r1 h1
  simp only [hp, Bool.not_true, Bool.false_or, List.all_eq_true] at this
  have := this r2 h2
  simpa [hv] using this

private theorem unique_key {st : State} (hc : consistent catalogue st = true) {t : TableName}
    {u : UniqueKey} (hu : u ∈ (catalogue t).uniques) (hpart : u.partialNullColumns = [])
    {r1 r2 : Row} (h1 : r1 ∈ st t) (h2 : r2 ∈ st t) (hp : r1.present u.columns = true)
    (hv : r1.project u.columns = r2.project u.columns) : r1 = r2 := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have hk := h.1.1.2 u hu
  rw [hpart] at hk
  exact key_holds_elim hk h1 h2 hp hv

private theorem primary_key {st : State} (hc : consistent catalogue st = true) {t : TableName}
    (hpk : (catalogue t).primaryKey = ["id"]) {r1 r2 : Row} (h1 : r1 ∈ st t) (h2 : r2 ∈ st t)
    (hs : (r1.get "id").isSome = true) (hv : r1.get "id" = r2.get "id") : r1 = r2 := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have hk := h.1.1.1.2
  rw [hpk] at hk
  exact key_holds_elim hk h1 h2 (by simpa [Row.present] using hs) (by simp [Row.project, hv])

private theorem closed_set {st : State} (hc : consistent catalogue st = true) {t : TableName}
    {n c : String} {vs : List String} (hck : Check.oneOf n c vs ∈ (catalogue t).checks)
    {r : Row} (hr : r ∈ st t) : (r.get c).all vs.contains = true := by
  have h := table_consistent hc t
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have := h.2 _ hck
  simp only [checkHolds, List.all_eq_true] at this
  exact this r hr

private theorem refined {st : State} (hc : consistentConfig st = true) {t : TableName}
    {n : String} (hn : (t, n) ∈ refinedChecks) {r : Row} (hr : r ∈ st t) :
    configCheckHolds n r = true := by
  simp only [consistentConfig, refinedChecksHold, Bool.and_eq_true, List.all_eq_true] at hc
  exact hc.2 (t, n) hn r hr

/-- A member of a wire enumeration's spellings is the spelling of some member. -/
private theorem wire_member {α : Type} [WireEnum α] {v : String}
    (h : (WireEnum.wires α).contains v = true) : ∃ a : α, WireEnum.toWire a = v := by
  simp only [WireEnum.wires, List.contains_iff_mem, List.mem_map] at h
  obtain ⟨a, _, ha⟩ := h
  exact ⟨a, ha⟩

private theorem enum_cell {st : State} (hc : consistent catalogue st = true) {t : TableName}
    {n c : String} {α : Type} [WireEnum α]
    (hck : Check.oneOf n c (WireEnum.wires α) ∈ (catalogue t).checks)
    (hnn : (catalogue t).isNotNull c = true) {r : Row} (hr : r ∈ st t) :
    ∃ a : α, r.get c = some (WireEnum.toWire a) := by
  have hs := not_null_holds hc hnn hr
  have hm := closed_set hc hck hr
  cases hv : r.get c with
  | none => rw [hv] at hs; cases hs
  | some v =>
    rw [hv] at hm
    obtain ⟨a, ha⟩ := wire_member (α := α) (by simpa using hm)
    exact ⟨a, by rw [ha]⟩

/-- The single-column reference `c → k` of row `r` reaches exactly one parent row. -/
private theorem reaches_one {st : State} (hc : consistent catalogue st = true) {t : TableName}
    {fk : ForeignKey} (hfk : fk ∈ (catalogue t).foreignKeys) {c k : String}
    (hcols : fk.columns = [c]) (hrcols : fk.refColumns = [k])
    (hkey : (catalogue fk.refTable).primaryKey = [k]) {r : Row} (hr : r ∈ st t) {v : String}
    (hv : r.get c = some v) :
    ∃ p ∈ st fk.refTable, p.get k = some v ∧ ∀ q ∈ st fk.refTable, q.get k = some v → q = p := by
  have hh := List.all_eq_true.mp (fk_holds hc hfk) r hr
  simp only [Row.present, hcols, List.all_cons, List.all_nil, hv, Option.isSome_some,
    Bool.and_true, Bool.not_true, Bool.false_or, List.any_eq_true] at hh
  obtain ⟨p, hp, hpv⟩ := hh
  simp only [Row.project, hrcols, List.map_cons, List.map_nil, hv, beq_iff_eq,
    List.cons.injEq, and_true] at hpv
  refine ⟨p, hp, hpv, fun q hq hqv => ?_⟩
  have h := table_consistent hc fk.refTable
  simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
  have hk := h.1.1.1.2
  rw [hkey] at hk
  exact key_holds_elim hk hq hp (by simp [Row.present, hqv]) (by simp [Row.project, hqv, hpv])

/-! ## Tenancy, per foreign key -/

section Generator

open Lean Elab Command

private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

private def ctorName (sql : String) : Name :=
  match sql.splitOn "_" with
  | [] => .anonymous
  | w :: ws => Name.mkSimple (w ++ String.join (ws.map String.capitalize))

/-- One T2 theorem per foreign key that touches the configuration cluster. -/
elab "aw_config_fk_theorems" : command => do
  for (t, n, target) in clusterForeignKeys do
    let s := catalogue t
    let tI := mkIdent (``TableName ++ ctorName (TableName.toWire t))
    let gI := mkIdent (``TableName ++ ctorName (TableName.toWire target))
    let nS := Syntax.mkStrLit n
    let fk := fkOf t n
    let ts := Syntax.mkStrLit ("packages/core/src/db/schema/" ++ s.source ++ "#" ++
      (if fk.inline then s.tsExport else n))
    let thm := mkIdent (Name.mkSimple s!"{n}_preserves_tenant")
    let doc := mkDocComment s!"In every consistent state, a `{TableName.toWire t}` row and the \
      `{TableName.toWire target}` row it references through `{n}` belong to the same workspace."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T2))
        (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
        (ts := $ts)]
      theorem $thm (st : AgentWorkspace.Er.Core.State) (hc : consistent catalogue st = true)
          {r r' : AgentWorkspace.Er.Core.Row}
          (href : References catalogue st $tI (fkOf $tI $nS) r r') :
          tenantOf catalogue $tI r = tenantOf catalogue $gI r' := by
        have h := no_cross_tenant_reference catalogue pairing st hc (by decide) href
        rwa [show (fkOf $tI $nS).refTable = $gI from by decide] at h))

end Generator

aw_config_fk_theorems

/-! ## Cardinalities -/

private theorem one_workspace {st : State} (hc : consistent catalogue st = true)
    {t : TableName} (n : String)
    (hfk : (⟨n, ["workspace_id"], .workspaces, ["id"], .cascade, true⟩ : ForeignKey) ∈
      (catalogue t).foreignKeys)
    (hnn : (catalogue t).isNotNull "workspace_id" = true) {r : Row} (hr : r ∈ st t) :
    ∃ w ∈ st .workspaces, w.get "id" = r.get "workspace_id" ∧
      ∀ w' ∈ st .workspaces, w'.get "id" = r.get "workspace_id" → w' = w := by
  have hs := not_null_holds hc hnn hr
  cases hv : r.get "workspace_id" with
  | none => rw [hv] at hs; cases hs
  | some v =>
    obtain ⟨p, hp, hpv, huniq⟩ := reaches_one hc hfk rfl rfl rfl hr hv
    exact ⟨p, hp, hpv, huniq⟩

/-- In every consistent state, a model connection belongs to exactly one workspace. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#11-vocabulary")
  (ts := "packages/core/src/db/schema/model-connections.ts#modelConnections")]
theorem model_connection_has_exactly_one_workspace (st : State)
    (hc : consistent catalogue st = true) {r : Row} (hr : r ∈ st .modelConnections) :
    ∃ w ∈ st .workspaces, w.get "id" = r.get "workspace_id" ∧
      ∀ w' ∈ st .workspaces, w'.get "id" = r.get "workspace_id" → w' = w :=
  one_workspace hc "model_connections_workspace_id_workspaces_id_fk" (by decide) (by decide) hr

/-- In every consistent state, a runtime profile belongs to exactly one workspace. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#11-vocabulary")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")]
theorem runtime_profile_has_exactly_one_workspace (st : State)
    (hc : consistent catalogue st = true) {r : Row} (hr : r ∈ st .runtimeProfiles) :
    ∃ w ∈ st .workspaces, w.get "id" = r.get "workspace_id" ∧
      ∀ w' ∈ st .workspaces, w'.get "id" = r.get "workspace_id" → w' = w :=
  one_workspace hc "runtime_profiles_workspace_id_workspaces_id_fk" (by decide) (by decide) hr

/-- In every consistent state, a secret belongs to exactly one workspace. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/04-api-specification.md#11-vocabulary")
  (ts := "packages/core/src/db/schema/secrets.ts#secrets")]
theorem secret_has_exactly_one_workspace (st : State) (hc : consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .secrets) :
    ∃ w ∈ st .workspaces, w.get "id" = r.get "workspace_id" ∧
      ∀ w' ∈ st .workspaces, w'.get "id" = r.get "workspace_id" → w' = w :=
  one_workspace hc "secrets_workspace_id_workspaces_id_fk" (by decide) (by decide) hr

/-- In every consistent state, a runtime profile that names a runtime connection names exactly
one `secrets` row, and that secret belongs to the profile's workspace. -/
@[aw_spec (tier := T2) (doc := "docs/spec.md#149-switching-the-runtime")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")]
theorem profile_connection_is_one_secret_of_its_workspace (st : State)
    (hc : consistent catalogue st = true) {r : Row} (hr : r ∈ st .runtimeProfiles) {v : String}
    (hv : r.get "runtime_connection_id" = some v) :
    ∃ s ∈ st .secrets, s.get "id" = some v ∧ s.get "workspace_id" = r.get "workspace_id" ∧
      ∀ s' ∈ st .secrets, s'.get "id" = some v → s' = s := by
  have hfk : fkOf .runtimeProfiles "runtime_profiles_runtime_connection_id_secrets_id_fk" ∈
      (catalogue .runtimeProfiles).foreignKeys := by decide
  obtain ⟨s, hs, hsv, huniq⟩ :=
    reaches_one hc hfk (c := "runtime_connection_id") (k := "id") (by decide) (by decide)
      (by decide) hr hv
  refine ⟨s, hs, hsv, ?_, huniq⟩
  have href : References catalogue st .runtimeProfiles
      (fkOf .runtimeProfiles "runtime_profiles_runtime_connection_id_secrets_id_fk") r s :=
    ⟨hfk, hr, hs, by simp [Row.present, show (fkOf .runtimeProfiles
        "runtime_profiles_runtime_connection_id_secrets_id_fk").columns =
        ["runtime_connection_id"] from by decide, hv],
      by simp [Row.project, show (fkOf .runtimeProfiles
        "runtime_profiles_runtime_connection_id_secrets_id_fk").columns =
        ["runtime_connection_id"] from by decide, show (fkOf .runtimeProfiles
        "runtime_profiles_runtime_connection_id_secrets_id_fk").refColumns = ["id"] from by decide,
        hv, hsv]⟩
  have := runtime_profiles_runtime_connection_id_secrets_id_fk_preserves_tenant st hc href
  simpa [tenantOf, TableSpec.tenantColumn?, catalogue, Tenancy.column?] using this.symm

/-! ## Identity and names -/

/-- In every consistent state, a model-connection id identifies at most one row. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/columns.ts#primaryKeyId")]
theorem model_connection_id_identifies_one_row (st : State) (hc : consistent catalogue st = true)
    {r1 r2 : Row} (h1 : r1 ∈ st .modelConnections) (h2 : r2 ∈ st .modelConnections)
    (hs : (r1.get "id").isSome = true) (hv : r1.get "id" = r2.get "id") : r1 = r2 :=
  primary_key hc (by decide) h1 h2 hs hv

/-- In every consistent state, a runtime-profile id identifies at most one row. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/columns.ts#primaryKeyId")]
theorem runtime_profile_id_identifies_one_row (st : State) (hc : consistent catalogue st = true)
    {r1 r2 : Row} (h1 : r1 ∈ st .runtimeProfiles) (h2 : r2 ∈ st .runtimeProfiles)
    (hs : (r1.get "id").isSome = true) (hv : r1.get "id" = r2.get "id") : r1 = r2 :=
  primary_key hc (by decide) h1 h2 hs hv

/-- In every consistent state, a secret id identifies at most one row. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/columns.ts#primaryKeyId")]
theorem secret_id_identifies_one_row (st : State) (hc : consistent catalogue st = true)
    {r1 r2 : Row} (h1 : r1 ∈ st .secrets) (h2 : r2 ∈ st .secrets)
    (hs : (r1.get "id").isSome = true) (hv : r1.get "id" = r2.get "id") : r1 = r2 :=
  primary_key hc (by decide) h1 h2 hs hv

private theorem name_unique {st : State} (hc : consistent catalogue st = true) {t : TableName}
    (n : String)
    (hu : (⟨n, ["workspace_id", "name"], .index, []⟩ : UniqueKey) ∈ (catalogue t).uniques)
    (hw : (catalogue t).isNotNull "workspace_id" = true)
    (hn : (catalogue t).isNotNull "name" = true) {r1 r2 : Row} (h1 : r1 ∈ st t)
    (h2 : r2 ∈ st t) (hws : r1.get "workspace_id" = r2.get "workspace_id")
    (hname : r1.get "name" = r2.get "name") : r1 = r2 :=
  unique_key hc hu rfl h1 h2
    (by simp [Row.present, not_null_holds hc hw h1, not_null_holds hc hn h1])
    (by simp [Row.project, hws, hname])

/-- In every consistent state, two model connections of one workspace with the same name are the
same row. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/model-connections.ts#modelConnections")
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")]
theorem model_connection_name_is_unique_in_its_workspace (st : State)
    (hc : consistent catalogue st = true) {r1 r2 : Row} (h1 : r1 ∈ st .modelConnections)
    (h2 : r2 ∈ st .modelConnections) (hws : r1.get "workspace_id" = r2.get "workspace_id")
    (hname : r1.get "name" = r2.get "name") : r1 = r2 :=
  name_unique hc "model_connections_workspace_name_key" (by decide) (by decide) (by decide) h1 h2
    hws hname

/-- In every consistent state, two runtime profiles of one workspace with the same name are the
same row. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfiles")
  (doc := "docs/sdk/04-api-specification.md#54-runtime-profiles-connections-and-drivers--awruntimes")]
theorem runtime_profile_name_is_unique_in_its_workspace (st : State)
    (hc : consistent catalogue st = true) {r1 r2 : Row} (h1 : r1 ∈ st .runtimeProfiles)
    (h2 : r2 ∈ st .runtimeProfiles) (hws : r1.get "workspace_id" = r2.get "workspace_id")
    (hname : r1.get "name" = r2.get "name") : r1 = r2 :=
  name_unique hc "runtime_profiles_workspace_name_key" (by decide) (by decide) (by decide) h1 h2
    hws hname

/-- In every consistent state, two secrets of one workspace with the same name are the same row,
so a model-connection credential or a runtime connection, found by name, is found at most once. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/secrets.ts#secrets")
  (doc := "docs/sdk/04-api-specification.md#55-secrets--awsecrets")]
theorem secret_name_is_unique_in_its_workspace (st : State) (hc : consistent catalogue st = true)
    {r1 r2 : Row} (h1 : r1 ∈ st .secrets) (h2 : r2 ∈ st .secrets)
    (hws : r1.get "workspace_id" = r2.get "workspace_id") (hname : r1.get "name" = r2.get "name") :
    r1 = r2 :=
  name_unique hc "secrets_workspace_name_key" (by decide) (by decide) (by decide) h1 h2 hws hname

/-! ## Closed sets -/

/-- In every consistent state, a stored model connection's provider is one of the providers. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/model-connections.ts#modelProviders")]
theorem stored_provider_is_a_provider (st : State) (hc : consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .modelConnections) :
    ∃ p : ModelConnection.Provider, r.get "provider" = some p.toWire :=
  enum_cell (n := "model_connections_provider_valid") hc (by decide) (by decide) hr

/-- In every consistent state, a stored runtime profile's driver is one of the drivers. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfileDrivers")]
theorem stored_driver_is_a_driver (st : State) (hc : consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .runtimeProfiles) :
    ∃ d : RuntimeProfile.Driver, r.get "driver" = some d.toWire :=
  enum_cell (n := "runtime_profiles_driver_valid") hc (by decide) (by decide) hr

/-- In every consistent state, a stored runtime profile's network policy is one of the policies. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/site/concepts/data-plane.mdx#what-never-changes")
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfileNetworkPolicies")]
theorem stored_network_policy_is_a_policy (st : State) (hc : consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .runtimeProfiles) :
    ∃ p : RuntimeProfile.NetworkPolicy, r.get "network_policy" = some p.toWire :=
  enum_cell (n := "runtime_profiles_network_policy_valid") hc (by decide) (by decide) hr

/-- In every consistent state, a stored runtime profile's filesystem mode is one of the modes. -/
@[aw_spec (tier := T2)
  (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtimeProfileFilesystems")]
theorem stored_filesystem_is_a_mode (st : State) (hc : consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .runtimeProfiles) :
    ∃ f : RuntimeProfile.Filesystem, r.get "filesystem" = some f.toWire :=
  enum_cell (n := "runtime_profiles_filesystem_valid") hc (by decide) (by decide) hr

/-- In every consistent state, a stored secret's algorithm is `aes-256-gcm`. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/secrets.ts#secretAlgorithms")]
theorem stored_algorithm_is_aes_gcm (st : State) (hc : consistent catalogue st = true)
    {r : Row} (hr : r ∈ st .secrets) : r.get "algorithm" = some "aes-256-gcm" := by
  obtain ⟨a, ha⟩ := enum_cell (α := Secret.Algorithm) (n := "secrets_algorithm_valid")
    (c := "algorithm") hc
    (by decide) (by decide) hr
  cases a
  exact ha

/-! ## Refined checks -/

/-- In every state where the cluster's checks hold, a stored secret has a name of the documented
shape and an envelope whose parts all have their exact sizes and a non-empty ciphertext. -/
@[aw_spec (tier := T2) (ts := "packages/core/src/db/schema/secrets.ts#secrets")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
theorem stored_secret_is_well_formed (st : State) (hc : consistentConfig st = true) {r : Row}
    (hr : r ∈ st .secrets) :
    cellOk r "name" Secret.isValidName = true ∧
      cellOk r "wrapped_data_key" (octetLength · == 32) = true ∧
      cellOk r "wrapped_data_key_nonce" (octetLength · == 12) = true ∧
      cellOk r "ciphertext_nonce" (octetLength · == 12) = true ∧
      cellOk r "wrapped_data_key_tag" (octetLength · == 16) = true ∧
      cellOk r "ciphertext_tag" (octetLength · == 16) = true ∧
      cellOk r "ciphertext" (0 < octetLength ·) = true := by
  have h1 := refined hc (t := .secrets) (n := "secrets_name_shape") (by decide) hr
  have h2 := refined hc (t := .secrets) (n := "secrets_wrapped_data_key_size") (by decide) hr
  have h3 := refined hc (t := .secrets) (n := "secrets_nonce_sizes") (by decide) hr
  have h4 := refined hc (t := .secrets) (n := "secrets_tag_sizes") (by decide) hr
  have h5 := refined hc (t := .secrets) (n := "secrets_ciphertext_not_empty") (by decide) hr
  unfold configCheckHolds at h1 h2 h3 h4 h5
  simp only [String.reduceBEq, Bool.false_eq_true, ↓reduceIte,
    Secret.wrappedDataKeyBytes,
    Secret.nonceBytes, Secret.tagBytes] at h1 h2 h3 h4 h5
  rw [Bool.and_eq_true] at h3 h4
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> first
    | simpa using h1 | simpa using h2 | simpa using h3.1 | simpa using h3.2
    | simpa using h4.1 | simpa using h4.2 | simpa using h5

/-- In every state where the cluster's checks hold, a workspace or project default model is set
exactly when its default model connection is: the model choice is always the pair. -/
@[aw_spec (tier := T2)
  (doc := "docs/sdk/04-api-specification.md#53-model-connections-and-models--awmodels")
  (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")
  (ts := "packages/core/src/db/schema/projects.ts#projects")]
theorem default_model_is_set_with_its_connection (st : State) (hc : consistentConfig st = true) :
    (∀ w ∈ st .workspaces, (w.get "default_model_connection_id").isNone =
      (w.get "default_model").isNone) ∧
    (∀ p ∈ st .projects, (p.get "default_model_connection_id").isNone =
      (p.get "default_model").isNone) := by
  constructor
  · intro w hw
    have := refined hc (t := .workspaces) (n := "workspaces_default_model_pair") (by decide) hw
    simpa [configCheckHolds, pairHolds] using this
  · intro p hp
    have := refined hc (t := .projects) (n := "projects_default_model_pair") (by decide) hp
    simpa [configCheckHolds, pairHolds] using this

/-! ## Witnesses -/

private theorem witness_consistent : consistentConfig Witness.state = true := by decide +kernel

private theorem witness_catalogue : consistent catalogue Witness.state = true := by
  have := witness_consistent
  simp only [consistentConfig, Bool.and_eq_true] at this
  exact this.1

/-- The witness references through every key of the cluster, as (child, parent) row pairs in the
order of `clusterForeignKeys`. -/
private def pairs : List (Row × Row) :=
  let ws := Witness.workspace1
  let c1 := Witness.connection "c1" "w1"
  let s1 := Witness.secret "s1" "w1" "RUNTIME_CONNECTION__DOCKER__PRIMARY"
  let s2 := Witness.secret "s2" "w1" "GITHUB_TOKEN"
  [(c1, ws), (Witness.profile, ws), (Witness.profile, s1), (Witness.profile, s1),
   (s1, ws), (Witness.agent, c1), (Witness.agent, c1), (Witness.agent, Witness.profile),
   (Witness.agent, Witness.profile), (Witness.project, c1), (Witness.project, c1),
   (Witness.run, c1), (Witness.run, c1), (ws, c1), (ws, c1), (Witness.connector, s2)]

/-- Every key of the cluster is populated in the witness: each listed pair is a reference. -/
private theorem witness_populates_every_key :
    (clusterForeignKeys.zip pairs).all (fun ((t, n, _), (r, r')) =>
      let fk := fkOf t n
      (Witness.state t).contains r && (Witness.state fk.refTable).contains r' &&
        r.present fk.columns && r'.project fk.refColumns == r.project fk.columns) = true := by
  decide +kernel

example : tenantOf catalogue .runtimeProfiles Witness.profile =
    tenantOf catalogue .secrets (Witness.secret "s1" "w1" "RUNTIME_CONNECTION__DOCKER__PRIMARY") :=
  runtime_profiles_runtime_connection_workspace_fk_preserves_tenant Witness.state witness_catalogue
    (by unfold References; decide +kernel)

example : tenantOf catalogue .runtimeProfiles Witness.profile =
    tenantOf catalogue .secrets (Witness.secret "s1" "w1" "RUNTIME_CONNECTION__DOCKER__PRIMARY") :=
  runtime_profiles_runtime_connection_id_secrets_id_fk_preserves_tenant Witness.state
    witness_catalogue (by unfold References; decide +kernel)

example : tenantOf catalogue .agents Witness.agent =
    tenantOf catalogue .modelConnections (Witness.connection "c1" "w1") :=
  agents_model_connection_id_model_connections_id_fk_preserves_tenant Witness.state
    witness_catalogue (by unfold References; decide +kernel)

example : tenantOf catalogue .agents Witness.agent =
    tenantOf catalogue .modelConnections (Witness.connection "c1" "w1") :=
  agents_model_connection_workspace_fk_preserves_tenant Witness.state witness_catalogue
    (by unfold References; decide +kernel)

example : tenantOf catalogue .agents Witness.agent =
    tenantOf catalogue .runtimeProfiles Witness.profile :=
  agents_runtime_profile_id_runtime_profiles_id_fk_preserves_tenant Witness.state
    witness_catalogue (by unfold References; decide +kernel)

example : tenantOf catalogue .agents Witness.agent =
    tenantOf catalogue .runtimeProfiles Witness.profile :=
  agents_runtime_profile_workspace_fk_preserves_tenant Witness.state witness_catalogue
    (by unfold References; decide +kernel)

example : tenantOf catalogue .projects Witness.project =
    tenantOf catalogue .modelConnections (Witness.connection "c1" "w1") :=
  projects_default_model_connection_id_model_connections_id_fk_preserves_tenant Witness.state
    witness_catalogue (by unfold References; decide +kernel)

example : tenantOf catalogue .projects Witness.project =
    tenantOf catalogue .modelConnections (Witness.connection "c1" "w1") :=
  projects_default_model_connection_workspace_fk_preserves_tenant Witness.state witness_catalogue
    (by unfold References; decide +kernel)

example : tenantOf catalogue .runs Witness.run =
    tenantOf catalogue .modelConnections (Witness.connection "c1" "w1") :=
  runs_model_connection_id_model_connections_id_fk_preserves_tenant Witness.state
    witness_catalogue (by unfold References; decide +kernel)

example : tenantOf catalogue .runs Witness.run =
    tenantOf catalogue .modelConnections (Witness.connection "c1" "w1") :=
  runs_model_connection_workspace_fk_preserves_tenant Witness.state witness_catalogue
    (by unfold References; decide +kernel)

example : tenantOf catalogue .workspaces Witness.workspace1 =
    tenantOf catalogue .modelConnections (Witness.connection "c1" "w1") :=
  workspaces_default_model_connection_id_model_connections_id_fk_preserves_tenant Witness.state
    witness_catalogue (by unfold References; decide +kernel)

example : tenantOf catalogue .workspaces Witness.workspace1 =
    tenantOf catalogue .modelConnections (Witness.connection "c1" "w1") :=
  workspaces_default_model_connection_workspace_fk_preserves_tenant Witness.state
    witness_catalogue (by unfold References; decide +kernel)

example : tenantOf catalogue .mcpServers Witness.connector =
    tenantOf catalogue .secrets (Witness.secret "s2" "w1" "GITHUB_TOKEN") :=
  mcp_servers_credential_secret_workspace_fk_preserves_tenant Witness.state witness_catalogue
    (by unfold References; decide +kernel)

example : tenantOf catalogue .modelConnections (Witness.connection "c1" "w1") =
    tenantOf catalogue .workspaces Witness.workspace1 :=
  model_connections_workspace_id_workspaces_id_fk_preserves_tenant Witness.state
    witness_catalogue (by unfold References; decide +kernel)

example : tenantOf catalogue .runtimeProfiles Witness.profile =
    tenantOf catalogue .workspaces Witness.workspace1 :=
  runtime_profiles_workspace_id_workspaces_id_fk_preserves_tenant Witness.state witness_catalogue
    (by unfold References; decide +kernel)

example : tenantOf catalogue .secrets (Witness.secret "s1" "w1" "RUNTIME_CONNECTION__DOCKER__PRIMARY") =
    tenantOf catalogue .workspaces Witness.workspace1 :=
  secrets_workspace_id_workspaces_id_fk_preserves_tenant Witness.state witness_catalogue
    (by unfold References; decide +kernel)

example : ∃ s ∈ Witness.state .secrets, s.get "id" = some "s1" ∧
    s.get "workspace_id" = Witness.profile.get "workspace_id" ∧
    ∀ s' ∈ Witness.state .secrets, s'.get "id" = some "s1" → s' = s :=
  profile_connection_is_one_secret_of_its_workspace Witness.state witness_catalogue
    (by decide +kernel) (by decide)

example : ∃ w ∈ Witness.state .workspaces, w.get "id" = (Witness.connection "c2" "w2").get "workspace_id" ∧
    ∀ w' ∈ Witness.state .workspaces,
      w'.get "id" = (Witness.connection "c2" "w2").get "workspace_id" → w' = w :=
  model_connection_has_exactly_one_workspace Witness.state witness_catalogue (by decide +kernel)

example : ∃ w ∈ Witness.state .workspaces, w.get "id" = Witness.profile.get "workspace_id" ∧
    ∀ w' ∈ Witness.state .workspaces, w'.get "id" = Witness.profile.get "workspace_id" → w' = w :=
  runtime_profile_has_exactly_one_workspace Witness.state witness_catalogue (by decide +kernel)

example : ∃ w ∈ Witness.state .workspaces,
    w.get "id" = (Witness.secret "s3" "w2" "GITHUB_TOKEN").get "workspace_id" ∧
    ∀ w' ∈ Witness.state .workspaces,
      w'.get "id" = (Witness.secret "s3" "w2" "GITHUB_TOKEN").get "workspace_id" → w' = w :=
  secret_has_exactly_one_workspace Witness.state witness_catalogue (by decide +kernel)

/-- The same name in two workspaces is two rows: uniqueness is per workspace. -/
example : Witness.secret "s2" "w1" "GITHUB_TOKEN" ≠ Witness.secret "s3" "w2" "GITHUB_TOKEN" ∧
    (Witness.secret "s2" "w1" "GITHUB_TOKEN").get "name" =
      (Witness.secret "s3" "w2" "GITHUB_TOKEN").get "name" := by decide

example : Witness.profile = Witness.profile :=
  runtime_profile_name_is_unique_in_its_workspace Witness.state witness_catalogue
    (by decide +kernel) (by decide +kernel) rfl rfl

example : Witness.connection "c1" "w1" = Witness.connection "c1" "w1" :=
  model_connection_name_is_unique_in_its_workspace Witness.state witness_catalogue
    (by decide +kernel) (by decide +kernel) rfl rfl

example : Witness.secret "s2" "w1" "GITHUB_TOKEN" = Witness.secret "s2" "w1" "GITHUB_TOKEN" :=
  secret_name_is_unique_in_its_workspace Witness.state witness_catalogue
    (by decide +kernel) (by decide +kernel) rfl rfl

example : Witness.profile = Witness.profile :=
  runtime_profile_id_identifies_one_row Witness.state witness_catalogue (by decide +kernel)
    (by decide +kernel) (by decide) rfl

example : Witness.connection "c1" "w1" = Witness.connection "c1" "w1" :=
  model_connection_id_identifies_one_row Witness.state witness_catalogue (by decide +kernel)
    (by decide +kernel) (by decide) rfl

example : Witness.secret "s1" "w1" "RUNTIME_CONNECTION__DOCKER__PRIMARY" =
    Witness.secret "s1" "w1" "RUNTIME_CONNECTION__DOCKER__PRIMARY" :=
  secret_id_identifies_one_row Witness.state witness_catalogue (by decide +kernel)
    (by decide +kernel) (by decide) rfl

example : ∃ p : ModelConnection.Provider, (Witness.connection "c1" "w1").get "provider" = some p.toWire :=
  stored_provider_is_a_provider Witness.state witness_catalogue (by decide +kernel)

example : ∃ d : RuntimeProfile.Driver, Witness.profile.get "driver" = some d.toWire :=
  stored_driver_is_a_driver Witness.state witness_catalogue (by decide +kernel)

example : ∃ p : RuntimeProfile.NetworkPolicy, Witness.profile.get "network_policy" = some p.toWire :=
  stored_network_policy_is_a_policy Witness.state witness_catalogue (by decide +kernel)

example : ∃ f : RuntimeProfile.Filesystem, Witness.profile.get "filesystem" = some f.toWire :=
  stored_filesystem_is_a_mode Witness.state witness_catalogue (by decide +kernel)

example : (Witness.secret "s2" "w1" "GITHUB_TOKEN").get "algorithm" = some "aes-256-gcm" :=
  stored_algorithm_is_aes_gcm Witness.state witness_catalogue (by decide +kernel)

example : cellOk (Witness.secret "s2" "w1" "GITHUB_TOKEN") "ciphertext" (0 < octetLength ·) = true :=
  (stored_secret_is_well_formed Witness.state witness_consistent (by decide +kernel)).2.2.2.2.2.2

example : (Witness.workspace1.get "default_model_connection_id").isNone =
    (Witness.workspace1.get "default_model").isNone :=
  (default_model_is_set_with_its_connection Witness.state witness_consistent).1 _
    (by decide +kernel)

end AgentWorkspace.Theorems.Invariants.ConceptConfiguration
