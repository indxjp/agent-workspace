import AgentWorkspace.Theorems.Invariants.ConceptConfiguration

/-!
T3 — what a writer cannot achieve against the configuration cluster, whatever ids it copies into a
row and whatever value it stores.

* **No cross-workspace configuration.** A runtime profile cannot name another workspace's runtime
  connection; an agent cannot use another workspace's model connection or runtime profile; a
  project, a workspace or a run cannot point at another workspace's model connection; a connector
  cannot use another workspace's secret as its credential. Each is stated for an arbitrary state
  and arbitrary rows: pointing across workspaces makes the state one PostgreSQL refuses.
* **Write-only values.** No response depends on a secret's value or on a model connection's
  credential: the rendered resources are equal whatever was stored (non-interference).
-/

namespace AgentWorkspace.Theorems.Adversarial.ConceptConfiguration

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts
open AgentWorkspace.Er.Current.Configuration
open AgentWorkspace.Theorems.Invariants.ConceptConfiguration

/-! ## Helpers -/

private theorem tenant_of_scoped {t : TableName} (h : (catalogue t).tenancy = .scoped) (r : Row) :
    tenantOf catalogue t r = r.get "workspace_id" := by
  simp [tenantOf, TableSpec.tenantColumn?, h, Tenancy.column?]

/-- A single-column pointer `c` of a `child` row to the `id` of a `parent` row, through the key
`n`, is a reference in the sense of `References`. -/
private theorem pointer_is_reference {st : State} {t : TableName} {n c : String}
    (hfk : fkOf t n ∈ (catalogue t).foreignKeys) (hcols : (fkOf t n).columns = [c])
    (hrcols : (fkOf t n).refColumns = ["id"]) {r p : Row} (hr : r ∈ st t)
    (hp : p ∈ st (fkOf t n).refTable) (hid : r.get c = p.get "id")
    (hsome : (p.get "id").isSome = true) : References catalogue st t (fkOf t n) r p := by
  refine ⟨hfk, hr, hp, ?_, ?_⟩
  · simp [Row.present, hcols, hid, hsome]
  · simp [Row.project, hcols, hrcols, hid]

/-! ## No cross-workspace configuration -/

/-- Whatever runtime-connection id a writer puts on a runtime profile, naming a secret of another
workspace makes the state inconsistent: PostgreSQL refuses it. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/schema/runtime-profiles.ts#runtime_profiles_runtime_connection_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem profile_cannot_name_another_workspaces_connection (st : State) {r s : Row}
    (hr : r ∈ st .runtimeProfiles) (hs : s ∈ st .secrets)
    (hid : r.get "runtime_connection_id" = s.get "id") (hsome : (s.get "id").isSome = true)
    (hws : r.get "workspace_id" ≠ s.get "workspace_id") : consistent catalogue st = false := by
  cases hc : consistent catalogue st
  · rfl
  · exfalso; apply hws
    have := runtime_profiles_runtime_connection_id_secrets_id_fk_preserves_tenant st hc
      (pointer_is_reference (by decide) (by decide) (by decide) hr hs hid hsome)
    rwa [tenant_of_scoped rfl, tenant_of_scoped rfl] at this

/-- Whatever model-connection id a writer puts on an agent, naming a connection of another
workspace makes the state inconsistent. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/schema/agents.ts#agents_model_connection_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem agent_cannot_use_another_workspaces_model_connection (st : State) {r m : Row}
    (hr : r ∈ st .agents) (hm : m ∈ st .modelConnections)
    (hid : r.get "model_connection_id" = m.get "id") (hsome : (m.get "id").isSome = true)
    (hws : r.get "workspace_id" ≠ m.get "workspace_id") : consistent catalogue st = false := by
  cases hc : consistent catalogue st
  · rfl
  · exfalso; apply hws
    have := agents_model_connection_id_model_connections_id_fk_preserves_tenant st hc
      (pointer_is_reference (by decide) (by decide) (by decide) hr hm hid hsome)
    rwa [tenant_of_scoped rfl, tenant_of_scoped rfl] at this

