import AgentWorkspace.Er.Current.Catalog

/-!
T1 — documented sentences about agents, skills, files, connectors, assignments and grants, each
stated as a theorem over the concept or the table catalogue and cited to the sentence.
-/

namespace AgentWorkspace.Theorems.Normative.ConceptCatalog

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Catalog
open AgentWorkspace.Concepts

/-! ## Connectors (04 §5.8) -/

/-- "`credential` is required iff `authType !== 'none'`": a valid connector row references a
credential secret exactly when its authentication type is not `none`. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem connector_credential_iff_auth_type_is_not_none (c : Connector.Connector)
    (h : c.valid = true) : c.credentialSecret.isSome = true ↔ c.authType ≠ .none := by
  simp only [Connector.Connector.valid, Connector.Connector.credentialRequired, Bool.and_eq_true,
    beq_iff_eq] at h
  rw [← h.1.2]
  cases c.authType <;> simp [Connector.AuthType.needsCredential]

/-- "`url` must start with `http(s)://` and only with `http`/`sse`": a valid connector has a URL
exactly when its transport is remote, and every URL it has is absolute `http(s)`. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem connector_url_only_for_remote_and_absolute (c : Connector.Connector)
    (h : c.valid = true) :
    (c.url.isSome = true ↔ c.transport.isRemote = true) ∧ c.url.all Connector.urlShape = true := by
  simp only [Connector.Connector.valid, Connector.Connector.remoteHasUrl,
    Connector.Connector.urlShapeOk, Bool.and_eq_true, beq_iff_eq] at h
  exact ⟨by rw [h.1.1.1.1.1.2], h.1.1.2⟩

/-- "`args` only with `stdio`": a valid connector with arguments is a `stdio` connector. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem connector_args_only_for_stdio (c : Connector.Connector) (h : c.valid = true)
    (ha : c.args.isSome = true) : c.transport = .stdio := by
  simp only [Connector.Connector.valid, Connector.Connector.argsStdioOnly, Bool.and_eq_true,
    Bool.or_eq_true, beq_iff_eq, Option.isNone_iff_eq_none] at h
  rcases h.1.1.1.1.2 with hn | hs
  · simp [hn] at ha
  · exact hs

/-- The one-of of `mcp_servers`: a valid connector has exactly one of a command and a URL, and
which one is decided by the transport. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem connector_has_exactly_one_of_command_and_url (c : Connector.Connector)
    (h : c.valid = true) :
    c.command.isSome = !c.url.isSome ∧ (c.command.isSome = true ↔ c.transport = .stdio) := by
  simp only [Connector.Connector.valid, Connector.Connector.stdioHasCommand,
    Connector.Connector.remoteHasUrl, Bool.and_eq_true, beq_iff_eq] at h
  obtain ⟨⟨⟨⟨⟨⟨hs, hr⟩, -⟩, -⟩, -⟩, -⟩, -⟩ := h
  rw [← hs, ← hr]
  cases c.transport <;> simp [Connector.Transport.isRemote]

/-- "The credential is write-only: `hasCredential` says whether one is on file": two rows that
differ only in which secret they reference, but both have one or both have none, render the same
resource. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/contracts/src/connectors.ts#ConnectorResourceSchema")]
theorem connector_resource_reveals_only_that_a_credential_exists (c : Connector.Connector)
    (s s' : Option SecretId) (h : s.isSome = s'.isSome) :
    Connector.Connector.toResource { c with credentialSecret := s } =
      Connector.Connector.toResource { c with credentialSecret := s' } := by
  simp [Connector.Connector.toResource, h]

/-- A valid connector's resource says it has a credential exactly when its authentication type
needs one. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/contracts/src/connectors.ts#ConnectorResourceSchema")]
theorem connector_has_credential_iff_it_needs_one (c : Connector.Connector) (h : c.valid = true) :
    c.toResource.hasCredential = c.authType.needsCredential := by
  simp only [Connector.Connector.valid, Connector.Connector.credentialRequired, Bool.and_eq_true,
    beq_iff_eq] at h
  simp [Connector.Connector.toResource, h.1.2]

/-- "No field a credential value could occupy": `ConnectorResourceSchema` has no key that starts
with `credential`, and carries `hasCredential` instead. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/contracts/src/connectors.ts#ConnectorResourceSchema")]
theorem connector_wire_carries_no_credential_field :
    (Connector.wireFields.all fun f => !"credential".toList.isPrefixOf f.toList) = true ∧
      "hasCredential" ∈ Connector.wireFields := by
  decide

/-- A valid tool connector (ADR-0113 C15) is of kind `openapi` or `postgres`, its `tool_config`
is a JSON object, and a `postgres` connector names its credential. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md#sd1--tools-are-catalog-connectors-of-kind-openapi-or-postgres")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem tool_connector_is_a_tool_kind_with_an_object_config (t : Connector.ToolConnector)
    (h : t.valid = true) :
    t.kind ≠ .mcp ∧ Connector.jsonbObject t.toolConfig = true ∧
      (t.kind = .postgres → t.credentialSecret.isSome = true) := by
  obtain ⟨id, ws, name, kind, tc, sec, en, cb, own⟩ := t
  cases kind <;> cases sec <;> simp_all [Connector.ToolConnector.valid]

private def stdioBody : Connector.Body :=
  { name := .str "Files", transport := .str "stdio", command := .str "npx" }

private def bearerWithoutCredential : Connector.Body :=
  { name := .str "G", transport := .str "http", url := .str "https://example.com/mcp", authType := .str "bearer" }

private def noneWithCredential : Connector.Body :=
  { name := .str "G", transport := .str "http", url := .str "https://example.com/mcp", credential := .str "secret" }

private def stdioWithUrl : Connector.Body :=
  { name := .str "F", transport := .str "stdio", command := .str "npx", url := .str "https://example.com" }

private def sseWithCommand : Connector.Body :=
  { name := .str "G", transport := .str "sse", url := .str "https://example.com/sse", command := .str "npx", args := .strs [] }

/-- "`authType` defaults to `none`": a create body with no `authType`, or with `null`, is parsed
as `none`. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "apps/web/server/connectors/contract.ts#parseCreateConnectorBody")]
theorem absent_or_null_auth_type_is_none :
    ((Connector.parseBody (some stdioBody)).toOption.map (·.authType)) = some .none ∧
      ((Connector.parseBody (some { stdioBody with authType := .null })).toOption.map
        (·.authType)) = some .none := by
  decide

