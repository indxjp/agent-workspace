import AgentWorkspace.Er.Current.Catalog
import Vectors.Common

/-!
Vectors for the `concept-catalog` family: the catalog cluster's sixteen tables as the model knows
them (columns, keys, references with their cardinality, the checks and the SQL of every modelled
check), the concept enumerations and wire field lists, the skill-name and file-path grammars, the
grants body schema, and the connector create parser.

Replayed by `tests/formal/concept-catalog.test.ts` (Drizzle objects, the latest snapshot, the
schema and contract constants, the length bounds, `SKILL_NAME_PATTERN`, the snapshot's own regular expressions,
`AgentGrantsSchema`, `AgentResourceAssignmentsSchema` and the resource schemas) and by
`apps/web/formal/concept-catalog.test.ts` (`parseCreateConnectorBody`, the three agent field
parsers and `resolveAgentRunOwnership`). `replace.json` needs PostgreSQL to replay against the
repository; the suites replay its request and answer shapes and its id order.
-/

namespace Vectors.ConceptCatalog

open Lean AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Catalog
open AgentWorkspace.Concepts

private def wf : String := "AgentWorkspace.Theorems.WellFormed.ConceptCatalog."
private def nm : String := "AgentWorkspace.Theorems.Normative.ConceptCatalog."
private def inv : String := "AgentWorkspace.Theorems.Invariants.ConceptCatalog."
private def adv : String := "AgentWorkspace.Theorems.Adversarial.ConceptCatalog."
private def rf : String := "AgentWorkspace.Theorems.Refinement.ConceptCatalog."
private def mt : String := "AgentWorkspace.Theorems.Meta.ConceptCatalog."

