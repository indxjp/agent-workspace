import ErSnapshot
import AgentWorkspace.Er.Current.Identity

/-!
T0 — the identity cluster's definitions are coherent.

* The closed unions (roles, principal kinds in both spellings, scope kinds, verifiers, invitation
  states, multiplicities) have the spellings of their TypeScript lists, and the database checks
  hold the role, principal-kind and scope-kind columns to exactly those spellings.
* The 36 refined checks cover exactly the checks `catalogue` records without a meaning. The
  `aw_identity_check_theorems` elaborator generates, per check, `<check>_renders_as_snapshot`
  (its `render` is the body the latest snapshot (`Er.Snapshot.file`) records, read while this file
  elaborates) and `<check>_separates_its_samples` (its three-valued `eval` accepts and refuses the
  boundary rows of `samples`).
* The one-of shapes round-trip: a principal's row decodes to its source, a browser token's row to
  its scope, a membership's row to the membership.
* The `Principal` constructors build well-formed actors, and `fromDirectoryRecord` does so exactly
  for a coherent record.
-/

namespace AgentWorkspace.Theorems.WellFormed.ConceptIdentity

open AgentWorkspace AgentWorkspace.Er.Core AgentWorkspace.Er.Current.Identity
  AgentWorkspace.Concepts.Workspace AgentWorkspace.Concepts.User
  AgentWorkspace.Concepts.Membership AgentWorkspace.Concepts.ApiKey
  AgentWorkspace.Concepts.BrowserToken AgentWorkspace.Concepts.Principal
  AgentWorkspace.Concepts.Invitation

/-! ## Enumerations -/

/-- The role spellings are exactly `MEMBERSHIP_ROLES`, in its order. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/team.ts#MEMBERSHIP_ROLES")
  (ts := "packages/core/src/db/schema/memberships.ts#membershipRoles")
  (ts := "apps/web/server/rbac/roles.ts#ROLES")]
theorem role_wires_match_contract :
    WireEnum.wires Role = ["owner", "admin", "builder", "viewer"] := by decide +kernel

/-- Decoding the JSON encoding of any role gives that role back. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/team.ts#MEMBERSHIP_ROLES")]
theorem role_json_round_trips (r : Role) :
    WireEnum.fromJsonValue? (WireEnum.toJsonValue r) = some r :=
  WireEnum.fromJsonValue?_toJsonValue r

/-- `parseRole` refuses every string that is not exactly one of the four spellings: no case
folding, no whitespace, no default. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/roles.ts#parseRole")]
theorem parse_role_refuses_unknown_spelling (s : String)
    (h : s ∉ ["owner", "admin", "builder", "viewer"]) : parseRole s = none := by
  unfold parseRole
  rw [WireEnum.ofWire?_eq_none_iff, role_wires_match_contract]
  exact h

example : parseRole "Owner" = none ∧ parseRole " viewer" = none ∧ parseRole "member" = none :=
  ⟨parse_role_refuses_unknown_spelling _ (by decide +kernel),
    parse_role_refuses_unknown_spelling _ (by decide +kernel),
    parse_role_refuses_unknown_spelling _ (by decide +kernel)⟩

/-- Every role column of the schema (`memberships`, `api_keys`, `invitations`) is checked against
exactly the four role spellings. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/memberships.ts#memberships_role_valid")
  (ts := "packages/core/src/db/schema/api-keys.ts#api_keys_role_valid")
  (ts := "packages/core/src/db/schema/invitations.ts#invitations_role_valid")]
theorem role_checks_hold_the_four_roles :
    (catalogue .memberships).oneOfCheck? "memberships_role_valid" =
        some ("role", WireEnum.wires Role) ∧
      (catalogue .apiKeys).oneOfCheck? "api_keys_role_valid" = some ("role", WireEnum.wires Role) ∧
      (catalogue .invitations).oneOfCheck? "invitations_role_valid" =
        some ("role", WireEnum.wires Role) := by decide +kernel

