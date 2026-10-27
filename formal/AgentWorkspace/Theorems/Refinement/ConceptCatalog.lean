import AgentWorkspace.Er.Current.Catalog

/-!
T4 — the typed concepts refine today's rows: a concept's invariant is exactly the conjunction of
its table's CHECK semantics evaluated on the row the concept is stored as. So a theorem about a
valid `Connector` (or `Skill`, or a file's path and key) is a theorem about every row
PostgreSQL accepts, and conversely.
-/

namespace AgentWorkspace.Theorems.Refinement.ConceptCatalog

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Catalog
open AgentWorkspace.Concepts

private theorem lookup_cell_other {c k : String} (h : (k == c) = false) (v : Option String)
    (rest : List (String × String)) : List.lookup k (cell c v ++ rest) = List.lookup k rest := by
  cases v <;> simp [cell, List.lookup, h]

private theorem lookup_cell_same (c : String) (v : Option String)
    (rest : List (String × String)) :
    List.lookup c (cell c v ++ rest) = (v <|> List.lookup c rest) := by
  cases v <;> simp [cell]

private theorem folder_ne : (File.FileKind.folder == File.FileKind.file) = false := by
  decide +kernel

private theorem file_bne_folder : (File.FileKind.file != File.FileKind.folder) = true := by
  decide +kernel

private theorem http_ne : (Connector.Transport.http == Connector.Transport.stdio) = false := by
  decide +kernel

private theorem sse_ne : (Connector.Transport.sse == Connector.Transport.stdio) = false := by
  decide +kernel

private theorem kind_bne :
    (Connector.Kind.mcp != Connector.Kind.mcp) = false ∧
      (Connector.Kind.openapi != Connector.Kind.mcp) = true ∧
      (Connector.Kind.postgres != Connector.Kind.mcp) = true ∧
      (Connector.Kind.mcp != Connector.Kind.postgres) = true ∧
      (Connector.Kind.openapi != Connector.Kind.postgres) = true ∧
      (Connector.Kind.postgres != Connector.Kind.postgres) = false := by
  decide +kernel

/-- The connector concept refines `mcp_servers`: an MCP connector is valid exactly when its row
passes every non-closed-set check of the table. On a row of kind `mcp` the five per-kind checks
of ADR-0113 C15 hold, and the seven MCP checks they guard read as before the tool kinds. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (doc := "docs/sdk/04-api-specification.md#58-connectors-mcp-servers--awconnectors")]
theorem connector_invariant_is_the_row_checks (c : Connector.Connector) (ts : String) :
    (connectorChecks.all fun n => clusterCheckHolds n (connectorRow c ts)) = c.valid := by
  obtain ⟨id, ws, name, tr, cmd, args, url, auth, sec, en, cb, own⟩ := c
  cases tr <;> cases auth <;>
    simp (config := { decide := true }) [connectorChecks, clusterCheckHolds, connectorRow,
      kindIsNot, kindMayBe,
      Row.get, List.lookup, List.append_assoc, lookup_cell_other, lookup_cell_same,
      Connector.Connector.valid, Connector.Connector.stdioHasCommand,
      Connector.Connector.remoteHasUrl, Connector.Connector.argsStdioOnly,
      Connector.Connector.commandNotBlank, Connector.Connector.urlShapeOk,
      Connector.Connector.credentialRequired, Connector.Connector.nameNotBlank, rowNotBlank,
      Connector.Transport.toWire, Connector.AuthType.toWire, Connector.Transport.isRemote,
      Connector.AuthType.needsCredential, Bool.and_assoc, http_ne, sse_ne]

/-- The tool connector concept refines `mcp_servers` (ADR-0113 C15): a tool connector is valid
exactly when its row passes every non-closed-set check of the table, the same checks an MCP row
passes. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/mcp-servers.ts#mcpServers")
  (doc := "docs/adr/0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md#sd1--tools-are-catalog-connectors-of-kind-openapi-or-postgres")]