/-- "`credential` is required iff `authType !== 'none'`" at the create route: a `bearer` body
with no credential and a `none` body with one are both refused, naming the field. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "apps/web/server/connectors/contract.ts#parseCreateConnectorBody")]
theorem create_refuses_a_missing_or_a_superfluous_credential :
    Connector.parseBody (some bearerWithoutCredential) =
      .error ["\"credential\" is required when \"authType\" is \"bearer\""] ∧
    Connector.parseBody (some noneWithCredential) =
      .error ["\"credential\" must not be supplied when \"authType\" is \"none\""] := by
  constructor <;> rfl

/-- "Only with `http`/`sse`" and "`args` only with `stdio`" at the create route: a `stdio` body
with a URL and a remote body with a command and arguments are refused, naming each field. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "apps/web/server/connectors/contract.ts#parseCreateConnectorBody")]
theorem create_refuses_fields_of_the_other_transport :
    Connector.parseBody (some stdioWithUrl) =
      .error ["\"url\" is not valid for a stdio connector"] ∧
    Connector.parseBody (some sseWithCommand) =
      .error ["\"command\" is not valid for a remote connector",
        "\"args\" is not valid for a remote connector"] := by
  constructor <;> rfl

/-- "A body without `kind` is an MCP connector" (ADR-0113 C15): a create body whose `kind` is
absent or `"mcp"` is admitted exactly as the unchanged MCP rule parses it, errors included. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md#sd1--tools-are-catalog-connectors-of-kind-openapi-or-postgres")
  (ts := "apps/web/server/connectors/contract.ts#connectorKindOfBody")]
theorem admit_absent_kind_is_the_mcp_rule (b : Connector.Body)
    (h : b.kind = .absent ∨ b.kind = .str "mcp") :
    Connector.admit (some b) = (Connector.parseBody (some b)).map .mcp := by
  rcases h with h | h <;> simp only [Connector.admit, Connector.kindOf, h] <;> rfl

/-- "`kind` is one of `mcp`, `openapi`, `postgres`": a create body whose `kind` is present but
not exactly one of those spellings (`null`, a non-string, or any other string, `"MCP"` included)
is refused with the single kind error, whatever its other fields are. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md#sd1--tools-are-catalog-connectors-of-kind-openapi-or-postgres")
  (ts := "apps/web/server/connectors/contract.ts#connectorKindOfBody")
  (ts := "apps/web/server/connectors/contract.ts#KIND_ERROR")]
theorem admit_refuses_an_unknown_kind (b : Connector.Body) (h : b.kind ≠ .absent)
    (hs : ∀ s, b.kind = .str s → s ∉ ["mcp", "openapi", "postgres"]) :
    Connector.admit (some b) = .error [Connector.kindError] := by
  have hw : WireEnum.wires Connector.Kind = ["mcp", "openapi", "postgres"] := rfl
  simp only [Connector.admit]
  cases hk : b.kind with
  | absent => exact absurd hk h
  | str s =>
    have hn : WireEnum.ofWire? (α := Connector.Kind) s = none :=
      (WireEnum.ofWire?_eq_none_iff s).mpr (hw ▸ hs s hk)
    simp only [Connector.kindOf, hn]
  | null => rfl
  | strs _ => rfl
  | other => rfl

/-- "Tools are catalog connectors of kind `openapi` or `postgres`": a create body naming a tool
kind is handed to that kind's own schema without the MCP rule reading any other field, so no
MCP error can reach a tool body. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md#sd1--tools-are-catalog-connectors-of-kind-openapi-or-postgres")
  (ts := "apps/web/server/connectors/contract.ts#connectorKindOfBody")]