/-- Whatever runtime-profile id a writer puts on an agent, naming a profile of another workspace
makes the state inconsistent. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/schema/agents.ts#agents_runtime_profile_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem agent_cannot_use_another_workspaces_runtime_profile (st : State) {r p : Row}
    (hr : r ∈ st .agents) (hp : p ∈ st .runtimeProfiles)
    (hid : r.get "runtime_profile_id" = p.get "id") (hsome : (p.get "id").isSome = true)
    (hws : r.get "workspace_id" ≠ p.get "workspace_id") : consistent catalogue st = false := by
  cases hc : consistent catalogue st
  · rfl
  · exfalso; apply hws
    have := agents_runtime_profile_id_runtime_profiles_id_fk_preserves_tenant st hc
      (pointer_is_reference (by decide) (by decide) (by decide) hr hp hid hsome)
    rwa [tenant_of_scoped rfl, tenant_of_scoped rfl] at this

/-- Whatever default connection a writer puts on a project, naming a connection of another
workspace makes the state inconsistent. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/schema/projects.ts#projects")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem project_cannot_default_to_another_workspaces_connection (st : State) {r m : Row}
    (hr : r ∈ st .projects) (hm : m ∈ st .modelConnections)
    (hid : r.get "default_model_connection_id" = m.get "id") (hsome : (m.get "id").isSome = true)
    (hws : r.get "workspace_id" ≠ m.get "workspace_id") : consistent catalogue st = false := by
  cases hc : consistent catalogue st
  · rfl
  · exfalso; apply hws
    have := projects_default_model_connection_id_model_connections_id_fk_preserves_tenant st hc
      (pointer_is_reference (by decide) (by decide) (by decide) hr hm hid hsome)
    rwa [tenant_of_scoped rfl, tenant_of_scoped rfl] at this

/-- Whatever connection a writer records on a run, naming a connection of another workspace makes
the state inconsistent. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/schema/runs.ts#runs_model_connection_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem run_cannot_record_another_workspaces_connection (st : State) {r m : Row}
    (hr : r ∈ st .runs) (hm : m ∈ st .modelConnections)
    (hid : r.get "model_connection_id" = m.get "id") (hsome : (m.get "id").isSome = true)
    (hws : r.get "workspace_id" ≠ m.get "workspace_id") : consistent catalogue st = false := by
  cases hc : consistent catalogue st
  · rfl
  · exfalso; apply hws
    have := runs_model_connection_id_model_connections_id_fk_preserves_tenant st hc
      (pointer_is_reference (by decide) (by decide) (by decide) hr hm hid hsome)
    rwa [tenant_of_scoped rfl, tenant_of_scoped rfl] at this

/-- Whatever default connection a writer puts on a workspace, naming a connection of another
workspace makes the state inconsistent. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem workspace_cannot_default_to_another_workspaces_connection (st : State) {w m : Row}
    (hw : w ∈ st .workspaces) (hm : m ∈ st .modelConnections)
    (hid : w.get "default_model_connection_id" = m.get "id") (hsome : (m.get "id").isSome = true)
    (hws : w.get "id" ≠ m.get "workspace_id") : consistent catalogue st = false := by
  cases hc : consistent catalogue st
  · rfl
  · exfalso; apply hws
    have := workspaces_default_model_connection_id_model_connections_id_fk_preserves_tenant st hc
      (pointer_is_reference (by decide) (by decide) (by decide) hw hm hid hsome)
    simpa [tenantOf, TableSpec.tenantColumn?, catalogue, Tenancy.column?] using this

private theorem table_consistent {st : State} (hc : consistent catalogue st = true)
    (t : TableName) : tableConsistent catalogue st t = true :=
  List.all_eq_true.mp hc t (WireEnum.complete t)

