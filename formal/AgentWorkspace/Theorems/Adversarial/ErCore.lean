import AgentWorkspace.Theorems.Invariants.ErCore

/-!
T3 — what a hostile writer cannot achieve against the schema.

The attacker controls whole rows: every column value of a row it inserts or updates, including
ids copied from another workspace. It must not obtain a stored reference from its workspace to a
row of another. The second attacker controls the value list handed to `oneOf`, and must not get a
quote or other SQL syntax inlined into DDL.
-/

namespace AgentWorkspace.Theorems.Adversarial.ErCore

open AgentWorkspace AgentWorkspace.Er.Core
open AgentWorkspace.Theorems.Invariants.ErCore

/-- Under a schema with no unpaired reference, a state in which some row references a
tenant-carrying row of a different workspace is not a state the database accepts, whatever ids
the writer copied into the row. -/
@[aw_spec (tier := T3)
  (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem forged_cross_tenant_reference_is_rejected (S : Schema) (hS : pairingComplete S = true)
    (st : State) {t : TableName} {fk : ForeignKey} {r r' : Row}
    (htarget : (S fk.refTable).tenantColumn?.isSome = true) (href : References S st t fk r r')
    (hcross : tenantOf S t r ≠ tenantOf S fk.refTable r') : consistent S st = false := by
  cases hc : consistent S st with
  | false => rfl
  | true => exact absurd (no_cross_tenant_reference S hS st hc htarget href) hcross

namespace Forged

/-- The witness state of `Invariants.ErCore`, with the second workspace given its own member and
principal, and an agent of the second workspace that names the first workspace's connection. -/
def state : State := fun t =>
  match t with
  | .memberships =>
    Witness.state .memberships ++
      [⟨[("id", "m2"), ("workspace_id", "w2"), ("user_id", "u1"), ("role", "owner"),
         ("created_at", "t0"), ("updated_at", "t0")]⟩]
  | .workspacePrincipals =>
    Witness.state .workspacePrincipals ++
      [⟨[("id", "p2"), ("workspace_id", "w2"), ("kind", "membership"), ("membership_id", "m2"),
         ("activated_at", "t0"), ("created_at", "t0")]⟩]
  | .agents => Witness.state .agents ++ [agent]
  | other => Witness.state other
where
  agent : Row :=
    ⟨[("id", "a2"), ("workspace_id", "w2"), ("name", "Thief"), ("instructions", "x"),
      ("model_connection_id", "c1"), ("permissions", "{}"), ("owner_principal_id", "p2"),
      ("created_at", "t0"), ("updated_at", "t0")]⟩

private theorem forged_reference :
    References catalogue state .agents Witness.siblingKey state.agent Witness.connection := by
  unfold References
  decide +kernel

end Forged

/-- The forged agent is the only fault: without it the state is consistent, with it the
database rejects it, as the theorem predicts. -/
example : consistent catalogue Forged.state = false :=
  forged_cross_tenant_reference_is_rejected catalogue (by decide) Forged.state rfl
    Forged.forged_reference (by decide)

example : consistent catalogue (fun t => if t = .agents then Witness.state .agents else
    Forged.state t) = true := by decide +kernel

/-- Rule 3 of `tenancy.test.ts`: whoever deletes every foreign key over an undeclared `*_id`
column of a table (so that the pairing rule has nothing left to check) fails the
"every reference is declared" gate. -/
@[aw_spec (tier := T3) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#NON_REFERENCE_ID_COLUMNS")]
theorem deleted_reference_is_caught (S : Schema) (decl : List (TableName × String × SqlType))
    (t : TableName) (c : Column) (hc : c ∈ (S t).columns) (hid : isIdColumn c.name = true)
    (hnd : decl.contains (t, c.name, c.type) = false)
    (hfk : (S t).foreignKeys.any (·.columns.contains c.name) = false) :
    idColumnsCovered S decl = false := by
  have hcol : idColumnCovered S decl t c = false := by
    unfold idColumnCovered
    rw [hid, hfk]
    simp only [Bool.not_true, Bool.false_or, Bool.false_eq_true, ite_false]
    exact hnd
  have htab : ((S t).columns.all (idColumnCovered S decl t)) = false := by
    rw [List.all_eq_false]
    exact ⟨c, hc, by simp [hcol]⟩
  have hall : (allTables.all fun u => (S u).columns.all (idColumnCovered S decl u)) = false := by
    rw [List.all_eq_false]
    exact ⟨t, WireEnum.complete t, by simp [htab]⟩
  simp [idColumnsCovered, hall]

/-- `catalogue` with the two foreign keys over `agents.model_connection_id` deleted. -/
def withoutModelConnectionKeys : Schema := fun u =>
  if u = .agents then
    { catalogue .agents with
      foreignKeys := (catalogue .agents).foreignKeys.filter
        fun fk => !fk.columns.contains "model_connection_id" }
  else catalogue u

/-- Deleting the foreign keys over `agents.model_connection_id` keeps the pairing rule green (no
key is left to be unpaired) but fails the declared-reference gate, which is why rule 3 exists. -/
@[aw_spec (tier := T3) (doc := "docs/formal/inventory.md#4-tenant-isolation-predicates")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#NON_REFERENCE_ID_COLUMNS")
  (ts := "packages/core/src/db/schema/tenancy.test.ts#tenantPairingFault")]
theorem deleting_a_reference_passes_pairing_but_not_the_gate :
    pairingComplete withoutModelConnectionKeys = true ∧
      idColumnsCovered withoutModelConnectionKeys nonReferenceIdColumns = false := by
  decide

example : idColumnsCovered withoutModelConnectionKeys nonReferenceIdColumns = false :=
  deleted_reference_is_caught withoutModelConnectionKeys nonReferenceIdColumns .agents
    ⟨"model_connection_id", .uuid, false⟩ (by decide) (by decide) (by decide) (by decide)

private theorem safe_char_is_ascii (c : Char) (h : isSafeValueChar c = true) : c.toNat < 128 := by
  simp only [isSafeValueChar, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq,
    beq_iff_eq] at h
  have hz : c.toNat ≤ 'z'.toNat ∨ c = '-' := by
    rcases h with (⟨_, h⟩ | ⟨_, h⟩) | h
    · exact Or.inl h
    · exact Or.inl (Nat.le_trans h (by decide))
    · exact Or.inr h
  rcases hz with h | rfl
  · have : 'z'.toNat = 122 := rfl
    omega
  · decide

private theorem ascii_safe_chars : ∀ n, n < 128 → isSafeValueChar (Char.ofNat n) = true →
    Char.ofNat n ∈ "abcdefghijklmnopqrstuvwxyz0123456789-".toList := by
  decide

private theorem safe_char_mem (c : Char) (h : isSafeValueChar c = true) :
    c ∈ "abcdefghijklmnopqrstuvwxyz0123456789-".toList := by
  have := ascii_safe_chars c.toNat (safe_char_is_ascii c h)
  rw [Char.ofNat_toNat] at this
  exact this h

/-- Every character of a value the `oneOf` gate accepts is one of the 37 characters
`a`–`z`, `0`–`9` and `-`, so inlining it between quotes cannot close the literal or inject SQL. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/schema/one-of.ts#SAFE_VALUE")
  (ts := "packages/core/src/db/schema/one-of.ts#renderValueList")]
theorem safe_value_has_only_slug_characters (v : String) (h : isSafeValue v = true) :
    ∀ c ∈ v.toList, c ∈ "abcdefghijklmnopqrstuvwxyz0123456789-".toList := by
  unfold isSafeValue at h
  cases hv : v.toList with
  | nil => intro c hc; simp at hc
  | cons c rest =>
    rw [hv] at h
    simp only [Bool.and_eq_true, decide_eq_true_eq] at h
    intro x hx
    simp only [List.mem_cons] at hx
    rcases hx with rfl | hx
    · apply safe_char_mem
      simp only [isSafeValueChar, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq]
      exact Or.inl (Or.inl h.1.1.1.1)
    · exact safe_char_mem x (List.all_eq_true.mp h.1.1.1.2 x hx)

example : ∀ c ∈ "read-write".toList, c ∈ "abcdefghijklmnopqrstuvwxyz0123456789-".toList :=
  safe_value_has_only_slug_characters "read-write" (by decide)

/-- A value with an upper-case letter anywhere, not only first, is refused by the gate. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/schema/one-of.ts#SAFE_VALUE")]
theorem upper_case_value_is_refused (v : String) (c : Char) (hc : c ∈ v.toList)
    (hA : 'A' ≤ c) (hZ : c ≤ 'Z') : isSafeValue v = false := by
  cases h : isSafeValue v with
  | false => rfl
  | true =>
    have hm := safe_value_has_only_slug_characters v h c hc
    have hlt : c.toNat < 128 := Nat.lt_of_le_of_lt hZ (by decide)
    have key : ∀ n, n < 128 → 'A'.toNat ≤ n → n ≤ 'Z'.toNat →
        Char.ofNat n ∉ "abcdefghijklmnopqrstuvwxyz0123456789-".toList := by
      decide
    have := key c.toNat hlt hA hZ
    rw [Char.ofNat_toNat] at this
    exact absurd hm this

example : isSafeValue "aB" = false :=
  upper_case_value_is_refused "aB" 'B' (by decide) (by decide) (by decide)

example : isSafeValue "abC1" = false ∧ isSafeValue "a-B" = false :=
  ⟨upper_case_value_is_refused "abC1" 'C' (by decide) (by decide) (by decide),
    upper_case_value_is_refused "a-B" 'B' (by decide) (by decide) (by decide)⟩

/-- Any value list containing a quote is refused by `renderValueList`, so no attacker-chosen value
reaches the DDL text with a quote in it. -/
@[aw_spec (tier := T3) (ts := "packages/core/src/db/schema/one-of.ts#renderValueList")]
theorem quoted_value_is_refused (vs : List String) (v : String) (hv : v ∈ vs)
    (hq : '\'' ∈ v.toList) : renderValueList? vs = none := by
  unfold renderValueList?
  have hunsafe : isSafeValue v = false := by
    cases h : isSafeValue v with
    | false => rfl
    | true =>
      have := safe_value_has_only_slug_characters v h '\'' hq
      exact absurd this (by decide)
  have : vs.all isSafeValue = false := by
    cases hall : vs.all isSafeValue with
    | false => rfl
    | true => rw [List.all_eq_true.mp hall v hv] at hunsafe; cases hunsafe
  simp [this]

example : renderValueList? ["read", "x'); drop table users; --"] = none :=
  quoted_value_is_refused _ "x'); drop table users; --" (by simp) (by decide)

end AgentWorkspace.Theorems.Adversarial.ErCore