def strs (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

/-! ## Tables -/

def columnJson (c : Column) : Json :=
  Json.mkObj [("name", c.name), ("type", c.type.toSql), ("notNull", c.notNull)]

def fkJson (t : TableName) (k : ForeignKey) : Json :=
  Json.mkObj [("name", k.name), ("columns", strs k.columns),
    ("refTable", TableName.toWire k.refTable), ("refColumns", strs k.refColumns),
    ("onDelete", k.onDelete.toSql), ("inline", k.inline),
    ("class", (classify catalogue t k).toWire), ("mandatory", isMandatory t k),
    ("exactKey", targetIsExactKey catalogue k)]

def uniqueJson (u : UniqueKey) : Json :=
  Json.mkObj [("name", u.name), ("columns", strs u.columns),
    ("kind", match u.kind with | .constraint => "constraint" | .index => "index")]

def checkJson (t : TableName) : Check → Json
  | .oneOf n _ vs => Json.mkObj [("name", n), ("values", strs vs), ("sql", Json.null)]
  | .other n =>
    Json.mkObj [("name", n), ("values", Json.null),
      ("sql", match checkSql.lookup n with | some s => Json.str s | none => Json.null),
      ("modelled", modelledChecks.contains (t, n))]

def cardinalityWitness (t : TableName) (k : ForeignKey) : String :=
  if isMandatory t k then inv ++ s!"{k.name}_names_exactly_one_parent"
  else inv ++ s!"{k.name}_names_one_parent_when_set"

def tableVector (t : TableName) : Vector :=
  let s := catalogue t
  let sql := TableName.toWire t
  { id := s!"table/{sql}",
    input := Json.mkObj [("table", sql), ("tsExport", s.tsExport)],
    expected := Json.mkObj [
      ("primaryKey", strs s.primaryKey),
      ("columns", Json.arr (s.columns.map columnJson).toArray),
      ("foreignKeys", Json.arr (s.foreignKeys.map (fkJson t)).toArray),
      ("uniques", Json.arr (s.uniques.map uniqueJson).toArray),
      ("checks", Json.arr (s.checks.map (checkJson t)).toArray)],
    witnesses := [wf ++ "every_cluster_check_is_modelled",
        wf ++ "every_cluster_reference_targets_an_exact_key",
        wf ++ "cluster_constraints_are_satisfiable", nm ++ "optional_references_of_the_catalog"] ++
      s.foreignKeys.map (fun k => inv ++ s!"{k.name}_joins_one_workspace") ++
      s.foreignKeys.map (cardinalityWitness t) ++
      (s.uniques.filter fun u =>
          u.partialNullColumns.isEmpty && u.partialNotNullColumns.isEmpty).map
        (fun u => inv ++ s!"{u.name}_identifies_one_row") ++
      (if s.primaryKey != ["id"] then [inv ++ s!"{sql}_pkey_identifies_one_row"] else []) }

/-- The column list each concept maps, against the table. -/
def conceptColumnVectors : List Vector :=
  let one (id : String) (t : TableName) (cols : List String) (w : String) : Vector :=
    { id := s!"concept-columns/{id}", input := Json.mkObj [("table", TableName.toWire t)],
      expected := Json.mkObj [("columns", strs cols)], witnesses := [wf ++ w] }
  [one "agent" .agents Agent.dbColumns "agent_concept_covers_every_column",
    one "file" .files File.dbColumns "file_concept_covers_every_column",
    one "skill" .skills Skill.dbColumns "skill_concept_covers_every_column",
    one "connector" .mcpServers Connector.dbColumns "connector_concept_covers_every_column"] ++
  Grant.dbColumns.filterMap fun (name, cols) =>
    (TableName.ofSqlName? name).map fun t =>
      one name t cols "link_concepts_cover_every_column"

/-! ## Enumerations and wire fields -/

def enumVectors : List Vector :=
  let one (id : String) (wires : List String) (ws : List String) : Vector :=
    { id := s!"enum/{id}", input := Json.mkObj [("enum", id)],
      expected := Json.mkObj [("values", strs wires)], witnesses := ws }
  [one "file-kind" (WireEnum.wires File.FileKind)
      [wf ++ "file_kind_wires", wf ++ "files_kind_check_is_the_kinds"],
    one "file-access" (WireEnum.wires Grant.FileAccess)
      [wf ++ "file_access_wires", wf ++ "agent_files_access_check_is_the_modes"],
    one "connector-kind" (WireEnum.wires Connector.Kind)
      [wf ++ "connector_kind_wires", wf ++ "mcp_servers_kind_check_is_the_kinds"],
    one "transport" (WireEnum.wires Connector.Transport)
      [wf ++ "transport_wires", wf ++ "mcp_servers_transport_check_is_the_transports"],
    one "auth-type" (WireEnum.wires Connector.AuthType)
      [wf ++ "auth_type_wires", wf ++ "mcp_servers_auth_type_check_is_the_auth_types"],
    one "remote-transport"
      (((WireEnum.all : List Connector.Transport).filter Connector.Transport.isRemote).map
        WireEnum.toWire) [wf ++ "remote_transports_are_http_and_sse"],
    one "credentialed-auth-type"
      (((WireEnum.all : List Connector.AuthType).filter Connector.AuthType.needsCredential).map
        WireEnum.toWire) [wf ++ "credentialed_auth_types_are_all_but_none"],
    one "agent-permission-key" Agent.permissionKeys
      [wf ++ "agent_concept_covers_every_column"],
    one "agent-mutable-field" Agent.mutableFields
      [wf ++ "agent_concept_covers_every_column"]]

def wireVectors : List Vector :=
  let one (id module schema : String) (fields optional : List String) (ws : List String) :
      Vector :=
    { id := s!"wire/{id}", input := Json.mkObj [("module", module), ("schema", schema)],
      expected := Json.mkObj [("fields", strs fields), ("optional", strs optional)],
      witnesses := ws }
  [one "agent" "agents" "AgentResourceSchema" Agent.wireFields
      ["builtin", "createdByAgent", "archivedAt"]
      [nm ++ "owner_is_required_and_creator_is_legacy"],
    one "connector" "connectors" "ConnectorResourceSchema" Connector.wireFields
      Connector.wireOptionalFields
      [nm ++ "connector_wire_carries_no_credential_field",
        nm ++ "owner_is_required_and_creator_is_legacy"],
    one "file" "files" "FileResourceSchema" File.wireFields []
      [mt ++ "file_and_skill_bodies_carry_no_owner"],
    one "skill" "skills" "SkillDetailSchema" Skill.wireFields Skill.wireOptionalFields
      [mt ++ "file_and_skill_bodies_carry_no_owner"]]

/-! ## Contract constants -/

def constantVectors : List Vector :=
  let one (module name : String) (value : Nat) : Vector :=
    { id := s!"constant/{name}", input := Json.mkObj [("module", module), ("constant", name)],
      expected := Json.mkObj [("value", value)],
      witnesses := [nm ++ "catalog_name_bounds", nm ++ "connector_name_is_one_to_200_code_points"] }
  [one "agents" "AGENT_NAME_MAX_LENGTH" Agent.bounds.1,
    one "agents" "AGENT_INSTRUCTIONS_MAX_LENGTH" Agent.bounds.2.1,
    one "agents" "AGENT_MODEL_MAX_LENGTH" Agent.bounds.2.2,
    one "connectors" "CONNECTOR_NAME_MAX_LENGTH" Connector.maxNameLength,
    one "skills" "SKILL_NAME_MAX_LENGTH" Skill.maxNameLength]

/-! ## A deterministic sample generator -/

/-- A linear congruential generator (Numerical Recipes constants), for reproducible samples. -/
def lcg (s : Nat) : Nat := (1664525 * s + 1013904223) % 4294967296

/-- `n` pseudo-random strings over `alphabet`, of length below `maxLen`, from `seed`. -/
def sampleStrings (alphabet : List Char) (maxLen n seed : Nat) : List String :=
  (go n seed).1
where
  go : Nat → Nat → List String × Nat
    | 0, s => ([], s)
    | k + 1, s =>
      let s1 := lcg s
      let len := s1 % maxLen
      let (cs, s2) := chars len s1
      let (rest, s3) := go k s2
      (String.ofList cs :: rest, s3)
  chars : Nat → Nat → List Char × Nat
    | 0, s => ([], s)
    | k + 1, s =>
      let s1 := lcg s
      let c := alphabet.getD (s1 / 65536 % alphabet.length) 'a'
      let (cs, s2) := chars k s1
      (c :: cs, s2)

/-! ## Skill names -/

def skillNames : List String :=
  ["release-notes", "release-notes-v2", "a", "0", "a1", "1password", "a--b",
    "-a", "a-", "-", "", "A", "Notes", "release_notes", "notes.md", "a/b", "..", ".", "a b",
    " a", "a ", "é", "a\n", String.ofList (List.replicate 63 'a'),
    String.ofList (List.replicate 64 'a'), String.ofList (List.replicate 65 'a'),
    "a" ++ String.ofList (List.replicate 62 '-') ++ "b",
    "a" ++ String.ofList (List.replicate 63 '-') ++ "b"] ++
  sampleStrings "ab09-_A. ".toList 12 120 20260923

def skillNameVectors : List Vector :=
  skillNames.eraseDups.map fun n =>
    { id := s!"skill-name/{(Json.str n).compress}", input := Json.mkObj [("name", n)],
      expected := Json.mkObj [("valid", Skill.nameShape n)],
      witnesses := [nm ++ "skill_name_is_a_bounded_directory_name",
        nm ++ "documented_skill_names", rf ++ "skill_invariant_is_the_row_checks"] }

/-! ## File paths -/

def filePaths : List String :=
  ["contracts/agreement.pdf", "contracts", "instructions.md", "report-template.docx",
    "/contracts", "contracts/", "a//b", "../secrets", "a/../b", "a/..", "..", ".", "a/.",
    "./a", ".hidden", ".hidden/..x", "...", "a/.../b", "a\nb", "a\u0001b", "a\u007fb",
    "a\u0085b", "a\u00a0b", "a\tb", "a b", "", "/", "é/ü.txt", "docs2/x.txt", "a%/_b",
    "a\\b", "C:/x"] ++
  sampleStrings "ab./\u0001 ".toList 10 150 42

def filePathVectors : List Vector :=
  filePaths.eraseDups.map fun p =>
    { id := s!"file-path/{(Json.str p).compress}", input := Json.mkObj [("path", p)],
      expected := Json.mkObj [("shape", File.pathShape p), ("noDotSegments", File.noDotSegments p)],
      witnesses := [nm ++ "documented_file_paths", nm ++ "admitted_path_has_no_empty_or_dot_segment",
        adv ++ "dot_dot_segment_is_refused_anywhere",
        rf ++ "file_path_and_key_invariants_are_the_row_checks",
        rf ++ "file_invariant_is_the_row_checks"] }

/-! ## The grants body -/

private def u1 : String := "123e4567-e89b-12d3-a456-426614174000"
private def u1Upper : String := "123E4567-E89B-12D3-A456-426614174000"
private def u2 : String := "00000000-0000-4000-8000-000000000002"

def grantBodies : List (List String) :=
  [[], [u1], [u1Upper], [u1, u2], [u2, u1], [u1, u1], [u1Upper, u1], [u1, u2, u1],
    ["not-a-uuid"], [u1, ""], ["123e4567e89b12d3a456426614174000"],
    ["123e4567-e89b-12d3-a456-42661417400g"], ["{" ++ u1 ++ "}"], [u1 ++ " "]]

def grantBodyVectors : List Vector :=
  grantBodies.map fun ids =>
    { id := s!"grants-body/{(strs ids).compress}", input := Json.mkObj [("principalIds", strs ids)],
      expected := match Grant.grantsBody ids with
        | some l => Json.mkObj [("valid", true), ("principalIds", strs l)]
        | none => Json.mkObj [("valid", false)],
      witnesses := [adv ++ "grants_body_admits_only_distinct_uuids",
        adv ++ "case_variant_duplicate_grant_ids_are_refused"] }

/-! ## The connector create parser -/

def fieldJson : Connector.Field → Option Json
  | .absent => none
  | .null => some Json.null
  | .str s => some (Json.str s)
  | .strs l => some (strs l)
  | .other => some (Json.num 42)

def bodyJson (b : Connector.Body) : Json :=
  Json.mkObj ([("name", b.name), ("transport", b.transport), ("authType", b.authType),
    ("command", b.command), ("url", b.url), ("args", b.args), ("credential", b.credential),
    ("kind", b.kind)].filterMap
      fun (k, f) => (fieldJson f).map (k, ·))

def optJson : Option String → Json
  | some s => Json.str s
  | none => Json.null

def parsedJson (p : Connector.Parsed) : Json :=
  Json.mkObj [("name", p.name), ("transport", WireEnum.toWire p.transport),
    ("command", optJson p.command),
    ("args", match p.args with | some l => strs l | none => Json.null),
    ("url", optJson p.url), ("authType", WireEnum.toWire p.authType),
    ("credential", optJson p.credential)]

/-- An admission outcome: the kind admitted at the top level, and for `mcp` the parsed value. -/
def outcomeJson : Except (List String) Connector.Admission → Json
  | .ok (.mcp p) => Json.mkObj [("ok", true), ("kind", "mcp"), ("value", parsedJson p)]
  | .ok (.tool k) => Json.mkObj [("ok", true), ("kind", WireEnum.toWire k)]
  | .error es => Json.mkObj [("ok", false), ("errors", strs es)]

def names : List Connector.Field :=
  [.str "GitHub", .str "", .str "   ", .str "a\nb", .str (String.ofList (List.replicate 200 'n')),
    .str (String.ofList (List.replicate 201 'n')), .absent, .other]
def transports : List Connector.Field :=
  [.str "stdio", .str "http", .str "sse", .str "HTTP", .absent, .null, .other]
def authTypes : List Connector.Field :=
  [.absent, .null, .str "none", .str "bearer", .str "api-key", .str "oauth", .str "basic",
    .str "a\"b", .other]
def commands : List Connector.Field := [.absent, .null, .str "npx", .str "  ", .str "\t\u00a0"]
def urls : List Connector.Field :=
  [.absent, .null, .str "https://example.com/mcp", .str "http://x", .str "ftp://x", .str "HTTPS://x"]
def argss : List Connector.Field := [.absent, .null, .strs [], .strs ["-y", "pkg"], .str "-y", .other]
def credentials : List Connector.Field := [.absent, .null, .str "token", .str " ", .other]

/-- A seeded sample of bodies over the field pools, plus the named edge cases. -/
def bodies : List (Option Connector.Body) :=
  let pick {α : Type} [Inhabited α] (xs : List α) (s : Nat) : α := xs.getD (s / 65536 % xs.length) default
  let rec go : Nat → Nat → List Connector.Body
    | 0, _ => []
    | k + 1, s =>
      let s1 := lcg s; let s2 := lcg s1; let s3 := lcg s2; let s4 := lcg s3
      let s5 := lcg s4; let s6 := lcg s5; let s7 := lcg s6
      { name := pick names s1, transport := pick transports s2, authType := pick authTypes s3,
        command := pick commands s4, url := pick urls s5, args := pick argss s6,
        credential := pick credentials s7 } :: go k s7
  let edges : List Connector.Body :=
    [{ name := .str "Filesystem", transport := .str "stdio", command := .str "npx",
       args := .strs ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"] },
     { name := .str "GitHub", transport := .str "http", url := .str "https://example.com/mcp",
       authType := .str "bearer", credential := .str "ghp_x" },
     { name := .str "Events", transport := .str "sse", url := .str "https://example.com/mcp/sse" },
     { name := .str "   ", transport := .str "stdio", command := .str "npx" },
     { name := .str "G", transport := .str "http", url := .str "https://x", authType := .null },
     { name := .str "G", transport := .str "http", url := .str "https://x",
       authType := .str "bearer" },
     { name := .str "G", transport := .str "http", url := .str "https://x",
       credential := .str "secret" },
     { name := .str "F", transport := .str "stdio", command := .str "npx", url := .str "https://x" },
     { name := .str "G", transport := .str "sse", url := .str "https://x", command := .str "npx",
       args := .strs [] },
     { name := .str "G", transport := .str "http", url := .str "https://x",
       authType := .str "basic" },
     {},
     { kind := .str "openapi" },
     { kind := .str "postgres" },
     { name := .str "Files", transport := .str "stdio", command := .str "npx",
       kind := .str "openapi" },
     { name := .str "G", transport := .str "http", url := .str "https://x",
       authType := .str "bearer", kind := .str "postgres" },
     { name := .str "Files", transport := .str "stdio", command := .str "npx", kind := .str "mcp" },
     { name := .str "   ", transport := .str "stdio", kind := .str "mcp" },
     { name := .str "Files", transport := .str "stdio", command := .str "npx", kind := .str "MCP" },
     { name := .str "Files", transport := .str "stdio", command := .str "npx", kind := .str "ftp" },
     { name := .str "Files", transport := .str "stdio", command := .str "npx", kind := .null },
     { name := .str "Files", transport := .str "stdio", command := .str "npx", kind := .other },
     { kind := .strs ["openapi"] }]
  (edges ++ go 300 7).map some ++ [none]

def bodyInput : Option Connector.Body → Json
  | some b => Json.mkObj [("body", bodyJson b)]
  | none => Json.mkObj [("body", Json.null)]

def connectorBodyVectors : List Vector :=
  bodies.eraseDups.map fun b =>
    { id := s!"connector-body/{(bodyInput b).compress}", input := bodyInput b,
      expected := outcomeJson (Connector.admit b),
      witnesses := [inv ++ "created_connector_meets_the_shape_checks",
        nm ++ "create_refuses_a_missing_or_a_superfluous_credential",
        nm ++ "create_refuses_fields_of_the_other_transport",
        nm ++ "absent_or_null_auth_type_is_none",
        mt ++ "blank_connector_name_passes_the_parser_but_not_the_check",
        nm ++ "admit_absent_kind_is_the_mcp_rule", nm ++ "admit_refuses_an_unknown_kind",
        nm ++ "admit_tool_kind_defers"] }

/-! ## Replacing an agent's assignments -/

private def uid (n : Nat) : String :=
  let d := toString n
  "00000000-0000-4000-8000-" ++ String.ofList (List.replicate (12 - d.length) '0') ++ d

/-- File ids: 1–3 catalogued, 9 not; skills 11–12 catalogued, 19 not; connectors 21–22
catalogued, 29 not. -/
def replaceCatalog : Grant.CatalogIds :=
  ⟨[uid 1, uid 2, uid 3], [uid 11, uid 12], [uid 21, uid 22]⟩

def filePool : List Grant.FileEntry := [⟨uid 3, .readWrite⟩, ⟨uid 1, .read⟩, ⟨uid 2, .readWrite⟩]
def skillPool : List String := [uid 12, uid 11, uid 12]
def connectorPool : List String := [uid 22, uid 21, uid 21]

/-- A sub-list of `pool` chosen by the bits of `s`, in the pool's order rotated by `s`. -/
def choose {α : Type} (pool : List α) (s : Nat) : List α :=
  let rot := pool.rotateLeft (s % (pool.length + 1))
  (rot.zipIdx.filter fun (_, i) => (s / 7) / 2 ^ i % 2 == 1).map (·.1)

def replaceRequests : List (Bool × Bool × Grant.Assignments) :=
  let rec go : Nat → Nat → List (Bool × Bool × Grant.Assignments)
    | 0, _ => []
    | k + 1, s =>
      let s1 := lcg s; let s2 := lcg s1; let s3 := lcg s2; let s4 := lcg s3
      let r := s4 / 65536
      let files := choose filePool (s1 / 65536) ++
        (if r % 6 == 0 then [⟨uid 9, .read⟩] else []) ++
        (if r % 13 == 0 then [⟨uid 1, .readWrite⟩] else [])
      let skills := choose skillPool (s2 / 65536) ++ (if r / 6 % 6 == 0 then [uid 19] else [])
      let connectors := choose connectorPool (s3 / 65536) ++
        (if r / 36 % 6 == 0 then [uid 29] else [])
      (r % 11 != 0, r / 3 % 2 == 0, ⟨files, skills, connectors⟩) :: go k s4
  let edges : List (Bool × Bool × Grant.Assignments) :=
    [(true, true, ⟨[], [], []⟩),
     (false, true, ⟨[⟨uid 1, .read⟩], [], []⟩),
     (true, false, ⟨[⟨uid 3, .readWrite⟩, ⟨uid 1, .readWrite⟩], [uid 12, uid 11, uid 12],
        [uid 22, uid 21]⟩),
     (true, true, ⟨[⟨uid 3, .readWrite⟩, ⟨uid 1, .readWrite⟩], [uid 12, uid 11], [uid 22]⟩),
     (true, true, ⟨[⟨uid 1, .read⟩, ⟨uid 9, .read⟩], [uid 19], [uid 29]⟩),
     (true, true, ⟨[⟨uid 1, .read⟩], [uid 19], [uid 29]⟩),
     (true, true, ⟨[⟨uid 1, .read⟩], [uid 11, uid 11], [uid 29]⟩),
     (true, true, ⟨[⟨uid 1, .read⟩, ⟨uid 1, .readWrite⟩], [uid 19], [uid 29]⟩)]
  edges ++ go 60 99

def fileEntryJson (f : Grant.FileEntry) : Json :=
  Json.mkObj [("fileId", f.file), ("access", WireEnum.toWire f.access)]

def assignmentsJson (a : Grant.Assignments) : Json :=
  Json.mkObj [("files", Json.arr (a.files.map fileEntryJson).toArray),
    ("skillIds", strs a.skills), ("connectorIds", strs a.connectors)]

def replaceOutcomeJson : Grant.ReplaceOutcome → Json
  | .updated a => Json.mkObj [("kind", "updated"), ("assignments", assignmentsJson a)]
  | .notFound => Json.mkObj [("kind", "not-found")]
  | .unknownFile i => Json.mkObj [("kind", "unknown-file"), ("id", i)]
  | .unknownSkill i => Json.mkObj [("kind", "unknown-skill"), ("id", i)]
  | .unknownConnector i => Json.mkObj [("kind", "unknown-connector"), ("id", i)]

def replaceVectors : List Vector :=
  replaceRequests.eraseDups.map fun (exists_, w, req) =>
    let agent? : Option Agent.Permissions := if exists_ then some ⟨true, w, false, false⟩ else none
    let input := Json.mkObj [("agentExists", exists_), ("writeFiles", w),
      ("catalog", Json.mkObj [("files", strs replaceCatalog.files),
        ("skills", strs replaceCatalog.skills), ("connectors", strs replaceCatalog.connectors)]),
      ("requested", assignmentsJson req)]
    { id := s!"replace/{input.compress}", input,
      expected := replaceOutcomeJson (Grant.replace agent? replaceCatalog req),
      witnesses := [inv ++ "replace_assigns_only_catalogued_resources",
        inv ++ "replace_never_widens_past_write_files", inv ++ "replace_writes_each_resource_once",
        inv ++ "replace_keeps_every_requested_id", inv ++ "replace_answers_in_id_order",
        inv ++ "replace_reports_the_first_uncatalogued_file",
        inv ++ "replace_reports_the_first_uncatalogued_skill",
        inv ++ "replace_reports_the_first_uncatalogued_connector",
        inv ++ "replace_checks_files_then_skills_then_connectors",
        mt ++ "repeated_ids_are_treated_differently_by_kind"] }

/-! ## The assignment body schema -/

def rawAssignmentsJson (b : Grant.RawAssignments) : Json :=
  Json.mkObj ([("files", Json.arr (b.files.map fun e =>
      Json.mkObj [("fileId", e.fileId), ("access", e.access)]).toArray),
    ("skillIds", strs b.skillIds), ("connectorIds", strs b.connectorIds)] ++
    (if b.storageGrants.isEmpty then [] else
      [("storageGrants", Json.arr (b.storageGrants.map fun g =>
        Json.mkObj [("connectionId", g.connectionId), ("prefix", g.pathPrefix),
          ("access", g.access)]).toArray)]) ++
    b.extra.map fun k => (k, Json.bool true))

def storageGrantJson (g : Grant.StorageGrant) : Json :=
  Json.mkObj [("connectionId", g.connection), ("prefix", g.pathPrefix),
    ("access", WireEnum.toWire g.access)]

/-- The parsed body: the assignment and its storage grants (`[]` when the key is left out). -/
def assignmentsBodyJson (a : Grant.Assignments) (gs : List Grant.StorageGrant) : Json :=
  Json.mkObj [("files", Json.arr (a.files.map fileEntryJson).toArray),
    ("skillIds", strs a.skills), ("connectorIds", strs a.connectors),
    ("storageGrants", Json.arr (gs.map storageGrantJson).toArray)]

def rawBodies : List Grant.RawAssignments :=
  [⟨[], [], [], [], []⟩,
   ⟨[⟨"f1", "read"⟩, ⟨"f2", "read-write"⟩], ["k1"], ["c1"], [], []⟩,
   ⟨[⟨"f1", "read"⟩, ⟨"f1", "read-write"⟩], ["k1", "k1"], ["c1", "c1"], [], []⟩,
   ⟨[⟨"", "read"⟩], [], [], [], []⟩,
   ⟨[⟨"f1", "write"⟩], [], [], [], []⟩,
   ⟨[⟨"f1", "READ"⟩], [], [], [], []⟩,
   ⟨[⟨"f1", "readWrite"⟩], [], [], [], []⟩,
   ⟨[⟨"f1", ""⟩], [], [], [], []⟩,
   ⟨[], [""], [], [], []⟩,
   ⟨[], [], [""], [], []⟩,
   ⟨[], ["k1"], ["c1"], ["policy"], []⟩,
   ⟨[], [], [], ["grants"], []⟩,
   ⟨[⟨" ", "read"⟩], [" "], [" "], [], []⟩,
   ⟨[], [], [], [], [⟨"0b9f1c7e-2d4a-4c1e-9a3b-5e6f7a8b9c0d", "reports/", "read"⟩,
     ⟨"0B9F1C7E-2D4A-4C1E-9A3B-5E6F7A8B9C0D", "a", "read-write"⟩]⟩,
   ⟨[], [], [], [], [⟨"sc1", "reports/", "read"⟩]⟩,
   ⟨[], [], [], [], [⟨"0b9f1c7e-2d4a-4c1e-9a3b-5e6f7a8b9c0d", "", "read"⟩]⟩,
   ⟨[], [], [], [], [⟨"0b9f1c7e-2d4a-4c1e-9a3b-5e6f7a8b9c0d", "reports/", "write"⟩]⟩,
   ⟨[], [], [], [], [⟨"0b9f1c7e-2d4a-4c1e-9a3b-5e6f7a8b9c0d", "reports/", "READ"⟩]⟩]

def assignmentBodyVectors : List Vector :=
  rawBodies.map fun b =>
    { id := s!"assignments-body/{(rawAssignmentsJson b).compress}",
      input := Json.mkObj [("body", rawAssignmentsJson b)],
      expected := match Grant.assignmentsBody b, Grant.storageGrantsBody b with
        | some a, some gs => Json.mkObj [("valid", true), ("value", assignmentsBodyJson a gs)]
        | _, _ => Json.mkObj [("valid", false)],
      witnesses := [inv ++ "accepted_assignment_body_keeps_every_id"] }

/-! ## The agent field parsers -/

/-- The runs of equal characters of a string, as `[text, count]` pairs. -/
def runs (s : String) : List (String × Nat) :=
  s.toList.foldr (fun c acc => match acc with
    | (t, n) :: rest => if t == String.singleton c then (t, n + 1) :: rest
      else (String.singleton c, 1) :: acc
    | [] => [(String.singleton c, 1)]) []

/-- A string as JSON: itself when short, else `{ "runs": [[text, count], …] }` (the suite
expands it with `text.repeat(count)`), so a 100 000-character bound stays a small file. -/
def textJson (s : String) : Json :=
  if s.length ≤ 64 then Json.str s
  else Json.mkObj [("runs", Json.arr ((runs s).map fun (t, n) =>
    Json.arr #[Json.str t, Json.num n]).toArray)]

def rawFieldJson : Agent.RawField → Json
  | .str s => textJson s
  | .null => Json.null
  | .nonString "a boolean" => Json.bool true
  | .nonString "an array" => Json.arr #[]
  | .nonString "an object" => Json.mkObj []
  | .nonString _ => Json.num 42

def nonStrings : List Agent.RawField :=
  [.null, .nonString "a number", .nonString "a boolean", .nonString "an array",
    .nonString "an object"]

def rep (n : Nat) (c : Char) : String := String.ofList (List.replicate n c)

def nameInputs : List Agent.RawField :=
  ([ "Support", "  Support  ", "Support\n", "", "   ", "\t\n\r", " 　﻿",
     " x ", "a", rep 200 'a', rep 201 'a', " " ++ rep 200 'a' ++ " ", rep 100 '😀',
     rep 101 '😀', rep 199 'a' ++ "😀", "é", "a​b", "​" ].map .str) ++ nonStrings

def instructionInputs : List Agent.RawField :=
  ([ "", "  indented\n", "Write notes.", rep 100000 'a', rep 100001 'a', rep 50000 '😀',
     rep 49999 '😀' ++ "ab", rep 50001 '😀' ].map .str) ++ nonStrings

def modelInputs : List Agent.RawField :=
  ([ "claude-sonnet-4-5", " claude-sonnet-4-5 ", "", "  ", "　", rep 200 'm', rep 201 'm',
     " " ++ rep 200 'm' ++ "\t", rep 100 '😀', rep 101 '😀' ].map .str) ++ nonStrings

def exceptJson {α : Type} (f : α → Json) : Except String α → Json
  | .ok a => Json.mkObj [("ok", true), ("value", f a)]
  | .error e => Json.mkObj [("ok", false), ("errors", strs [e])]

def fieldVector (field : String) (raw : Agent.RawField) (expected : Json)
    (witnesses : List String) : Vector :=
  let v := rawFieldJson raw
  { id := s!"agent-field/{field}/{v.compress}", input := Json.mkObj [("field", field), ("value", v)],
    expected, witnesses }

def agentFieldVectors : List Vector :=
  nameInputs.map (fun r => fieldVector "name" r (exceptJson textJson (Agent.parseName r))
      [nm ++ "agent_name_is_trimmed_and_bounded",
        inv ++ "accepted_agent_name_passes_the_table_check"]) ++
  instructionInputs.map (fun r =>
    fieldVector "instructions" r (exceptJson textJson (Agent.parseInstructions r))
      [nm ++ "agent_instructions_are_untrimmed_and_bounded",
        inv ++ "accepted_instructions_are_the_string_sent"]) ++
  modelInputs.map (fun r => fieldVector "model" r
      (exceptJson (fun m => match m with | some t => textJson t | none => Json.null)
        (Agent.parseModel r))
      [nm ++ "agent_model_null_is_the_default",
        inv ++ "accepted_agent_model_is_default_or_visible"])

/-! ## Run ownership -/

def ownerCases : List (String × Option String) :=
  [("missing", none), ("caller", some (uid 101)), ("other", some (uid 102))]
def userCases : List (String × Option String) :=
  [("none", none), ("granted", some (uid 201)), ("ungranted", some (uid 202))]

def runOwnershipVectors : List Vector := Id.run do
  let mut out : List Vector := []
  for conf in [true, false] do
    for (oName, owner) in ownerCases do
      for wired in [true, false] do
        for (uName, user) in userCases do
          let i : Grant.RunOwnershipInput :=
            ⟨conf, owner.map Id.mk, wired, ⟨uid 101⟩, user.map Id.mk, [⟨uid 200⟩, ⟨uid 201⟩]⟩
          out := out ++ [{
            id := s!"run-ownership/configured={conf}/agent={oName}/grants={wired}/user={uName}",
            input := Json.mkObj [("configured", conf),
              ("agentOwnerPrincipalId", optJson owner), ("grantsWired", wired),
              ("callerPrincipalId", uid 101), ("callerUserId", optJson user),
              ("grantUserIds", strs [uid 200, uid 201])],
            expected := Json.mkObj [("ownership", (Grant.runOwnership i).toWire)],
            witnesses := [nm ++ "has_grant_iff_a_row_names_the_user",
              nm ++ "run_is_permitted_iff_a_grant_row_names_the_caller",
              nm ++ "the_owner_runs_as_own", adv ++ "no_grant_row_no_run_permission"] }]
  return out

/-- The files of the family. -/
def files : List (String × Json) :=
  [("tables.json",
      file "concept-catalog" "The catalog cluster's twelve tables: columns, keys, references with tenancy class and cardinality, checks and the SQL of every modelled check"
        (tables.map tableVector ++ conceptColumnVectors)),
   ("enums.json",
      file "concept-catalog" "The catalog enumerations and the wire field lists of the resource bodies"
        (enumVectors ++ wireVectors)),
   ("constants.json",
      file "concept-catalog" "The HTTP length bounds of agent, connector and skill names, instructions and models"
        constantVectors),
   ("skill-names.json",
      file "concept-catalog" "SKILL_NAME_PATTERN / skills_name_shape over edge cases and a seeded sample"
        skillNameVectors),
   ("file-paths.json",
      file "concept-catalog" "files_path_shape and files_path_no_dot_segments over edge cases and a seeded sample"
        filePathVectors),
   ("grants-body.json",
      file "concept-catalog" "AgentGrantsSchema: canonical UUIDs, lower-cased, no case-variant duplicates"
        grantBodyVectors),
   ("connector-bodies.json",
      file "concept-catalog" "connectorKindOfBody then parseCreateConnectorBody (the kind admission) over edge cases and a seeded sample of bodies"
        connectorBodyVectors),
   ("replace.json",
      file "concept-catalog" "AgentResourceRepository.replace: outcome for a fixed catalog over edge cases and a seeded sample of requests (answers in id order)"
        replaceVectors),
   ("assignments-body.json",
      file "concept-catalog" "AgentResourceAssignmentsSchema: non-empty ids, the closed access set, no unknown key, duplicates admitted"
        assignmentBodyVectors),
   ("agent-fields.json",
      file "concept-catalog" "parseAgentName, parseAgentInstructions and parseAgentModel: trimming, UTF-16 bounds and error messages"
        agentFieldVectors),
   ("run-ownership.json",
      file "concept-catalog" "resolveAgentRunOwnership over every combination of runtime, owner, grants store and caller user"
        runOwnershipVectors)]

end Vectors.ConceptCatalog