/-- Whatever secret id a writer puts on a connector as its credential, naming a secret of another
workspace makes the state inconsistent: the composite key finds no secret with that id in the
connector's workspace, and the id identifies one secret. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/schema/mcp-servers.ts#mcp_servers_credential_secret_workspace_fk")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem connector_cannot_use_another_workspaces_secret (st : State) {k s : Row}
    (hk : k ∈ st .mcpServers) (hs : s ∈ st .secrets)
    (hid : k.get "credential_secret_id" = s.get "id") (hsome : (s.get "id").isSome = true)
    (hws : k.get "workspace_id" ≠ s.get "workspace_id") : consistent catalogue st = false := by
  cases hc : consistent catalogue st
  · rfl
  · exfalso; apply hws
    have hfk : fkOf .mcpServers "mcp_servers_credential_secret_workspace_fk" ∈
        (catalogue .mcpServers).foreignKeys := by decide
    have hcols : (fkOf .mcpServers "mcp_servers_credential_secret_workspace_fk").columns =
        ["credential_secret_id", "workspace_id"] := by decide
    have hrcols : (fkOf .mcpServers "mcp_servers_credential_secret_workspace_fk").refColumns =
        ["id", "workspace_id"] := by decide
    have hnn : (k.get "workspace_id").isSome = true := by
      have h := table_consistent hc .mcpServers
      simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
      have := h.1.1.1.1 ⟨"workspace_id", .uuid, true⟩ (by decide)
      simp only [notNullHolds, Bool.not_true, Bool.false_or, List.all_eq_true] at this
      exact this k hk
    have hh : fkHolds st .mcpServers (fkOf .mcpServers "mcp_servers_credential_secret_workspace_fk")
        = true := by
      have h := table_consistent hc .mcpServers
      simp only [tableConsistent, Bool.and_eq_true, List.all_eq_true] at h
      exact h.1.2 _ hfk
    have := List.all_eq_true.mp hh k hk
    simp only [Row.present, hcols, List.all_cons, List.all_nil, Bool.and_true, hid, hsome,
      hnn, Bool.not_true, Bool.false_or, List.any_eq_true,
      show (fkOf .mcpServers "mcp_servers_credential_secret_workspace_fk").refTable = .secrets
        from by decide] at this
    obtain ⟨p, hp, hpv⟩ := this
    simp only [Row.project, hrcols, List.map_cons, List.map_nil, beq_iff_eq,
      List.cons.injEq, and_true] at hpv
    have hps : p = s := secret_id_identifies_one_row st hc hp hs
      (by rw [hpv.1, hid]; exact hsome) (by rw [hpv.1, hid])
    rw [← hps, hpv.2]

/-! ## Write-only values -/

/-- Whatever value, ciphertext and envelope parts a secret holds, its rendered resource is the
same: only the master-key id of the envelope reaches the wire. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/site/concepts/data-plane.mdx#what-never-changes")
  (ts := "apps/web/server/secrets/contract.ts#toSecretResource")]
theorem secret_resource_ignores_the_value (s : Secret.Secret) (e : Secret.Envelope) :
    ({ s with envelope := { e with masterKeyId := s.envelope.masterKeyId } } : Secret.Secret).toResource =
      s.toResource := rfl

/-- Whatever credential a model connection stores, its rendered resource is the same: only the
fact that one exists reaches the wire. -/
@[aw_spec (tier := T3) (doc := "docs/sdk/site/concepts/public-surface.mdx#configure-the-resources")
  (ts := "apps/web/server/models/contract.ts#toModelConnectionResource")]
theorem model_connection_resource_ignores_the_credential (m : ModelConnection.ModelConnection)
    (a b : String) : m.toResource (some a) = m.toResource (some b) := rfl

/-! ## Witnesses: the forged pointers are expressible -/