theorem admit_tool_kind_defers (b : Connector.Body) (k : Connector.Kind) (hk : k ≠ .mcp)
    (h : b.kind = .str (WireEnum.toWire k)) :
    Connector.admit (some b) = .ok (.tool k) := by
  cases k with
  | mcp => exact absurd rfl hk
  | openapi => simp only [Connector.admit, Connector.kindOf, h, WireEnum.ofWire?_toWire]
  | postgres => simp only [Connector.admit, Connector.kindOf, h, WireEnum.ofWire?_toWire]

/-- "Connectors (MCP servers)": a connector is exactly a row of `mcp_servers`. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (ts := "packages/contracts/src/connectors.ts#ConnectorResourceSchema")]
theorem connector_is_an_mcp_servers_row :
    TableName.idKind? .mcpServers = some .connector ∧
      (allTables.filter fun t => TableName.idKind? t == some .connector) = [.mcpServers] := by
  decide

/-! ## Skills (04 §5.7) -/

private theorem all_of_nameShape {n : String} (h : Skill.nameShape n = true) :
    (n.toList.all Skill.isNameChar) = true ∧ 1 ≤ n.toList.length ∧
      n.toList.length ≤ Skill.maxNameLength := by
  unfold Skill.nameShape at h
  split at h
  · simp at h
  · rename_i c rest hcs
    simp only [Bool.and_eq_true, decide_eq_true_eq] at h
    obtain ⟨⟨⟨he, hr⟩, -⟩, hl⟩ := h
    refine ⟨?_, by simp [hcs], hl⟩
    rw [hcs, List.all_cons, hr, Bool.and_true]
    unfold Skill.isNameEdge at he
    unfold Skill.isNameChar
    simp only [Bool.or_eq_true] at he ⊢
    exact Or.inl he

/-- "A skill is addressed by `name` (1–64 chars, `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)": a
valid name is one to 64 characters, each a lower-case letter, digit or hyphen, so it can never
contain a `/`, a `.` or an upper-case letter and is always a single directory name. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#57-skills--awskills")
  (ts := "packages/contracts/src/skills.ts#SKILL_NAME_PATTERN")]
theorem skill_name_is_a_bounded_directory_name (n : String) (h : Skill.nameShape n = true) :
    1 ≤ n.toList.length ∧ n.toList.length ≤ 64 ∧ '/' ∉ n.toList ∧ '.' ∉ n.toList ∧
      ∀ c ∈ n.toList, ¬('A' ≤ c ∧ c ≤ 'Z') := by
  obtain ⟨hall, h1, h64⟩ := all_of_nameShape h
  refine ⟨h1, h64, fun hm => ?_, fun hm => ?_, fun c hc hu => ?_⟩
  · have := List.all_eq_true.mp hall _ hm
    revert this; decide
  · have := List.all_eq_true.mp hall _ hm
    revert this; decide
  · have := List.all_eq_true.mp hall c hc
    unfold Skill.isNameChar at this
    simp only [Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq, beq_iff_eq] at this
    obtain ⟨hA, hZ⟩ := hu
    rcases this with (⟨ha, _⟩ | ⟨_, h9⟩) | rfl
    · exact absurd (Char.le_trans ha hZ) (by decide)
    · exact absurd (Char.le_trans hA h9) (by decide)
    · exact absurd hA (by decide)

/-- The names the docs use are skill names (`release-notes`, `release-notes-v2`),
and the pattern's edges hold: 64 characters pass, 65 fail, and a leading or trailing hyphen, an
upper-case letter, an underscore or a dot fails. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#what-you-can-and-cannot-do-today")
  (ts := "packages/contracts/src/skills.ts#SKILL_NAME_PATTERN")]
theorem documented_skill_names :
    Skill.nameShape "release-notes" = true ∧ Skill.nameShape "release-notes-v2" = true ∧
      Skill.nameShape "a" = true ∧
      Skill.nameShape (String.ofList (List.replicate 64 'a')) = true ∧
      Skill.nameShape (String.ofList (List.replicate 65 'a')) = false ∧
      Skill.nameShape "-notes" = false ∧ Skill.nameShape "notes-" = false ∧
      Skill.nameShape "Notes" = false ∧ Skill.nameShape "release_notes" = false ∧
      Skill.nameShape "notes.md" = false ∧ Skill.nameShape "" = false := by
  decide

/-! ## Files (04 §5.6, spec §16) -/

/-- "Paths are workspace-relative, forward-slash, no `..`": spec §16's own example path is
admitted, and a leading slash, a trailing slash, an empty segment, a `.` or `..` segment and a
control character are refused. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")
  (doc := "docs/spec.md#16-file-management")
  (ts := "packages/core/src/db/schema/files.ts#files")]