theorem tool_connector_invariant_is_the_row_checks (t : Connector.ToolConnector) (ts : String) :
    (connectorChecks.all fun n => clusterCheckHolds n (toolConnectorRow t ts)) = t.valid := by
  obtain ⟨id, ws, name, kind, tc, sec, en, cb, own⟩ := t
  cases kind <;> cases sec <;>
    simp (config := { decide := true }) [connectorChecks, clusterCheckHolds, toolConnectorRow,
      kindIsNot, kindMayBe,
      Row.get, List.lookup, List.append_assoc, lookup_cell_other, lookup_cell_same,
      Connector.ToolConnector.valid, Connector.Kind.toWire, rowNotBlank, kind_bne]

/-- The skill concept refines `skills`: a skill is valid exactly when its row passes
`skills_name_shape` and `skills_skill_md_not_blank`. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/skills.ts#skills")
  (doc := "docs/sdk/04-api-specification.md#57-skills--awskills")]
theorem skill_invariant_is_the_row_checks (s : Skill.Skill) (ts : String) :
    (["skills_name_shape", "skills_skill_md_not_blank"].all fun n =>
      clusterCheckHolds n (skillRow s ts)) = s.valid := by
  obtain ⟨id, ws, name, md, en, cb, own⟩ := s
  simp (config := { decide := true }) [clusterCheckHolds, skillRow, Row.get, List.lookup,
    lookup_cell_other, Skill.Skill.valid, rowNotBlank]