/-- The wire principal kinds are exactly the contract's `PRINCIPAL_KINDS`. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/team.ts#PRINCIPAL_KINDS")]
theorem principal_kind_wires_match_contract :
    WireEnum.wires Kind = ["membership", "api-key"] := by decide +kernel

/-- The storage spellings are the schema's `workspacePrincipalKinds` (and the server's
`PRINCIPAL_KINDS`), and `workspace_principals_kind_valid` admits exactly them. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_kind_valid")
  (ts := "apps/web/server/rbac/principal.ts#PRINCIPAL_KINDS")]
theorem principal_kind_storage_matches_schema :
    storageSpellings = ["membership", "api_key"] ∧
      (catalogue .workspacePrincipals).oneOfCheck? "workspace_principals_kind_valid" =
        some ("kind", storageSpellings) := by decide +kernel

/-- Reading back the storage spelling of a kind gives the kind. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipalKinds")]
theorem principal_kind_storage_round_trips (k : Kind) : Kind.ofStorage? k.toStorage = some k := by
  cases k <;> rfl

/-- `wireKind` maps each storage spelling to the wire spelling of the same kind, and a wire
spelling is not a storage spelling. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/handlers.ts#wireKind")]
theorem wire_kind_maps_storage_to_wire :
    wireKindOfStorage? "membership" = some "membership" ∧
      wireKindOfStorage? "api_key" = some "api-key" ∧ wireKindOfStorage? "api-key" = none := by
  decide +kernel