theorem documented_file_paths :
    File.pathAdmitted "contracts/agreement.pdf" = true ∧ File.pathAdmitted "instructions.md" = true ∧
      File.pathAdmitted "/contracts" = false ∧ File.pathAdmitted "contracts/" = false ∧
      File.pathAdmitted "a//b" = false ∧ File.pathAdmitted "../secrets" = false ∧
      File.pathAdmitted "a/../b" = false ∧ File.pathAdmitted "a/." = false ∧
      File.pathAdmitted "a\nb" = false ∧ File.pathAdmitted "" = false ∧
      File.pathAdmitted ".hidden/..x" = true := by
  decide

/-- An admitted path has no empty, `.` or `..` segment. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")
  (ts := "packages/core/src/db/schema/files.ts#files")]
theorem admitted_path_has_no_empty_or_dot_segment (p : String) (h : File.pathAdmitted p = true) :
    [] ∉ File.segments p ∧ ['.'] ∉ File.segments p ∧ ['.', '.'] ∉ File.segments p := by
  simp only [File.pathAdmitted, File.pathShape, File.noDotSegments, Bool.and_eq_true,
    List.all_eq_true] at h
  refine ⟨fun hm => ?_, fun hm => ?_, fun hm => ?_⟩
  · have := (h.1 _ hm).1
    simp at this
  · have := h.2 _ hm
    simp at this
  · have := h.2 _ hm
    simp at this

/-- "A folder occupies no bytes and has no MIME type", and "a file has bytes somewhere and a
folder does not": in a valid row a folder has no storage key, size 0 and no content type, and a
file has a storage key and a non-negative size. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/files.ts#files")]
theorem file_and_folder_rows (f : File.File) (h : f.valid = true) :
    (f.kind = .folder → f.storageKey = none ∧ f.sizeBytes = 0 ∧ f.contentType = none) ∧
      (f.kind = .file → f.storageKey.isSome = true ∧ 0 ≤ f.sizeBytes) := by
  simp only [File.File.valid, File.File.storageKeyIffFile, File.File.sizeNonNegative,
    File.File.folderHasNoContent, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq,
    Bool.or_eq_true, bne_iff_ne, ne_eq, Option.isNone_iff_eq_none] at h
  obtain ⟨⟨⟨⟨⟨-, -⟩, hk⟩, -⟩, hs⟩, hf⟩ := h
  constructor
  · intro hfo
    rw [hfo] at hk hf
    simp only [not_true_eq_false, false_or] at hf
    refine ⟨?_, hf.1, hf.2⟩
    cases hsk : f.storageKey <;> simp_all
  · intro hfi
    rw [hfi] at hk
    exact ⟨by simpa using hk.symm, hs⟩

/-! ## Assignments and grants -/

/-- The `writeFiles` ceiling "narrows, never widens": it never makes an access broader, leaves it
unchanged with `writeFiles`, and makes every access `read` without it. -/
@[aw_spec (tier := T1)
  (doc := "docs/adr/W9-UI-133-permission-cap-narrows-at-read-and-write.md#decision")
  (ts := "packages/core/src/db/repositories/agent-resources.ts#createDatabaseAgentResourceRepositoryProvider")]
theorem write_files_is_a_ceiling (w : Bool) (a : Grant.FileAccess) :
    (Grant.narrow w a).le a = true ∧ Grant.narrow true a = a ∧ Grant.narrow false a = .read := by
  cases w <;> cases a <;> decide

/-- "It is not a general ACL — there is no `access` column, because 'permitted' is binary": a
grant row has no `access` column, while a file assignment does. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (ts := "packages/core/src/db/schema/agent-grants.ts#agentGrants")]
theorem a_grant_is_binary :
    (catalogue .agentGrants).hasColumn "access" = false ∧
      (catalogue .agentFiles).hasColumn "access" = true := by
  decide

/-- "Revocation is this constraint, not a background job": removing a membership removes every
grant it held, through `ON DELETE CASCADE` on the grant's membership reference. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (ts := "packages/core/src/db/schema/agent-grants.ts#agentGrants")]
theorem membership_removal_revokes_its_grants :
    (fk .agentGrants "agent_grants_member_workspace_fk").refTable = .memberships ∧
      (fk .agentGrants "agent_grants_member_workspace_fk").onDelete = .cascade := by
  decide

/-- "The link has no meaning without either end": every reference from an assignment, grant or
project link table to its agent, project or resource cascades on delete. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/agent-skills.ts#agentSkills")
  (ts := "packages/core/src/db/schema/agent-files.ts#agentFiles")
  (ts := "packages/core/src/db/schema/agent-mcp-servers.ts#agentMcpServers")]
theorem links_die_with_either_end :
    (linkTables.all fun t => (catalogue t).foreignKeys.all (·.onDelete == .cascade)) = true := by
  decide

/-- "Deleting a secret a connector authenticates with must be an explicit decision": the
connector's secret reference is `ON DELETE RESTRICT`. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")]
theorem a_connectors_secret_cannot_be_deleted_under_it :
    (fk .mcpServers "mcp_servers_credential_secret_workspace_fk").refTable = .secrets ∧
      (fk .mcpServers "mcp_servers_credential_secret_workspace_fk").onDelete = .restrict := by
  decide

