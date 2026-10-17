import AgentWorkspace.Er.Current.Catalog

/-!
T5 — properties of the catalog specification itself: where two of its layers disagree, or where
a document's sentence and the code part ways. Each theorem pins one entry of the unit's findings
(`docs/formal/units/concept-catalog.md`), so that fixing the code or the document breaks the
theorem by name.
-/

namespace AgentWorkspace.Theorems.Meta.ConceptCatalog

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Catalog
open AgentWorkspace.Concepts

private def blankNameBody : Connector.Body :=
  { name := .str "   ", transport := .str "stdio", command := .str "npx" }

/-- Finding: the create parser and the table disagree on a blank name. `parseCreateConnectorBody`
admits a name of three spaces (`/^.{1,200}$/u`), and the row it produces fails
`mcp_servers_name_not_blank`, so the database, not the route, refuses it. -/
@[aw_spec (tier := T5) (ts := "apps/web/server/connectors/contract.ts#parseCreateConnectorBody")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")]
theorem blank_connector_name_passes_the_parser_but_not_the_check :
    ∃ p, Connector.parseBody (some blankNameBody) = .ok p ∧
      (p.toConnector ⟨"c1"⟩ ⟨"w1"⟩ ⟨"s1"⟩ none ⟨"p1"⟩).nameNotBlank = false ∧
      (p.toConnector ⟨"c1"⟩ ⟨"w1"⟩ ⟨"s1"⟩ none ⟨"p1"⟩).valid = false :=
  ⟨_, rfl, by decide, by decide⟩

private def openapiRow (sec : Option SecretId) : Connector.ToolConnector :=
  ⟨⟨"c3"⟩, ⟨"w1"⟩, "petstore", .openapi, "{\"auth\": {\"type\": \"bearer\"}}", sec, true, none,
    ⟨"p1"⟩⟩

/-- Declared gap (ADR-0113 C15): the database does not read inside `tool_config`, so whether an
`openapi` connector names a credential is not tied to its configured authentication. A row whose
`tool_config` asks for a bearer token passes every check of `mcp_servers` with a credential and
without one; the server's admission and `ConnectorResourceSchema` enforce the pairing. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (doc := "docs/adr/0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md#sd1--tools-are-catalog-connectors-of-kind-openapi-or-postgres")]
theorem openapi_credential_pairing_is_not_a_database_check :
    (openapiRow (some ⟨"s1"⟩)).valid = true ∧ (openapiRow none).valid = true := by
  decide

/-- Finding: a repeated file id in an assignment body is reported as an unknown file, although it
names a file of the catalog; the same repetition of a skill or connector id is merged silently. -/
@[aw_spec (tier := T5)
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")
  (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
theorem repeated_ids_are_treated_differently_by_kind (p : Agent.Permissions)
    (cat : Grant.CatalogIds) (f k : String) (a : Grant.FileAccess) (hk : k ∈ cat.skills) :
    Grant.replace (some p) cat ⟨[⟨f, a⟩, ⟨f, a⟩], [], []⟩ = .unknownFile f ∧
      Grant.replace (some p) cat ⟨[], [k, k], []⟩ = .updated ⟨[], [k], []⟩ := by
  constructor
  · simp [Grant.replace, Grant.firstRepeat, Grant.firstRepeat.go]
  · simp [Grant.replace, Grant.firstRepeat, Grant.firstRepeat.go, Grant.dedup, hk,
      Grant.readBack, Grant.sortByKey, Grant.insertByKey]

example : Grant.replace (some ⟨true, true, false, false⟩) ⟨["f1"], ["k1"], []⟩
    ⟨[⟨"f1", .read⟩, ⟨"f1", .read⟩], [], []⟩ = .unknownFile "f1" ∧
    Grant.replace (some ⟨true, true, false, false⟩) ⟨["f1"], ["k1"], []⟩ ⟨[], ["k1", "k1"], []⟩ =
      .updated ⟨[], ["k1"], []⟩ :=
  repeated_ids_are_treated_differently_by_kind _ _ "f1" "k1" .read (by decide)

/-- Finding: 04 §2 says every row that can be own or other carries `ownerPrincipalId`, and the
tables do, but only the agent and connector bodies carry it on the wire; the file and skill
bodies carry neither the owner nor the creator. -/
@[aw_spec (tier := T5) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/contracts/src/files.ts#FileResourceSchema")
  (ts := "packages/contracts/src/skills.ts#SkillDetailSchema")]
theorem file_and_skill_bodies_carry_no_owner :
    (resourceTables.all fun t => (catalogue t).isNotNull "owner_principal_id") = true ∧
      "ownerPrincipalId" ∈ Agent.wireFields ∧ "ownerPrincipalId" ∈ Connector.wireFields ∧
      "ownerPrincipalId" ∉ File.wireFields ∧ "ownerPrincipalId" ∉ Skill.wireFields ∧
      "createdBy" ∉ File.wireFields ∧ "createdBy" ∉ Skill.wireFields := by
  decide

private def member (i u : String) (revoked : Bool) : Grant.PrincipalView :=
  ⟨⟨i⟩, some ⟨u⟩, revoked⟩

/-- Finding: a grant is stored against the user, not the principal, so revoking a membership
principal hides its grant from `listPrincipalIds` without removing the row; the run check, which
reads by user id, still finds it, and un-revoking the principal would show it again. Today no
code path revokes a membership principal (removing a member deletes the membership, which
cascades), so the divergence is latent. -/
@[aw_spec (tier := T5)
  (ts := "packages/core/src/db/repositories/agent-grants.ts#createDatabaseAgentGrantRepositoryProvider")
  (ts := "apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership")
  (doc := "docs/sdk/site/concepts/workspaces-and-principals.mdx#workspace-and-principal")]
theorem revoked_principal_keeps_a_hidden_grant :
    let users : List UserId := [⟨"u2"⟩]
    Grant.grantsRead [member "p2" "u2" true] users = [] ∧ Grant.hasGrant users ⟨"u2"⟩ = true ∧
      Grant.grantsRead [member "p2" "u2" false] users = [⟨"p2"⟩] := by
  decide

/-- Finding: the ownership page draws the grant edge to "a person or API key", but a grant can
only name a membership principal: an API-key principal is always `principal-not-found`. -/
@[aw_spec (tier := T5)
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#catalog-assignment-grant")
  (ts := "packages/core/src/db/repositories/agent-grants.ts#createDatabaseAgentGrantRepositoryProvider")]
theorem an_api_key_principal_cannot_be_granted (ps : List Grant.PrincipalView) (r : PrincipalId)
    (hkey : ∀ p ∈ ps, p.id = r → p.user = none) :
    Grant.grantsReplace true ps [r] = .principalNotFound r := by
  have hnone : Grant.lookupGrantable ps r = none := by
    unfold Grant.lookupGrantable
    rw [List.find?_eq_none]
    intro p hp
    simp only [Bool.and_eq_true, beq_iff_eq, Grant.PrincipalView.grantable, not_and]
    intro hid
    simp [hkey p hp hid]
  simp [Grant.grantsReplace, hnone]

example : Grant.grantsReplace true [⟨⟨"k1"⟩, none, false⟩] [⟨"k1"⟩] = .principalNotFound ⟨"k1"⟩ :=
  an_api_key_principal_cannot_be_granted _ _ (by decide)

/-- Two slug grammars coexist: a skill name may start with a digit and repeat a hyphen, which the
`oneOf` value gate for closed sets refuses, while a closed-set value such as `read-write`
satisfies both. -/
@[aw_spec (tier := T5) (ts := "packages/contracts/src/skills.ts#SKILL_NAME_PATTERN")
  (ts := "packages/core/src/db/schema/one-of.ts#SAFE_VALUE")]
theorem skill_names_and_closed_set_values_are_different_slugs :
    Skill.nameShape "1password" = true ∧ isSafeValue "1password" = false ∧
      Skill.nameShape "a--b" = true ∧ isSafeValue "a--b" = false ∧
      Skill.nameShape "read-write" = true ∧ isSafeValue "read-write" = true := by
  decide

/-- The word "grant" names two tables: the data-plane page's "read-only grant" is an `agent_files`
assignment (it has an `access`), while an agent grant (`agent_grants`) has none. The two are
different relations with different endpoints. -/
@[aw_spec (tier := T5)
  (doc := "docs/sdk/site/concepts/data-plane.mdx#how-a-file-a-skill-and-a-secret-move-through-it")
  (ts := "packages/core/src/db/schema/agent-files.ts#agentFiles")
  (ts := "packages/core/src/db/schema/agent-grants.ts#agentGrants")]
theorem grant_names_two_different_relations :
    (fk .agentFiles "agent_files_file_workspace_fk").refTable = .files ∧
      (fk .agentGrants "agent_grants_member_workspace_fk").refTable = .memberships ∧
      (catalogue .agentFiles).hasColumn "access" = true ∧
      (catalogue .agentGrants).hasColumn "access" = false := by
  decide

private def divergedKey : File.File :=
  ⟨⟨"f1"⟩, ⟨"w1"⟩, "docs/a.md", .file, some "objects/7f3a", 3, none, none, ⟨"p1"⟩⟩

/-- Finding: `files.ts` says the object key "is stored rather than derived from `path`" and "the
two identifiers are allowed to diverge", but a subtree move cuts the key by the length of the old
path prefix whatever the key holds, so a file whose key is not its path gets a key that names no
object. -/
@[aw_spec (tier := T5) (ts := "packages/core/src/db/schema/files.ts#files")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
theorem rename_rewrites_a_diverged_key_blindly :
    File.renameByPrefix "docs" "archive" [divergedKey] =
      [{ divergedKey with path := "archive/a.md", storageKey := some "archivects/7f3a" }] ∧
      divergedKey.valid = true := by
  decide

private def uploadedA : File.File :=
  ⟨⟨"f1"⟩, ⟨"w1"⟩, "docs/a.md", .file, some "docs/a.md", 3, none, some ⟨"u1"⟩, ⟨"p1"⟩⟩
private def reupload : File.PutFile :=
  ⟨"docs/a.md", .file, some "docs/a.md", 5, none, some ⟨"u2"⟩, ⟨"p2"⟩⟩

/-- Finding: the ownership page says that putting a file in the catalog makes you its
`owner_principal_id`, but uploading to a path that already exists keeps the previous owner and
creator (the catalog's upsert "never transfers it"), so the caller `p2` does not become the owner
of `docs/a.md` that `p1` uploaded first; the same holds for a skill imported under an existing
name. -/
@[aw_spec (tier := T5)
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#what-you-can-and-cannot-do-today")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#CatalogFile")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#CatalogSkill")]
theorem uploading_over_an_existing_path_does_not_make_the_caller_owner :
    File.putFile ⟨"w1"⟩ ⟨"f9"⟩ reupload [uploadedA] =
        [{ uploadedA with sizeBytes := 5 }] ∧
      (File.putFile ⟨"w1"⟩ ⟨"f9"⟩ reupload [uploadedA]).all (·.owner != reupload.owner) = true ∧
      (Skill.putSkill ⟨"w1"⟩ ⟨"k9"⟩ ⟨"notes", "# v2", true, some ⟨"u2"⟩, ⟨"p2"⟩⟩
          [⟨⟨"k1"⟩, ⟨"w1"⟩, "notes", "# v1", true, some ⟨"u1"⟩, ⟨"p1"⟩⟩]).all
        (·.owner != ⟨"p2"⟩) = true := by
  decide

end AgentWorkspace.Theorems.Meta.ConceptCatalog