/-- The scope kinds are `TOKEN_SCOPE_KINDS` (contract and server) and `browserTokenScopeKinds`,
and `browser_tokens_scope_kind_valid` admits exactly them. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/tokens.ts#TOKEN_SCOPE_KINDS")
  (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_scope_kind_valid")]
theorem scope_kind_wires_match_contract_and_schema :
    WireEnum.wires ScopeKind = ["run", "session"] ∧
      (catalogue .browserTokens).oneOfCheck? "browser_tokens_scope_kind_valid" =
        some ("scope_kind", WireEnum.wires ScopeKind) := by decide +kernel

/-- The verifiers are `session`, `api-key` and `browser-token`, the members of `Via`. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/principal.ts#Via")]
theorem via_wires_match_server :
    WireEnum.wires Via = ["session", "api-key", "browser-token"] := by decide +kernel

/-- The invitation states are the four `InvitationState` names. -/
@[aw_spec (tier := T0) (ts := "apps/web/components/team/invitations-model.ts#InvitationState")]
theorem invitation_state_wires :
    WireEnum.wires InvitationState = ["pending", "expired", "accepted", "revoked"] := by decide +kernel

/-! ## The refined checks -/

/-- The 36 refined checks cover exactly the checks `catalogue` records without a meaning on the
fourteen identity tables, in the same order, and no check is refined twice. -/
@[aw_spec (tier := T0) (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
  (ts := "packages/core/src/db/schema/index.ts")]
theorem refined_checks_cover_the_cluster :
    tables.all (fun t => (checksOf t).map (·.1) == otherCheckNames t) = true ∧
      checks.all (fun c => tables.contains c.1) = true ∧ (checks.map (·.2.1)).Nodup ∧
      checks.length = 36 := by decide +kernel

section Generator

open Lean Elab Command

/-- A `/-- … -/` docstring node for generated declarations. -/
private def mkDocComment (text : String) : TSyntax ``Lean.Parser.Command.docComment :=
  ⟨mkNode ``Lean.Parser.Command.docComment #[mkAtom "/--", mkAtom (text ++ " -/")]⟩

private partial def findRoot (dir : System.FilePath) : IO (Option System.FilePath) := do
  if ← (dir / "migrations" / "meta" / AgentWorkspace.Er.Snapshot.file).pathExists then return some dir
  match dir.parent with
  | some p => if p == dir then return none else findRoot p
  | none => return none

/-- `(table, check) ↦ body` for every check the snapshot records. -/
private def snapshotChecks (root : System.FilePath) : IO (Except String (List (String × String × String))) := do
  let text ← IO.FS.readFile (root / "migrations" / "meta" / AgentWorkspace.Er.Snapshot.file)
  return do
    let top ← Json.parse text
    let tables ← top.getObjVal? "tables"
    let .obj kvs := tables | throw "tables is not an object"
    let mut out := []
    for (_, t) in kvs.toList do
      let name ← t.getObjValAs? String "name"
      let cks ← t.getObjVal? "checkConstraints"
      let .obj cs := cks | throw s!"{name}: checkConstraints is not an object"
      for (_, c) in cs.toList do
        out := (name, ← c.getObjValAs? String "name", ← c.getObjValAs? String "value") :: out
    return out

/-- Elaborates, for each refined check, its snapshot-rendering and sample-separation theorems. -/
elab "aw_identity_check_theorems" : command => do
  let file ← IO.FS.realPath (← getFileName)
  let fromFile ← findRoot (file.parent.getD ".")
  let fromCwd ← findRoot (← IO.currentDir)
  let some root := fromFile <|> fromCwd
    | throwError "aw_identity_check_theorems: migrations/meta/{AgentWorkspace.Er.Snapshot.file} not found"
  let snap ← match ← snapshotChecks root with
    | .ok xs => pure xs
    | .error e => throwError "aw_identity_check_theorems: {e}"
  for (t, n, e) in checks do
    let s := catalogue t
    let sql := TableName.toWire t
    let some (_, _, body) := snap.find? (fun (tb, cn, _) => tb == sql && cn == n)
      | throwError "the snapshot has no check {n} on {sql}"
    let path := "packages/core/src/db/schema/" ++ s.source
    let ts := Syntax.mkStrLit (path ++ "#" ++ n)
    let _ := e
    let thm := mkIdent (Name.mkSimple s!"{n}_renders_as_snapshot")
    let doc := mkDocComment s!"The meaning given to `{n}` renders as exactly the SQL body \
      `drizzle-kit` records for it on `{sql}`."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T0))
        (doc := "docs/formal/inventory.md#5-db-tables-packagescoresrcdbschemats-33-tables")
        (ts := $ts)]
      theorem $thm :
          (semantics? $(Syntax.mkStrLit n)).map (CheckExpr.render $(Syntax.mkStrLit sql)) =
            some $(Syntax.mkStrLit body) := by decide +kernel))
    let thm := mkIdent (Name.mkSimple s!"{n}_separates_its_samples")
    let doc := mkDocComment s!"The check `{n}` of `{sql}`, read in SQL's three-valued logic, \
      accepts each of its accepted sample rows and refuses each of its refused ones."
    elabCommand (← `(command|
      $doc:docComment
      @[aw_spec (tier := $(mkIdent `T0)) (ts := $ts)]
      theorem $thm : separatesSamples $(Syntax.mkStrLit n) = true := by
        set_option maxRecDepth 16384 in decide +kernel))

end Generator

set_option maxRecDepth 16384 in
aw_identity_check_theorems

/-- On a row whose `kind` is not `NULL`, the three-valued reading of
`workspace_principals_source_xor` agrees with `Er/Core.lean`'s `principalSourceXor`. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_source_xor")]
theorem source_xor_refines_core (r : Row) (h : (r.get "kind").isSome = true) :
    (CheckExpr.xor "kind" "membership" "membership_id" "api_key" "api_key_id").holds r =
      principalSourceXor r := by
  cases hk : r.get "kind" with
  | none => rw [hk] at h; cases h
  | some k =>
    simp only [CheckExpr.holds, CheckExpr.eval, principalSourceXor, eqText, hk, Option.map_some]
    cases hm : r.get "membership_id" <;> cases ha : r.get "api_key_id" <;>
      cases (k == "membership") <;> cases (k == "api_key") <;> rfl

example : (CheckExpr.xor "kind" "membership" "membership_id" "api_key" "api_key_id").holds
    ⟨[("kind", "api_key"), ("api_key_id", "k1")]⟩ = principalSourceXor
    ⟨[("kind", "api_key"), ("api_key_id", "k1")]⟩ :=
  source_xor_refines_core _ rfl

/-! ## One-of shapes and row codecs -/