/-- "Every row that can be own or other carries `ownerPrincipalId`; `createdBy` is legacy human
attribution and may be `null`": on the four catalogued resource tables the owner is `NOT NULL`
and the creator is nullable, and the agent and connector bodies carry both. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#2-resource-model")
  (ts := "packages/contracts/src/agents.ts#AgentResourceSchema")
  (ts := "packages/contracts/src/connectors.ts#ConnectorResourceSchema")]
theorem owner_is_required_and_creator_is_legacy :
    (resourceTables.all fun t =>
      (catalogue t).isNotNull "owner_principal_id" &&
        (catalogue t).hasColumn "created_by" && !(catalogue t).isNotNull "created_by") = true ∧
      "ownerPrincipalId" ∈ Agent.wireFields ∧ "createdBy" ∈ Agent.wireFields ∧
      "ownerPrincipalId" ∈ Connector.wireFields ∧ "createdBy" ∈ Connector.wireFields := by
  decide

/-- The ER diagram's optional (`|o`) references: of the cluster's 49 foreign keys, exactly the
pointer-move mover, model-connection, runtime-profile, four creator, materialised-version and
credential-secret keys are nullable; every other reference is mandatory. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (ts := "packages/core/src/db/schema/agents.ts#agents")]
theorem optional_references_of_the_catalog :
    (clusterForeignKeys.filter fun (t, k) => !isMandatory t k).map (·.2.name) =
      ["agent_pointer_moves_moved_by_principal_workspace_fk",
        "agents_model_connection_id_model_connections_id_fk",
        "agents_runtime_profile_id_runtime_profiles_id_fk",
        "agents_model_connection_workspace_fk", "agents_runtime_profile_workspace_fk",
        "agents_created_by_workspace_fk", "agents_materialised_version_fk",
        "files_created_by_workspace_fk",
        "mcp_servers_created_by_workspace_fk", "mcp_servers_credential_secret_workspace_fk",
        "skills_created_by_workspace_fk"] := by
  decide

/-- "It is an ordinary row in `agents`, editable and deletable like any other" (spec §19.5.1 rule
3): there is no built-in flag and no check beyond the non-blank name, so the General agent is
distinguishable only by its name. -/
@[aw_spec (tier := T1) (ts := "packages/core/src/db/schema/agents.ts#agents")
  (doc := "docs/spec.md#1951-rules")
  (doc := "docs/adr/W1-DB-01-schema-conventions.md#13-the-general-agent-has-no-marker-of-any-kind")]
theorem general_agent_is_an_ordinary_row :
    (catalogue .agents).hasColumn "is_builtin" = false ∧
      ((catalogue .agents).checks.map Check.name) = ["agents_name_not_blank"] := by
  decide

/-- "A resource can sit in the catalog, owned and readable, without being assigned to anything":
some consistent state holds a skill that no agent is assigned. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/site/concepts/ownership-and-sharing.mdx#catalog-assignment-grant")
  (ts := "packages/core/src/db/schema/agent-skills.ts#agentSkills")]
theorem a_catalogued_skill_may_be_unassigned :
    ∃ st : State, consistent st = true ∧
      ∃ r ∈ st .skills, ∀ a ∈ st .agentSkills, a.get "skill_id" ≠ r.get "id" := by
  refine ⟨fun t => if t = .agentSkills then [] else Sample.state t, by decide +kernel, ?_⟩
  exact ⟨(Sample.state .skills).head?.getD default, by decide, fun a ha => by simp at ha⟩

/-- "`name` 1–200 code points": the connector name bound is `CONNECTOR_NAME_MAX_LENGTH`, 200, and
the create pattern admits exactly one to 200 code points with no line terminator. -/
@[aw_spec (tier := T1)
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")
  (ts := "packages/contracts/src/connectors.ts#CONNECTOR_NAME_MAX_LENGTH")]
theorem connector_name_is_one_to_200_code_points :
    Connector.maxNameLength = 200 ∧
      Connector.namePattern (String.ofList (List.replicate 200 'n')) = true ∧
      Connector.namePattern (String.ofList (List.replicate 199 'n' ++ ['é'])) = true ∧
      Connector.namePattern (String.ofList (List.replicate 201 'n')) = false ∧
      Connector.namePattern "" = false ∧ Connector.namePattern "a\nb" = false := by
  decide +kernel

/-- The HTTP bounds of an agent: its name and its model are at most 200 characters, like a
connector's name, and its instructions at most 100 000, while a skill name is bounded by 64. -/
@[aw_spec (tier := T1)
  (ts := "packages/contracts/src/agents.ts#AGENT_NAME_MAX_LENGTH")
  (ts := "packages/contracts/src/agents.ts#AGENT_INSTRUCTIONS_MAX_LENGTH")
  (ts := "packages/contracts/src/agents.ts#AGENT_MODEL_MAX_LENGTH")
  (ts := "packages/contracts/src/skills.ts#SKILL_NAME_MAX_LENGTH")]
