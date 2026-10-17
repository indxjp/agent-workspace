import AgentWorkspace.Er.Current.Publication
import AgentWorkspace.Prelude.Json

/-!
T0 — the publication concept is well formed.

The vocabularies are listed in the TypeScript order and round-trip through JSON; the typed rows
name exactly the columns of their tables, in order, with no duplicate; the cluster's foreign keys,
checks and check bodies are exactly the catalogue's; and the decimal reader behaves on the edge
cases the checks depend on.
-/

namespace AgentWorkspace.Theorems.WellFormed.ConceptPublication

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Concepts.Share
open AgentWorkspace.Er.Current.Publication

/-! ## Vocabularies -/

/-- The subject types are `agent, session, project, skill`, in the order of
`SHARE_SUBJECT_TYPES`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/shares.ts#SHARE_SUBJECT_TYPES")
  (ts := "packages/core/src/db/schema/shares.ts#shareSubjectTypes")]
theorem subject_type_wires :
    WireEnum.wires SubjectType = ["agent", "session", "project", "skill"] := by decide

/-- The visibilities are `private, workspace, public`, in the order of `SHARE_VISIBILITIES`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/shares.ts#SHARE_VISIBILITIES")
  (ts := "packages/core/src/db/schema/shares.ts#shareVisibilities")]
theorem visibility_wires : WireEnum.wires Visibility = ["private", "workspace", "public"] := by
  decide

/-- The modes are `definition, runnable`, in the order of `SHARE_MODES`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/shares.ts#SHARE_MODES")
  (ts := "packages/core/src/db/schema/shares.ts#shareModes")]
theorem mode_wires : WireEnum.wires Mode = ["definition", "runnable"] := by decide

/-- The expiries are `24 h, 7 days, 30 days, never`, in the order of `SHARE_EXPIRIES`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/shares.ts#SHARE_EXPIRIES")]
theorem expiry_wires : WireEnum.wires Expiry = ["24 h", "7 days", "30 days", "never"] := by
  decide

/-- The derived share states are spelled `live, revoked, suspended, stopped, expired`. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#2-state-machines")]
theorem share_state_wires :
    WireEnum.wires ShareState = ["live", "revoked", "suspended", "stopped", "expired"] := by
  decide

/-- Every member of the four share vocabularies decodes from its own JSON encoding. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")]
theorem share_vocabularies_round_trip (t : SubjectType) (v : Visibility) (m : Mode)
    (e : Expiry) :
    WireEnum.fromJsonValue? (WireEnum.toJsonValue t) = some t ∧
      WireEnum.fromJsonValue? (WireEnum.toJsonValue v) = some v ∧
      WireEnum.fromJsonValue? (WireEnum.toJsonValue m) = some m ∧
      WireEnum.fromJsonValue? (WireEnum.toJsonValue e) = some e :=
  ⟨WireEnum.fromJsonValue?_toJsonValue t, WireEnum.fromJsonValue?_toJsonValue v,
    WireEnum.fromJsonValue?_toJsonValue m, WireEnum.fromJsonValue?_toJsonValue e⟩

/-- A spelling that is not a member (a capitalised, padded or foreign word) decodes to nothing. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/shares.ts#ShareResourceSchema")]
theorem share_vocabularies_reject_near_misses :
    WireEnum.ofWire? (α := SubjectType) "Agent" = none ∧
      WireEnum.ofWire? (α := SubjectType) "file" = none ∧
      WireEnum.ofWire? (α := Visibility) "public " = none ∧
      WireEnum.ofWire? (α := Visibility) "link" = none ∧
      WireEnum.ofWire? (α := Mode) "run" = none ∧
      WireEnum.ofWire? (α := Expiry) "24h" = none := by decide

/-- A subject type's table is one of the four subject tables, and distinct subject types live in
distinct tables. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/composition/register.ts#subjectOwnership")]
theorem subject_table_is_injective (a b : SubjectType) (h : a.table = b.table) : a = b := by
  cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-! ## Typed rows name exactly their table's columns -/

/-- A typed share names every column of `shares`, in declaration order, whatever its values. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem share_cells_are_the_columns (s : Share) :
    s.cells.map Prod.fst = (catalogue .shares).columnNames := rfl

/-- A typed share view names every column of `share_views`, in declaration order. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/share-views.ts#shareViews")]
theorem share_view_cells_are_the_columns (v : ShareView) :
    v.cells.map Prod.fst = (catalogue .shareViews).columnNames := rfl

/-- A typed run charge names every column of `share_run_charges`, in declaration order. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
theorem share_run_charge_cells_are_the_columns (c : ShareRunCharge) :
    c.cells.map Prod.fst = (catalogue .shareRunCharges).columnNames := rfl

