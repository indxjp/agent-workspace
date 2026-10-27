import AgentWorkspace.Theorems.WellFormed.ContractsRuns
import AgentWorkspace.Concepts.Usage

namespace AgentWorkspace.Theorems.Refinement.ContractsRuns

open AgentWorkspace AgentWorkspace.Contracts.Runs

/-- A decimal-only amount is the documented target. It narrows the actual `min(1)` schema. -/
def decimalCostTarget (j : JValue) : Bool :=
  runCost j && match j with
    | .obj fs => (JValue.lookup "amount" fs).any fun v =>
      match v with
      | .str s => Concepts.Usage.isDecimal s
      | _ => false
    | _ => false

/-- A decimal-only cost amount narrows the current permissive cost schema. -/
@[aw_spec (tier := T4) (ts := "packages/contracts/src/runs.ts#RunCostSchema")]
theorem target_refines_current (j : JValue) :
    decimalCostTarget j = true → runCost j = true := by
  intro h
  cases hc : runCost j with
  | true => rfl
  | false => simp [decimalCostTarget, hc] at h

/-- The current cost schema accepts a concrete non-decimal amount. -/
@[aw_spec (tier := T4) (ts := "packages/contracts/src/runs.ts#RunCostSchema")]
theorem current_accepts_non_decimal :
    runCost (.obj [("amount", .str "not-money"), ("currency", .str "X"),
      ("priceTableVersion", .null)]) = true ∧
    decimalCostTarget (.obj [("amount", .str "not-money"), ("currency", .str "X"),
      ("priceTableVersion", .null)]) = false := by decide +kernel

end AgentWorkspace.Theorems.Refinement.ContractsRuns