theorem catalog_name_bounds :
    Agent.bounds.1 = Connector.maxNameLength ∧ Agent.bounds.2.2 = Agent.bounds.1 ∧
      Agent.bounds.2.1 = 100000 ∧ Skill.maxNameLength = 64 ∧
      Skill.maxNameLength < Agent.bounds.1 := by
  decide

/-! ## Witnesses of the hypotheses above -/

/-! ## The connector create body: error order -/

/-- The create parser reports an unknown `transport` before an unknown `authType`: for a body
with both, the error list is the name's errors, then the transport error, then the `authType`
error, then the credential's errors (no transport-dependent errors are added). -/
@[aw_spec (tier := T1) (ts := "apps/web/server/connectors/contract.ts#parseCreateConnectorBody")
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")]
theorem transport_error_precedes_auth_type_error (b : Connector.Body)
    (ht : Connector.transportOf b.transport = none)
    (ha : Connector.authOf (Connector.authFieldOf b.authType) = none) :
    Connector.parseBody (some b) =
      .error (Connector.nameErrors b.name ++
        ["\"transport\" must be one of stdio, http, sse",
          "\"authType\" must be one of none, api-key, bearer, oauth"] ++
        (Connector.credentialOf (Connector.authFieldOf b.authType) b.credential).1) := by
  simp only [Connector.parseBody, ht, ha, Option.isSome_none, Bool.false_eq_true, ite_false,
    Connector.shapeOf, List.append_nil]
  cases hn : Connector.nameErrors b.name <;> simp

/-! ## Who may run an agent (ADR W9-AUTH-117) -/

/-- "`'permitted'` — a caller-established fact ('an `agent_grants` row names this caller and this
row')": the run-permission check finds a grant for user `u` exactly when a grant row of the agent
names `u`. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (ts := "apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership")
  (ts := "packages/core/src/db/repositories/agent-grants.ts#AgentGrantRepository")]
theorem has_grant_iff_a_row_names_the_user (users : List UserId) (u : UserId) :
    Grant.hasGrant users u = true ↔ u ∈ users := by
  simp [Grant.hasGrant]

/-- The run-ownership answer is `permitted` exactly when the runtime is configured, the agent
exists and is owned by another principal, the grants store is wired, and a grant row names the
caller's user. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (ts := "apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership")]
theorem run_is_permitted_iff_a_grant_row_names_the_caller (i : Grant.RunOwnershipInput) :
    Grant.runOwnership i = .permitted ↔
      i.configured = true ∧ i.grantsWired = true ∧
        (∃ o, i.agentOwner = some o ∧ o ≠ i.callerPrincipal) ∧
        ∃ u, i.callerUser = some u ∧ u ∈ i.grantUsers := by
  obtain ⟨conf, owner, wired, caller, user, users⟩ := i
  cases conf <;> cases owner <;> cases wired <;> cases user <;>
    simp [Grant.runOwnership, Grant.hasGrant] <;> split <;> simp_all

/-- The owner of an agent runs it as `own`, whatever the grant rows say. -/
@[aw_spec (tier := T1) (doc := "docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md#decision")
  (ts := "apps/web/server/agents/run-ownership.ts#resolveAgentRunOwnership")]
theorem the_owner_runs_as_own (i : Grant.RunOwnershipInput) (hc : i.configured = true)
    (ho : i.agentOwner = some i.callerPrincipal) : Grant.runOwnership i = .own := by
  simp [Grant.runOwnership, hc, ho]

/-! ## The agent field bounds (spec §17, ADR W1-CP-05) -/

private theorem utf16_replicate_bmp (c : Char) (hc : c.toNat < 0x10000) :
    ∀ n, Agent.utf16Length (String.ofList (List.replicate n c)) = n
  | 0 => by simp [Agent.utf16Length]
  | n + 1 => by
    have ih := utf16_replicate_bmp c hc n
    simp only [Agent.utf16Length, String.toList_ofList] at ih ⊢
    rw [List.replicate_succ, List.foldr_cons, ih]
    simp [Nat.not_le.mpr hc]
    omega

private theorem utf16_replicate_astral (c : Char) (hc : 0x10000 ≤ c.toNat) :
    ∀ n, Agent.utf16Length (String.ofList (List.replicate n c)) = 2 * n
  | 0 => by simp [Agent.utf16Length]
  | n + 1 => by
    have ih := utf16_replicate_astral c hc n
    simp only [Agent.utf16Length, String.toList_ofList] at ih ⊢
    rw [List.replicate_succ, List.foldr_cons, ih]
    simp [hc]
    omega

/-- "`agents.name`: a non-blank string, trimmed, at most `AGENT_NAME_MAX_LENGTH` characters", the
bound "applied to the trimmed value" and measured in UTF-16 code units: a string is accepted, as
its trimmed form, exactly when that form is not empty and has at most 200 code units; padding is
trimmed, a blank name is refused, 200 letters are 200 units and 100 astral characters are 200
units while 101 are 202. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/agents/contract.ts#parseAgentName")
  (ts := "packages/contracts/src/agents.ts#AGENT_NAME_MAX_LENGTH")]