/-- The file concept refines `files` on its path and object key: the two path checks and the two
storage-key checks of a file's row are exactly the concept's. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/files.ts#files")
  (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")]
theorem file_path_and_key_invariants_are_the_row_checks (f : File.File) (ts : String) :
    (["files_path_shape", "files_path_no_dot_segments", "files_storage_key_iff_file",
        "files_storage_key_not_blank"].all fun n => clusterCheckHolds n (fileRow f ts)) =
      (File.pathShape f.path && File.noDotSegments f.path && f.storageKeyIffFile &&
        f.storageKeyNotBlank) := by
  obtain ⟨id, ws, path, kind, key, size, ct, cb, own⟩ := f
  cases kind <;>
    simp (config := { decide := true }) [clusterCheckHolds, fileRow,
      Row.get, List.lookup, List.append_assoc,
      lookup_cell_other, lookup_cell_same, File.File.storageKeyIffFile,
      File.File.storageKeyNotBlank, rowNotBlank, File.FileKind.toWire, Bool.and_assoc, folder_ne]

/-- How `toString` renders a non-negative integer: the decimal digits of its natural number. -/
private theorem int_toString_ofNat (m : Nat) : toString (Int.ofNat m) = Nat.repr m := rfl

/-- How `toString` renders a negative integer: a `-` and the digits of its magnitude. -/
private theorem int_toString_negSucc (m : Nat) :
    toString (Int.negSucc m) = "-" ++ Nat.repr (m + 1) := rfl

/-- The decimal rendering of a natural number starts with a digit. -/
private theorem nat_repr_head (m : Nat) :
    ∃ c cs, (Nat.repr m).toList = c :: cs ∧ c.isDigit = true := by
  rw [Nat.toList_repr]
  cases h : Nat.toDigits 10 m with
  | nil => exact absurd h Nat.toDigits_ne_nil
  | cons c cs =>
    exact ⟨c, cs, rfl, Nat.isDigit_of_mem_toDigits (by decide +kernel) (by decide +kernel)
      (h ▸ List.mem_cons_self)⟩

/-- `size_bytes >= 0` read on the text of a `bigint`: the rendering starts with `-` exactly when
the integer is negative. -/
private theorem int_toString_nonneg (n : Int) :
    (n.repr.toList.head? != some '-') = decide (0 ≤ n) := by
  change ((toString n).toList.head? != some '-') = decide (0 ≤ n)
  cases n with
  | ofNat m =>
    obtain ⟨c, cs, h, hd⟩ := nat_repr_head m
    rw [int_toString_ofNat, h]
    have hne : c ≠ '-' := by rintro rfl; exact absurd hd (by decide +kernel)
    simp [hne]
  | negSucc m =>
    rw [int_toString_negSucc]
    have : ("-" ++ Nat.repr (m + 1)).toList.head? = some '-' := by
      simp [String.toList_append]
    rw [this]
    simp only [bne_self_eq_false]
    exact (decide_eq_false (by omega)).symm

/-- `size_bytes = 0` read on the text of a `bigint`: the rendering is `0` exactly for zero. -/
private theorem int_toString_eq_zero (n : Int) : (n.repr == "0") = (n == 0) := by
  change (toString n == "0") = (n == 0)
  cases n with
  | ofNat m =>
    rw [int_toString_ofNat]
    by_cases hm : m = 0
    · subst hm; decide +kernel
    · have h1 : (Nat.repr m == "0") = false := by
        rw [beq_eq_false_iff_ne]
        intro h
        have h2 : Nat.toDigits 10 m = ['0'] := by rw [← Nat.toList_repr, h]; rfl
        have := Nat.ofDigitChars_ten_toDigits (n := m)
        rw [h2] at this
        exact hm (by rw [← this]; decide +kernel)
      rw [h1]
      symm
      rw [beq_eq_false_iff_ne]
      intro h
      exact hm (by injection h)
  | negSucc m =>
    have h1 : (toString (Int.negSucc m) == "0") = false := by
      rw [beq_eq_false_iff_ne, int_toString_negSucc]
      intro h
      have := congrArg (fun s : String => s.toList.head?) h
      simp [String.toList_append] at this
    rw [h1]
    symm
    rw [beq_eq_false_iff_ne]
    exact Int.negSucc_ne_zero m

/-- The agent concept refines `agents`: an agent is valid exactly when its row passes
`agents_name_not_blank`, the table's one check that is not a key. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/agents.ts#agents")
  (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
theorem agent_invariant_is_the_row_checks (a : Agent.Agent) (ts : String) :
    (agentChecks.all fun n => clusterCheckHolds n (agentRow a ts)) = a.valid := by
  obtain ⟨id, ws, name, instr, mc, model, rp, perms, pol, cb, own⟩ := a
  simp (config := { decide := true }) [agentChecks, clusterCheckHolds, agentRow, Row.get,
    List.lookup, List.append_assoc, lookup_cell_other, Agent.Agent.valid, rowNotBlank]

/-- The file concept refines `files`: a file is valid exactly when its row passes all six
non-closed-set checks of the table, the size ones read on the decimal text of the `bigint`. -/
@[aw_spec (tier := T4) (ts := "packages/core/src/db/schema/files.ts#files")
  (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")]
theorem file_invariant_is_the_row_checks (f : File.File) (ts : String) :
    (fileChecks.all fun n => clusterCheckHolds n (fileRow f ts)) = f.valid := by
  obtain ⟨id, ws, path, kind, key, size, ct, cb, own⟩ := f
  cases kind <;>
    simp (config := { decide := true }) [fileChecks, clusterCheckHolds, fileRow,
      Row.get, List.lookup, List.append_assoc,
      lookup_cell_other, lookup_cell_same, File.File.valid, File.File.storageKeyIffFile,
      File.File.storageKeyNotBlank, File.File.sizeNonNegative, File.File.folderHasNoContent,
      rowNotBlank, File.FileKind.toWire, Bool.and_assoc, folder_ne, file_bne_folder, int_toString_nonneg,
      int_toString_eq_zero]

/-- Today's single agent state is the target's `active` state, so every current agent is a
target agent; `archived` is the one state the target adds (RF-201). -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")
  (ts := "packages/core/src/db/schema/agents.ts#agents")]
theorem current_agent_states_embed_in_the_target :
    (∀ s : Agent.StateCurrent, s.toTarget = .active) ∧
      ∀ t : Agent.StateTarget, t ≠ .active → ∀ s : Agent.StateCurrent, s.toTarget ≠ t := by
  refine ⟨fun s => by cases s; rfl, fun t ht s => ?_⟩
  cases s
  exact fun h => ht h.symm

example : (connectorChecks.all fun n => clusterCheckHolds n
    (connectorRow ⟨⟨"c1"⟩, ⟨"w1"⟩, "GitHub", .http, none, none, some "https://x", .bearer,
      some ⟨"s1"⟩, true, none, ⟨"p1"⟩⟩ "t0")) = true := by
  rw [connector_invariant_is_the_row_checks]; decide +kernel

example : (connectorChecks.all fun n => clusterCheckHolds n
    (toolConnectorRow ⟨⟨"c3"⟩, ⟨"w1"⟩, "warehouse", .postgres, "{\"tables\": [\"orders\"]}",
      some ⟨"s2"⟩, true, none, ⟨"p1"⟩⟩ "t0")) = true := by
  rw [tool_connector_invariant_is_the_row_checks]; decide +kernel

example : (connectorChecks.all fun n => clusterCheckHolds n
    (toolConnectorRow ⟨⟨"c4"⟩, ⟨"w1"⟩, "petstore", .openapi, "[]", none, true, none, ⟨"p1"⟩⟩
      "t0")) = false := by
  rw [tool_connector_invariant_is_the_row_checks]; decide +kernel

private def sampleAgent (name : String) : Agent.Agent :=
  ⟨⟨"a1"⟩, ⟨"w1"⟩, name, "", none, none, none, ⟨true, true, false, false⟩, false, none, ⟨"p1"⟩⟩

example : (agentChecks.all fun n => clusterCheckHolds n (agentRow (sampleAgent "General") "t0")) =
    true := by
  rw [agent_invariant_is_the_row_checks]; decide +kernel

example : (agentChecks.all fun n => clusterCheckHolds n (agentRow (sampleAgent "   ") "t0")) =
    false := by
  rw [agent_invariant_is_the_row_checks]; decide +kernel

private def sampleFile (kind : File.FileKind) (key : Option String) (size : Int)
    (ct : Option String) : File.File :=
  ⟨⟨"f1"⟩, ⟨"w1"⟩, "contracts/agreement.pdf", kind, key, size, ct, none, ⟨"p1"⟩⟩

example : (fileChecks.all fun n => clusterCheckHolds n
    (fileRow (sampleFile .file (some "k") 1024 (some "application/pdf")) "t0")) = true := by
  rw [file_invariant_is_the_row_checks]; decide +kernel

example : (fileChecks.all fun n => clusterCheckHolds n
    (fileRow (sampleFile .folder none 0 none) "t0")) = true := by
  rw [file_invariant_is_the_row_checks]; decide +kernel

/-- A negative size fails `files_size_non_negative` on the row. -/
example : clusterCheckHolds "files_size_non_negative"
    (fileRow (sampleFile .file (some "k") (-1) none) "t0") = false := by decide +kernel

/-- A folder with a content type fails `files_folder_has_no_content` on the row. -/
example : clusterCheckHolds "files_folder_has_no_content"
    (fileRow (sampleFile .folder none 0 (some "text/plain")) "t0") = false := by decide +kernel

/-- A folder with a non-zero size fails `files_folder_has_no_content` on the row. -/
example : clusterCheckHolds "files_folder_has_no_content"
    (fileRow (sampleFile .folder none 5 none) "t0") = false := by decide +kernel

example : (fileChecks.all fun n => clusterCheckHolds n
    (fileRow (sampleFile .file (some "k") (-7) none) "t0")) = false := by
  rw [file_invariant_is_the_row_checks]; decide +kernel

end AgentWorkspace.Theorems.Refinement.ConceptCatalog