/-- A principal's row decodes to exactly its source: the kind names the one id column that is
set, and the other is `NULL`. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_source_xor")
  (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
theorem principal_source_round_trips (p : Principal) : sourceOfRow? p.toRow = some p.source := by
  obtain ⟨id, ws, src, act, rev, cr, actsFor⟩ := p
  cases src <;> cases rev <;> cases actsFor <;> rfl

/-- A principal's row records exactly the principal it acts for: `acts_for_principal_id` reads
back as `actsFor`, `NULL` for a principal that acts for no one. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")
  (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
theorem principal_acts_for_round_trips (p : Principal) : actsForOfRow? p.toRow = p.actsFor := by
  obtain ⟨⟨id⟩, ⟨ws⟩, src, act, rev, cr, actsFor⟩ := p
  cases src <;> cases rev <;> cases actsFor <;>
    simp [actsForOfRow?, Principal.toRow, Source.cells, cell?, Row.get, List.lookup_cons]

/-- A browser token's row decodes to exactly its scope. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_scope_xor")]
theorem browser_token_scope_round_trips (t : BrowserToken) :
    scopeOfRow? t.toRow = some t.scope := by
  obtain ⟨id, ws, minter, scope, hash, exp, rev, cr⟩ := t
  cases scope <;> cases rev <;> rfl

private theorem xor_true_iff (r : Row) (k v1 c1 v2 c2 : String) :
    ((CheckExpr.xor k v1 c1 v2 c2).eval r == some true) =
      ((r.get k == some v1 && (r.get c1).isSome && (r.get c2).isNone) ||
        (r.get k == some v2 && (r.get c2).isSome && (r.get c1).isNone)) := by
  simp only [CheckExpr.eval, eqText]
  cases r.get k with
  | none => cases r.get c1 <;> cases r.get c2 <;> rfl
  | some x =>
    have e1 : (some x == some v1) = (x == v1) := rfl
    have e2 : (some x == some v2) = (x == v2) := rfl
    simp only [Option.map_some, e1, e2]
    cases x == v1 <;> cases x == v2 <;> cases r.get c1 <;> cases r.get c2 <;> rfl

private theorem xor_true_eq_holds (r : Row) (k v1 c1 v2 c2 : String)
    (h : (r.get k).isSome = true) :
    ((CheckExpr.xor k v1 c1 v2 c2).eval r == some true) = (CheckExpr.xor k v1 c1 v2 c2).holds r := by
  simp only [CheckExpr.holds, CheckExpr.eval, eqText]
  cases hk : r.get k with
  | none => rw [hk] at h; cases h
  | some x =>
    simp only [Option.map_some]
    cases x == v1 <;> cases x == v2 <;> cases r.get c1 <;> cases r.get c2 <;> rfl

/-- A `workspace_principals` row decodes to a source exactly when the source-XOR check evaluates to
`TRUE` on it: the decoder never reads a source off a row the check refuses or leaves unknown. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_source_xor")
  (ts := "packages/core/src/db/repositories/directory.ts#principalById")]
theorem source_of_row_decodes_iff_source_xor_is_true (r : Row) :
    (sourceOfRow? r).isSome =
      ((CheckExpr.xor "kind" "membership" "membership_id" "api_key" "api_key_id").eval r ==
        some true) := by
  rw [xor_true_iff]
  simp only [sourceOfRow?]
  cases r.get "kind" with
  | none => simp
  | some k =>
    cases r.get "membership_id" <;> cases r.get "api_key_id" <;>
      by_cases h1 : k = "membership" <;> by_cases h2 : k = "api_key" <;> subst_vars <;>
      simp_all

example : (sourceOfRow? ⟨[("kind", "membership"), ("membership_id", "m1"),
    ("api_key_id", "k1")]⟩).isSome = false :=
  (source_of_row_decodes_iff_source_xor_is_true _).trans (by decide +kernel)

/-- On a row with a `kind`, a `workspace_principals` row decodes to a source exactly when the
row passes `workspace_principals_source_xor`. -/
@[aw_spec (tier := T0)
  (ts := "packages/core/src/db/schema/workspace-principals.ts#workspace_principals_source_xor")]
theorem source_of_row_decodes_iff_source_xor_holds (r : Row) (h : (r.get "kind").isSome = true) :
    (sourceOfRow? r).isSome =
      (CheckExpr.xor "kind" "membership" "membership_id" "api_key" "api_key_id").holds r := by
  rw [source_of_row_decodes_iff_source_xor_is_true, xor_true_eq_holds r _ _ _ _ _ h]

example : (sourceOfRow? ⟨[("kind", "api_key"), ("api_key_id", "k1")]⟩).isSome =
    (CheckExpr.xor "kind" "membership" "membership_id" "api_key" "api_key_id").holds
      ⟨[("kind", "api_key"), ("api_key_id", "k1")]⟩ :=
  source_of_row_decodes_iff_source_xor_holds _ rfl

/-- A `browser_tokens` row decodes to a scope exactly when the scope-XOR check evaluates to `TRUE`
on it. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_scope_xor")]
theorem scope_of_row_decodes_iff_scope_xor_is_true (r : Row) :
    (scopeOfRow? r).isSome =
      ((CheckExpr.xor "scope_kind" "run" "run_id" "session" "session_id").eval r == some true) := by
  rw [xor_true_iff]
  simp only [scopeOfRow?]
  cases r.get "scope_kind" with
  | none => simp
  | some k =>
    cases r.get "run_id" <;> cases r.get "session_id" <;>
      by_cases h1 : k = "run" <;> by_cases h2 : k = "session" <;> subst_vars <;>
      simp_all

example : (scopeOfRow? ⟨[("scope_kind", "run"), ("run_id", "r1"),
    ("session_id", "s1")]⟩).isSome = false :=
  (scope_of_row_decodes_iff_scope_xor_is_true _).trans (by decide +kernel)

/-- On a row with a `scope_kind`, a `browser_tokens` row decodes to a scope exactly when the row
passes `browser_tokens_scope_xor`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/browser-tokens.ts#browser_tokens_scope_xor")]
theorem scope_of_row_decodes_iff_scope_xor_holds (r : Row)
    (h : (r.get "scope_kind").isSome = true) :
    (scopeOfRow? r).isSome =
      (CheckExpr.xor "scope_kind" "run" "run_id" "session" "session_id").holds r := by
  rw [scope_of_row_decodes_iff_scope_xor_is_true, xor_true_eq_holds r _ _ _ _ _ h]

example : (scopeOfRow? ⟨[("scope_kind", "session"), ("session_id", "s1")]⟩).isSome =
    (CheckExpr.xor "scope_kind" "run" "run_id" "session" "session_id").holds
      ⟨[("scope_kind", "session"), ("session_id", "s1")]⟩ :=
  scope_of_row_decodes_iff_scope_xor_holds _ rfl

/-- A membership's row decodes back to the membership (every column, the role through
`parseRole`, the timestamps through their numerals). -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/memberships.ts#memberships")]
theorem membership_row_round_trips (m : Membership) : Membership.ofRow? m.toRow = some m := by
  obtain ⟨⟨id⟩, ⟨ws⟩, ⟨u⟩, role, cr, up⟩ := m
  have hr : parseRole (WireEnum.toWire role) = some role := WireEnum.ofWire?_toWire role
  simp [Membership.ofRow?, Membership.toRow, Row.get, List.lookup_cons, instantOf?,
    parseInstant?_instantText, hr]