theorem agent_name_is_trimmed_and_bounded (s : String) :
    (Agent.parseName (.str s) = .ok (Agent.jsTrim s) ↔
        (Agent.jsTrim s).toList ≠ [] ∧ Agent.utf16Length (Agent.jsTrim s) ≤ 200) ∧
      Agent.parseName (.str " Support
") = .ok "Support" ∧
      Agent.parseName (.str " 	　") = .error "name must not be blank." ∧
      Agent.utf16Length (String.ofList (List.replicate 200 'a')) = 200 ∧
      Agent.utf16Length (String.ofList (List.replicate 201 'a')) = 201 ∧
      Agent.utf16Length (String.ofList (List.replicate 100 '😀')) = 200 ∧
      Agent.utf16Length (String.ofList (List.replicate 101 '😀')) = 202 := by
  refine ⟨?_, rfl, rfl, utf16_replicate_bmp 'a' (by decide) _,
    utf16_replicate_bmp 'a' (by decide) _, utf16_replicate_astral '😀' (by decide) _,
    utf16_replicate_astral '😀' (by decide) _⟩
  simp only [Agent.parseName, Agent.bounds]
  by_cases he : (Agent.jsTrim s).toList.isEmpty = true
  · have : (Agent.jsTrim s).toList = [] := List.isEmpty_iff.mp he
    simp [this]
  · have hne : (Agent.jsTrim s).toList ≠ [] := fun h => he (List.isEmpty_iff.mpr h)
    by_cases hl : 200 < Agent.utf16Length (Agent.jsTrim s)
    · simp [he, hl, hne]
    · simp [he, hl, hne]
      omega

/-- "`agents.instructions`: any string, empty included … this is **not** trimmed": a string is
accepted, unchanged, exactly when it has at most 100 000 UTF-16 code units, so the empty string
and a block with surrounding whitespace pass as sent, 100 000 letters pass and 100 001 fail. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/agents/contract.ts#parseAgentInstructions")
  (ts := "packages/contracts/src/agents.ts#AGENT_INSTRUCTIONS_MAX_LENGTH")]