/-- A row of the witness with one column pointed elsewhere. -/
private def repoint (r : Row) (col v : String) : Row :=
  ⟨r.cells.map fun (c, x) => if c == col then (c, v) else (c, x)⟩

/-- The witness state with table `t` replaced by `rows`. -/
private def with_ (t : TableName) (rows : List Row) : State := fun u =>
  if u = t then rows else Witness.state u

/-- A runtime profile of the second workspace. -/
private def otherProfile : Row :=
  ⟨[("id", "rp2"), ("workspace_id", "w2"), ("name", "other"), ("driver", "docker"),
    ("network_policy", "none"), ("filesystem", "read-only"), ("created_at", "t0"),
    ("updated_at", "t0")]⟩

example : consistent catalogue
    (with_ .runtimeProfiles [repoint Witness.profile "runtime_connection_id" "s3"]) = false :=
  profile_cannot_name_another_workspaces_connection _
    (r := repoint Witness.profile "runtime_connection_id" "s3")
    (s := Witness.secret "s3" "w2" "GITHUB_TOKEN")
    (by decide +kernel) (by decide +kernel) (by decide) (by decide) (by decide)

/-- The same forgery, refused directly by the constraint predicates. -/
example : consistent catalogue
    (with_ .runtimeProfiles [repoint Witness.profile "runtime_connection_id" "s3"]) = false := by
  decide +kernel

example : consistent catalogue
    (with_ .agents [repoint Witness.agent "model_connection_id" "c2"]) = false :=
  agent_cannot_use_another_workspaces_model_connection _
    (r := repoint Witness.agent "model_connection_id" "c2") (m := Witness.connection "c2" "w2")
    (by decide +kernel) (by decide +kernel) (by decide) (by decide) (by decide)

example : consistent catalogue (fun t =>
      if t = .runtimeProfiles then [Witness.profile, otherProfile]
      else if t = .agents then [repoint Witness.agent "runtime_profile_id" "rp2"]
      else Witness.state t) = false :=
  agent_cannot_use_another_workspaces_runtime_profile _
    (r := repoint Witness.agent "runtime_profile_id" "rp2") (p := otherProfile)
    (by decide +kernel) (by decide +kernel) (by decide) (by decide) (by decide)

example : consistent catalogue
    (with_ .projects [repoint Witness.project "default_model_connection_id" "c2"]) = false :=
  project_cannot_default_to_another_workspaces_connection _
    (r := repoint Witness.project "default_model_connection_id" "c2")
    (m := Witness.connection "c2" "w2")
    (by decide +kernel) (by decide +kernel) (by decide) (by decide) (by decide)

example : consistent catalogue (with_ .runs [repoint Witness.run "model_connection_id" "c2"]) =
    false :=
  run_cannot_record_another_workspaces_connection _
    (r := repoint Witness.run "model_connection_id" "c2") (m := Witness.connection "c2" "w2")
    (by decide +kernel) (by decide +kernel) (by decide) (by decide) (by decide)

example : consistent catalogue (with_ .workspaces
      [repoint Witness.workspace1 "default_model_connection_id" "c2"]) = false :=
  workspace_cannot_default_to_another_workspaces_connection _
    (w := repoint Witness.workspace1 "default_model_connection_id" "c2")
    (m := Witness.connection "c2" "w2")
    (by decide +kernel) (by decide +kernel) (by decide) (by decide) (by decide)

example : consistent catalogue
    (with_ .mcpServers [repoint Witness.connector "credential_secret_id" "s3"]) = false :=
  connector_cannot_use_another_workspaces_secret _
    (k := repoint Witness.connector "credential_secret_id" "s3")
    (s := Witness.secret "s3" "w2" "GITHUB_TOKEN")
    (by decide +kernel) (by decide +kernel) (by decide) (by decide) (by decide)

end AgentWorkspace.Theorems.Adversarial.ConceptConfiguration