/-! ## The authenticated principal's constructors -/

/-- `fromApiKey` always builds a well-formed API-key principal: no user, a key id, no scope. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/principal.ts#fromApiKey")
  (ts := "apps/web/server/rbac/principal.ts#isPrincipal")]
theorem from_api_key_is_well_formed (i : ApiKeyIdentity) : (fromApiKey i).wellFormed = true := by
  rfl

/-- `fromDirectoryRecord` builds a principal that `isPrincipal` accepts exactly when the record
is coherent (a user id exactly for a membership, a key id exactly for an API key): it copies the
two ids without checking them. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/principal.ts#fromDirectoryRecord")
  (ts := "apps/web/server/rbac/principal.ts#isPrincipal")]
theorem from_directory_record_well_formed_iff_coherent (r : DirectoryRecord) :
    (fromDirectoryRecord r).wellFormed = r.coherent := by
  obtain ⟨pid, kind, ws, role, label, user, key, actsFor⟩ := r
  cases kind <;> cases user <;> cases key <;>
    simp [fromDirectoryRecord, Actor.wellFormed, DirectoryRecord.coherent]

/-- A browser token minted by a well-formed session or API-key principal yields a well-formed
principal, whatever the scope. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/principal.ts#fromBrowserToken")
  (ts := "apps/web/server/rbac/principal.ts#isPrincipal")]