theorem agent_instructions_are_untrimmed_and_bounded (s : String) :
    (Agent.parseInstructions (.str s) = .ok s ↔ Agent.utf16Length s ≤ 100000) ∧
      Agent.parseInstructions (.str "") = .ok "" ∧
      Agent.parseInstructions (.str "  indented
") = .ok "  indented
" ∧
      Agent.utf16Length (String.ofList (List.replicate 100000 'a')) = 100000 ∧
      Agent.utf16Length (String.ofList (List.replicate 100001 'a')) = 100001 := by
  refine ⟨?_, rfl, rfl, utf16_replicate_bmp 'a' (by decide) _,
    utf16_replicate_bmp 'a' (by decide) _⟩
  simp only [Agent.parseInstructions, Agent.bounds]
  by_cases h : 100000 < Agent.utf16Length s
  · simp [h]
  · simp [h]
    omega

/-- "`agents.model`: a non-blank provider-side model id, or `null` for the workspace default":
`null` is the default, a padded id is trimmed, and a blank id is refused with a pointer to
`null`. -/
@[aw_spec (tier := T1) (ts := "apps/web/server/agents/contract.ts#parseAgentModel")]
theorem agent_model_null_is_the_default :
    Agent.parseModel .null = .ok none ∧
      Agent.parseModel (.str " claude-sonnet-4-5 ") = .ok (some "claude-sonnet-4-5") ∧
      Agent.parseModel (.str "  ") =
        .error "model must not be blank; use null to mean \"the workspace default model\"." ∧
      Agent.parseModel (.nonString "a number") =
        .error "model must be a string or null; received a number." := by
  refine ⟨rfl, rfl, rfl, rfl⟩

section Witnesses

private def stdioConnector : Connector.Connector :=
  ⟨⟨"c2"⟩, ⟨"w1"⟩, "Filesystem", .stdio, some "npx", some ["-y", "pkg"], none, .none, none, true,
    none, ⟨"p1"⟩⟩

private def bearerConnector : Connector.Connector :=
  ⟨⟨"c1"⟩, ⟨"w1"⟩, "GitHub", .http, none, none, some "https://example.com/mcp", .bearer,
    some ⟨"s1"⟩, true, none, ⟨"p1"⟩⟩

private theorem stdioConnector_valid : stdioConnector.valid = true := by decide

private theorem bearerConnector_valid : bearerConnector.valid = true := by decide

example : bearerConnector.credentialSecret.isSome = true :=
  (connector_credential_iff_auth_type_is_not_none _ bearerConnector_valid).2 (by decide)

example : stdioConnector.credentialSecret.isSome = false := by
  have h := connector_credential_iff_auth_type_is_not_none _ stdioConnector_valid
  cases hs : stdioConnector.credentialSecret.isSome
  · rfl
  · exact absurd rfl (h.1 hs)

example : bearerConnector.url.all Connector.urlShape = true ∧ bearerConnector.url.isSome = true :=
  ⟨(connector_url_only_for_remote_and_absolute _ bearerConnector_valid).2,
    (connector_url_only_for_remote_and_absolute _ bearerConnector_valid).1.2 rfl⟩

example : stdioConnector.transport = .stdio :=
  connector_args_only_for_stdio _ stdioConnector_valid rfl

example : stdioConnector.command.isSome = true ∧ bearerConnector.command.isSome = false :=
  ⟨(connector_has_exactly_one_of_command_and_url _ stdioConnector_valid).2.2 rfl,
    (connector_has_exactly_one_of_command_and_url _ bearerConnector_valid).1⟩

example : bearerConnector.toResource.hasCredential = true ∧
    stdioConnector.toResource.hasCredential = false :=
  ⟨connector_has_credential_iff_it_needs_one _ bearerConnector_valid,
    connector_has_credential_iff_it_needs_one _ stdioConnector_valid⟩

private def folderRow : File.File :=
  ⟨⟨"f1"⟩, ⟨"w1"⟩, "contracts", .folder, none, 0, none, none, ⟨"p1"⟩⟩

private def fileRow' : File.File :=
  ⟨⟨"f2"⟩, ⟨"w1"⟩, "contracts/agreement.pdf", .file, some "files/w1/contracts/agreement.pdf",
    1024, some "application/pdf", none, ⟨"p1"⟩⟩

private theorem folderRow_valid : folderRow.valid = true := by decide

private theorem fileRow'_valid : fileRow'.valid = true := by decide

example : folderRow.storageKey = none ∧ folderRow.sizeBytes = 0 ∧ folderRow.contentType = none :=
  (file_and_folder_rows _ folderRow_valid).1 rfl

example : fileRow'.storageKey.isSome = true ∧ 0 ≤ fileRow'.sizeBytes :=
  (file_and_folder_rows _ fileRow'_valid).2 rfl

/- A body with an unknown transport and an unknown authentication type: both errors, transport
first, and nothing else. -/
private def ftpBody : Connector.Body :=
  { name := .str "Legacy", transport := .str "ftp", authType := .str "kerberos" }

example : Connector.parseBody (some ftpBody) =
    .error ["\"transport\" must be one of stdio, http, sse",
      "\"authType\" must be one of none, api-key, bearer, oauth",
      "\"credential\" is required when \"authType\" is \"kerberos\""] :=
  transport_error_precedes_auth_type_error ftpBody rfl rfl

/- The kind admission on concrete bodies: `"openapi"` with MCP fields is still handed on, and
`"MCP"`, `"ftp"` and `null` are refused alone. -/
private def openapiWithMcpFields : Connector.Body :=
  { stdioBody with kind := .str "openapi" }

example : Connector.admit (some openapiWithMcpFields) = .ok (.tool .openapi) :=
  admit_tool_kind_defers _ .openapi (by decide) rfl
example : Connector.admit (some { stdioBody with kind := .str "MCP" }) =
    .error [Connector.kindError] :=
  admit_refuses_an_unknown_kind _ (by decide) (by intro s h; cases h; decide)
example : Connector.admit (some { stdioBody with kind := .null }) = .error [Connector.kindError] :=
  admit_refuses_an_unknown_kind _ (by decide) (by intro s h; cases h)
example : Connector.admit (some { stdioBody with kind := .str "mcp" }) =
    (Connector.parseBody (some stdioBody)).map .mcp :=
  admit_absent_kind_is_the_mcp_rule _ (.inr rfl)

private def runInput (owner : String) (user : Option String) (users : List String) :
    Grant.RunOwnershipInput :=
  ⟨true, some ⟨owner⟩, true, ⟨"p2"⟩, user.map Id.mk, users.map Id.mk⟩

/- The negative witness: a user with no grant row is not found, and so runs as `other`. -/
example : Grant.hasGrant [⟨"u1"⟩] ⟨"u2"⟩ = false := by decide
example : ¬ (⟨"u2"⟩ : UserId) ∈ [⟨"u1"⟩] := by decide
example : Grant.runOwnership (runInput "p1" (some "u2") ["u2"]) = .permitted :=
  (run_is_permitted_iff_a_grant_row_names_the_caller _).mpr
    ⟨rfl, rfl, ⟨⟨"p1"⟩, rfl, by decide⟩, ⟨"u2"⟩, rfl, by decide⟩
example : Grant.runOwnership (runInput "p1" (some "u2") ["u1"]) ≠ .permitted := fun h => by
  obtain ⟨-, -, -, u, hu, hm⟩ := (run_is_permitted_iff_a_grant_row_names_the_caller _).mp h
  simp [runInput] at hu
  subst hu
  simp [runInput] at hm
example : Grant.runOwnership (runInput "p2" none []) = .own :=
  the_owner_runs_as_own _ rfl rfl

end Witnesses

end AgentWorkspace.Theorems.Normative.ConceptCatalog