/-- The column names of the three cluster tables have no duplicate, so a typed row's cells are a
function of the column name. -/
@[aw_spec (tier := T0)
  (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")]
theorem cluster_column_names_are_distinct :
    (catalogue .shares).columnNames.Nodup ∧ (catalogue .shareViews).columnNames.Nodup ∧
      (catalogue .shareRunCharges).columnNames.Nodup := by decide

/-! ## The cluster's constraints are exactly the catalogue's -/

/-- The nine named foreign keys are exactly the foreign keys the catalogue gives the three
tables, in order. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "packages/core/src/db/schema/share-views.ts#shareViews")
  (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
theorem cluster_foreign_keys_are_the_catalogue's :
    tables.flatMap (fun t => (catalogue t).foreignKeys.map (t, ·)) = foreignKeys := by decide

/-- The tenancy classes of the nine keys: three root references, the global `created_by → users`
reference, and five tenant-paired keys; none is unpaired or merely sibling-paired. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")]
theorem cluster_foreign_key_classes :
    foreignKeys.map (fun p => classify catalogue p.1 p.2) =
      [.rootReference, .globalReference, .tenantPaired, .tenantPaired, .rootReference,
        .tenantPaired, .rootReference, .tenantPaired, .tenantPaired] := by decide

/-- Every check of the cluster that is not a closed set has a pinned SQL body and a semantics,
and those are exactly the checks the catalogue records. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
theorem refined_checks_are_the_catalogue's :
    tables.flatMap (fun t => (catalogue t).checks.filterMap fun
        | .other n => some (t, n)
        | .oneOf .. => none) = checkSql.map (fun p => (p.1, p.2.1)) ∧
      checkSql.all (fun p => (checkSemantics? p.2.1 ⟨[]⟩).isSome) := by decide

/-- The closed-set checks of `shares` list exactly the concept's vocabularies. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "packages/core/src/db/schema/one-of.ts#oneOf")]
theorem closed_set_checks_are_the_vocabularies :
    (catalogue .shares).oneOfCheck? "shares_subject_type_valid" =
        some ("subject_type", WireEnum.wires SubjectType) ∧
      (catalogue .shares).oneOfCheck? "shares_visibility_valid" =
        some ("visibility", WireEnum.wires Visibility) ∧
      (catalogue .shares).oneOfCheck? "shares_mode_valid" = some ("mode", WireEnum.wires Mode) := by
  decide

/-- The three tables have no check the cluster leaves without a semantics: every `.other` check
of them is refined, so `refinedCheckHolds` never falls back to `otherCheckHolds` there. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem cluster_checks_all_refined :
    tables.all fun t => (catalogue t).checks.all fun
      | .other n => (checkSemantics? n ⟨[]⟩).isSome
      | .oneOf .. => true := by decide

/-- A check name outside the cluster has no cluster semantics. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem foreign_check_has_no_semantics (r : Row) :
    checkSemantics? "runs_ended_at_iff_terminal" r = none ∧
      checkSemantics? "workspace_principals_source_xor" r = none := by
  simp [checkSemantics?]

/-! ## Decimal amounts -/

/-- The decimal reader accepts plain and signed decimals and refuses empty strings, exponents,
bare points, spaces and a leading `+`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem decimal_parse_edges :
    (Decimal.parse? "20").isSome ∧ (Decimal.parse? "0.000001").isSome ∧
      (Decimal.parse? "-1.5").isSome ∧ Decimal.parse? "" = none ∧ Decimal.parse? "1e3" = none ∧
      Decimal.parse? "." = none ∧ Decimal.parse? "1." = none ∧ Decimal.parse? " 1" = none ∧
      Decimal.parse? "+1" = none ∧ Decimal.parse? "-" = none := by decide

/-- `x >= 0` holds of zero, of a signed zero and of a positive amount, and fails for the
smallest negative ledger amount and for text that is not a number. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/shares.ts#shares")
  (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
theorem non_negative_amount_edges :
    nonNegativeAmount "0" ∧ nonNegativeAmount "-0.000000" ∧ nonNegativeAmount "12.3456" ∧
      nonNegativeAmount "-0.000001" = false ∧ nonNegativeAmount "-1" = false ∧
      nonNegativeAmount "abc" = false := by decide

/-- A decimal's value in millionths: `20` is twenty million, `0.5` is half a million, and a value
with seven fraction digits has no exact six-decimal reading. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/share-run-charges.ts#shareRunCharges")]
theorem decimal_micros_edges :
    ((Decimal.parse? "20").bind Decimal.toMicros?) = some 20000000 ∧
      ((Decimal.parse? "0.5").bind Decimal.toMicros?) = some 500000 ∧
      ((Decimal.parse? "-1.25").bind Decimal.toMicros?) = some (-1250000) ∧
      ((Decimal.parse? "0.0000001").bind Decimal.toMicros?) = none := by decide

/-- `numeric(12, 4)` admits eight integer digits and four fraction digits, and no more. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/shares.ts#shares")]
theorem numeric_12_4_bounds :
    ((Decimal.parse? "99999999.9999").map (Decimal.fits 12 4)) = some true ∧
      ((Decimal.parse? "100000000").map (Decimal.fits 12 4)) = some false ∧
      ((Decimal.parse? "1.00001").map (Decimal.fits 12 4)) = some false ∧
      ((Decimal.parse? "000020").map (Decimal.fits 12 4)) = some true := by decide

/-- The `include` object renders as `{}` when nothing was opted into, and lists the opted keys in
schema order otherwise. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/shares.ts#ShareIncludeSchema")]
theorem include_json_text :
    ({} : Include).toJsonText = "{}" ∧
      ({ technicalDetails := some true, outputFiles := some false } : Include).toJsonText =
        "{\"technicalDetails\":true,\"outputFiles\":false}" ∧
      ({ outputFiles := some true } : Include).toJsonText = "{\"outputFiles\":true}" := by decide

end AgentWorkspace.Theorems.WellFormed.ConceptPublication