theorem from_browser_token_is_well_formed (m : Actor) (s : Scope) (hm : m.wellFormed = true)
    (hv : m.via ≠ .browserToken) : (fromBrowserToken m s).wellFormed = true := by
  obtain ⟨pid, kind, ws, label, user, actor, role, via, key, scope, owner⟩ := m
  cases kind <;> cases via <;> cases user <;> cases key <;> cases scope <;>
    simp_all [Actor.wellFormed, fromBrowserToken]

example : (fromBrowserToken (fromApiKey ⟨"p", "k", "w", .builder, "CI", none⟩)
    (.run ⟨"r"⟩)).wellFormed = true :=
  from_browser_token_is_well_formed _ _ rfl (by decide +kernel)

/-- A well-formed authenticated principal carries a scope exactly when a browser token produced
it: `isPrincipal`'s scope invariant. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/principal.ts#isPrincipal")
  (ts := "apps/web/server/rbac/principal.ts#Principal")]
theorem well_formed_actor_has_a_scope_iff_via_browser_token (a : Actor)
    (h : a.wellFormed = true) : a.scope.isSome = (a.via == .browserToken) := by
  simp only [Actor.wellFormed, Bool.and_eq_true, beq_iff_eq] at h
  exact h.1.symm

/-- An actor whose scope disagrees with its verifier — a browser-token actor with no scope, or a
session or API-key actor with one — is refused, whatever its other fields. -/
@[aw_spec (tier := T0) (ts := "apps/web/server/rbac/principal.ts#isPrincipal")]
theorem actor_with_a_scope_its_verifier_does_not_carry_is_refused (a : Actor)
    (h : a.scope.isSome ≠ (a.via == .browserToken)) : a.wellFormed = false := by
  cases hw : a.wellFormed
  · rfl
  · exact absurd (well_formed_actor_has_a_scope_iff_via_browser_token a hw) h

/-- A browser-token actor with no scope, and a session actor with one, each otherwise the shape of a
well-formed membership principal. -/
private def unscopedTokenActor : Actor :=
  ⟨"p", .membership, "w", "Ada", some "u", "Ada", .owner, .browserToken, none, none, "p"⟩

example : unscopedTokenActor.wellFormed = false ∧
    { unscopedTokenActor with scope := some (.run ⟨"r"⟩) }.wellFormed = true ∧
    { unscopedTokenActor with via := .session, scope := some (.run ⟨"r"⟩) }.wellFormed = false ∧
    { unscopedTokenActor with via := .session }.wellFormed = true :=
  ⟨actor_with_a_scope_its_verifier_does_not_carry_is_refused _ (by decide +kernel), by decide +kernel,
    actor_with_a_scope_its_verifier_does_not_carry_is_refused _ (by decide +kernel), by decide⟩

/-! ## Concept values are rows the database admits -/

private theorem role_contains (r : Role) :
    ["owner", "admin", "builder", "viewer"].contains (WireEnum.toWire r) = true := by
  cases r <;> decide +kernel

private theorem role_disj (r : Role) :
    WireEnum.toWire r = "owner" ∨ WireEnum.toWire r = "admin" ∨ WireEnum.toWire r = "builder" ∨
      WireEnum.toWire r = "viewer" := by
  cases r <;> decide +kernel

private theorem bne_true_of_ne {a b : String} (h : ¬a = b) : (a != b) = true := by
  simp [bne_iff_ne, h]

