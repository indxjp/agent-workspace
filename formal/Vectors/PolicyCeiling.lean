import AgentWorkspace.Theorems.Refinement.PolicyCeiling
import Vectors.Common

/-!
The `policy-ceiling` family: `violations` and `meet` over the fixtures of
`Theorems/Refinement/PolicyCeiling.lean`, replayed against
`packages/contracts/src/policy-ceiling.ts` (`policyWidenings`, `meetPolicyCeiling`) by
`tests/formal/policy-ceiling.test.ts`.

The configuration is written as `EffectivePolicyConfiguration` and the ceiling as a
`ProjectPolicy`: a capped switch is `false`, and an absent key is left out.
-/

namespace Vectors.PolicyCeiling

open Lean AgentWorkspace.Concepts.Agent AgentWorkspace.Concepts.PolicyCeiling
  AgentWorkspace.Theorems.Refinement.PolicyCeiling

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".PolicyCeiling." ++ name

private def natJson : Option Nat → Json
  | some n => toJson n
  | none => Json.null

private def configJson (e : Config) : Json :=
  Json.mkObj
    [("permissions",
       Json.mkObj
         [("readFiles", e.permissions.readFiles), ("writeFiles", e.permissions.writeFiles),
          ("runCommands", e.permissions.runCommands),
          ("unrestrictedNetwork", e.permissions.unrestrictedNetwork)]),
     ("limits", Json.mkObj [("maxTurns", natJson e.maxTurns), ("maxBudgetUsd", natJson e.maxBudget)]),
     ("engine", e.engine),
     ("model", match e.model with
       | some m => Json.str m
       | none => Json.null),
     ("tools", toJson e.tools)]

private def ceilingJson : Option Ceiling → Json
  | none => Json.null
  | some c =>
    let caps := permissionKeys.filter c.caps.contains
    let limits := (c.maxTurns.toList.map fun n => ("maxTurns", toJson n)) ++
      (c.maxBudget.toList.map fun n => ("maxBudgetUsd", toJson n))
    Json.mkObj <|
      (if caps.isEmpty then [] else [("permissions", Json.mkObj (caps.map (·, Json.bool false)))]) ++
      (if limits.isEmpty then [] else [("limits", Json.mkObj limits)]) ++
      (c.engines.toList.map fun l => ("engines", toJson l)) ++
      (c.models.toList.map fun l => ("models", toJson l)) ++
      (c.tools.toList.map fun l => ("tools", toJson l)) ++
      (c.minEvalScore.toList.map fun n => ("promotion", Json.mkObj [("minEvalScore", toJson n)]))

/-- The fixture's own `decide` theorems, when it has them. -/
private def pinned : String → List String
  | "all-fields" => [t "Refinement" "all_fields_violations", t "Refinement" "all_fields_meet"]
  | "null-limit" => [t "Refinement" "null_limit_never_widens"]
  | _ => []

private def input (f : Fixture) : Json :=
  Json.mkObj [("effective", configJson f.config), ("ceiling", ceilingJson f.ceiling)]

def violationsVectors : List Vector :=
  fixtures.map fun f =>
    { id := f.id, input := input f,
      expected := Json.mkObj [("widenings", toJson (violations f.config f.ceiling))],
      witnesses :=
        [t "Normative" "policy_cannot_widen_iff_within",
         t "Normative" "violations_name_each_field_once_in_key_order",
         t "Refinement" "fixtures_agree"] ++ pinned f.id }

def meetVectors : List Vector :=
  fixtures.map fun f =>
    { id := f.id, input := input f,
      expected := Json.mkObj [("meet", configJson (meet f.config f.ceiling))],
      witnesses :=
        [t "Invariants" "meet_le_ceiling", t "Invariants" "meet_le_input",
         t "Refinement" "fixtures_agree"] ++ pinned f.id }

def files : List (String × Json) :=
  [("violations.json",
     file "policy-ceiling" "policyWidenings: where a configuration asks for more than the ceiling"
       violationsVectors),
   ("meet.json",
     file "policy-ceiling" "meetPolicyCeiling: the configuration at or below both" meetVectors)]

end Vectors.PolicyCeiling