/-- Unfold row admission on a concrete row shape. -/
local macro "identity_row_simp" : tactic => `(tactic|
  simp_all [rowAdmitted, cell?, rowTyped, cellTyped, catalogue, checksOf, checks,
      checkHolds, CheckExpr.holds, CheckExpr.eval, Row.get, List.lookup_cons, TableSpec.column?,
      TableSpec.hasColumn, parseInstant?_instantText, instantOf?, cmpCells, eqText, and3, or3,
      Rel.apply, otherCheckHolds, principalSourceXor, Pattern.test, boolText, role_contains,
      role_disj, neCells])

set_option maxHeartbeats 2000000 in
/-- A valid workspace's row is one `workspaces` admits: every column known, every `NOT NULL`
column set, well typed, and every check passing — the default-model pair by construction. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")]
theorem workspace_row_is_admitted (w : Workspace) (h : w.valid = true) :
    rowAdmitted .workspaces w.toRow = true := by
  obtain ⟨⟨id⟩, slug, name, pub, dm, arch, cr, up⟩ := w
  cases dm <;> cases arch <;> cases pub <;> simp_all [Workspace.toRow, Workspace.valid] <;>
    identity_row_simp

/-- A valid user's row is one `users` admits. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/users.ts#users")]
theorem user_row_is_admitted (u : User) (h : u.valid = true) : rowAdmitted .users u.toRow = true := by
  obtain ⟨⟨id⟩, e, n, cr, up⟩ := u
  simp_all [User.toRow, User.valid] <;> identity_row_simp

/-- A valid OIDC identity's row is one `user_identities` admits. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/user-identities.ts#userIdentities")]
theorem user_identity_row_is_admitted (u : UserIdentity) (h : u.valid = true) :
    rowAdmitted .userIdentities u.toRow = true := by
  obtain ⟨⟨id⟩, i, s, ⟨us⟩, cr, up⟩ := u
  simp_all [UserIdentity.toRow, UserIdentity.valid] <;> identity_row_simp

/-- Every membership's row is one `memberships` admits: a typed role always passes
`memberships_role_valid`. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/memberships.ts#memberships")]
theorem membership_row_is_admitted (m : Membership) : rowAdmitted .memberships m.toRow = true := by
  obtain ⟨⟨id⟩, ⟨ws⟩, ⟨u⟩, role, cr, up⟩ := m
  simp [Membership.toRow] <;> identity_row_simp

/-- A valid principal's row is one `workspace_principals` admits: the source shape passes
`workspace_principals_source_xor` by construction. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/workspace-principals.ts#workspacePrincipals")]
theorem principal_row_is_admitted (p : Principal) (h : p.valid = true) :
    rowAdmitted .workspacePrincipals p.toRow = true := by
  obtain ⟨⟨id⟩, ⟨ws⟩, src, act, rev, cr, actsFor⟩ := p
  cases src <;> cases rev <;> rcases actsFor with _ | ⟨⟨a⟩⟩ <;>
    simp_all [Principal.toRow, Principal.valid, Principal.actsForValid, Principal.kind, Source.kind,
      Source.cells, Kind.toStorage] <;> identity_row_simp <;> (try simp_all [bne_true_of_ne])

set_option maxHeartbeats 2000000 in
/-- A valid API key's row is one `api_keys` admits. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/api-keys.ts#apiKeys")]
theorem api_key_row_is_admitted (k : ApiKey) (h : k.valid = true) :
    rowAdmitted .apiKeys k.toRow = true := by
  obtain ⟨⟨id⟩, ⟨ws⟩, n, role, pre, hash, lu, exp, rev, cr, up⟩ := k
  cases lu <;> cases exp <;> cases rev <;> simp_all [ApiKey.toRow, ApiKey.valid] <;>
    identity_row_simp

set_option maxHeartbeats 2000000 in
/-- A valid invitation's row is one `invitations` admits. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/invitations.ts#invitations")]
theorem invitation_row_is_admitted (i : Invitation) (h : i.valid = true) :
    rowAdmitted .invitations i.toRow = true := by
  obtain ⟨⟨id⟩, ⟨ws⟩, e, role, inv, hash, exp, acc, rev, cr, up⟩ := i
  cases inv <;> cases acc <;> cases rev <;> simp_all [Invitation.toRow, Invitation.valid] <;>
    identity_row_simp

/-- A valid browser token's row is one `browser_tokens` admits: the scope shape passes
`browser_tokens_scope_xor` by construction. -/
@[aw_spec (tier := T0) (ts := "packages/core/src/db/schema/browser-tokens.ts#browserTokens")]
theorem browser_token_row_is_admitted (t : BrowserToken) (h : t.valid = true) :
    rowAdmitted .browserTokens t.toRow = true := by
  obtain ⟨⟨id⟩, ⟨ws⟩, ⟨m⟩, sc, hash, exp, rev, cr⟩ := t
  cases sc <;> cases rev <;>
    simp_all [BrowserToken.toRow, BrowserToken.valid, Scope.kind, Scope.cells, ScopeKind.toWire] <;>
    identity_row_simp

/-! ### Witnesses: valid concept values -/

/-- A sample workspace. -/
private def sampleWorkspace : Workspace :=
  ⟨⟨"w1"⟩, "acme", "Acme", true, some ⟨⟨"c1"⟩, "claude"⟩, none, 1000, 1000⟩

example : sampleWorkspace.valid = true := by decide +kernel
example : (User.valid ⟨⟨"u1"⟩, "ada@example.com", "Ada", 1000, 1000⟩) = true := by decide +kernel
example : (UserIdentity.valid ⟨⟨"i1"⟩, "https://id.example.com", "sub-1", ⟨"u1"⟩, 1000, 1000⟩) =
    true := by decide +kernel
example : (Principal.valid ⟨⟨"p1"⟩, ⟨"w1"⟩, .apiKey ⟨"k1"⟩, 1000, some 2000, 1000, some ⟨"p0"⟩⟩) = true := by
  decide +kernel
example : (ApiKey.valid ⟨⟨"k1"⟩, ⟨"w1"⟩, "CI", .builder, "ak_live_x", "ab", none, some 5000,
    some 3000, 1000, 1000⟩) = true := by decide +kernel
example : (Invitation.valid ⟨⟨"i1"⟩, ⟨"w1"⟩, "bob@example.com", .viewer, some ⟨"u1"⟩, "ab",
    5000, some 2000, none, 1000, 1000⟩) = true := by decide +kernel
example : (BrowserToken.valid ⟨⟨"t1"⟩, ⟨"w1"⟩, ⟨"p1"⟩, .session ⟨"s1"⟩, "ab", 1300, none,
    1000⟩) = true := by decide +kernel

/-! ## Contract bounds -/

/-- The identity cluster's length bounds are the values `@indx-workspace/contracts` exports: an
API-key name at most 120, an invitation token at most 4096, a user email at most 320, a user name
and a workspace name at most 200. -/
@[aw_spec (tier := T0) (ts := "packages/contracts/src/api-keys.ts#API_KEY_NAME_MAX_LENGTH")
  (ts := "packages/contracts/src/invitations.ts#INVITATION_TOKEN_MAX_LENGTH")
  (ts := "packages/contracts/src/team.ts#USER_EMAIL_MAX_LENGTH")
  (ts := "packages/contracts/src/team.ts#USER_NAME_MAX_LENGTH")
  (ts := "packages/contracts/src/workspaces.ts#WORKSPACE_NAME_MAX_LENGTH")]
theorem identity_bounds_mirror_the_contracts :
    Concepts.ApiKey.nameMaxLength = 120 ∧ Concepts.Invitation.tokenMaxLength = 4096 ∧
      Concepts.User.emailMaxLength = 320 ∧ Concepts.User.nameMaxLength = 200 ∧
      Concepts.Workspace.nameMaxLengthContract = 200 :=
  ⟨rfl, rfl, rfl, rfl, rfl⟩

end AgentWorkspace.Theorems.WellFormed.ConceptIdentity
