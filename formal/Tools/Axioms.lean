import Tools.Environment

/-!
`lake exe axioms [Module …]` — the soundness audit of the root module, or of the named ones.
It fails when

* any model declaration depends on an axiom other than `propext`, `Classical.choice` and
  `Quot.sound` (this catches `sorry` as `sorryAx` and `native_decide` as `Lean.ofReduceBool`);
* a model module declares an `axiom` of its own;
* a public theorem in an `AgentWorkspace.Theorems.*` module has no `@[aw_spec]` entry, no tier,
  a tier that disagrees with its directory, or no docstring;
* a tier is attached to something that is not a theorem.
-/

open Lean AgentWorkspace.Trace

def allowedAxioms : List Name := [``propext, ``Classical.choice, ``Quot.sound]

/-- The tier a `Theorems/<Dir>/…` module holds. -/
def tierOfModule? (module : Name) : Option Tier :=
  match module.components with
  | `AgentWorkspace :: `Theorems :: dir :: _ =>
    if dir == `WellFormed then some .T0
    else if dir == `Normative then some .T1
    else if dir == `Invariants then some .T2
    else if dir == `Adversarial then some .T3
    else if dir == `Refinement then some .T4
    else if dir == `Meta then some .T5
    else none
  | _ => none

/-- The failures for one theorem that lives in a `Theorems` module. -/
def theoremFailures (env : Environment) (specs : Array SpecEntry) (name module : Name)
    (tier : Tier) : IO (Array String) := do
  let mut failures := #[]
  match specs.find? (·.decl == name) with
  | none => failures := failures.push s!"{name}: public theorem in {module} has no @[aw_spec]"
  | some e =>
    match e.tier with
    | none => failures := failures.push s!"{name}: @[aw_spec] on a theorem needs a tier"
    | some t =>
      if t != tier then
        failures := failures.push s!"{name}: tier {repr t} but {module} holds {repr tier}"
  if (← findDocString? env name).isNone then
    failures := failures.push s!"{name}: theorem has no docstring"
  return failures

def main (args : List String) : IO UInt32 := do
  let env ← Tools.loadModules (Tools.moduleArgs args)
  let decls := Tools.modelDeclarations env
  let specs := specEntries env
  let mut failures : Array String := #[]
  let mut checked := 0
  for (name, module, info) in decls do
    if let .axiomInfo _ := info then
      failures := failures.push s!"{name}: model modules must not declare axioms"
    let axioms ← Tools.runCore env (collectAxioms name)
    checked := checked + 1
    for ax in axioms do
      unless allowedAxioms.contains ax do
        failures := failures.push s!"{name} ({module}): depends on axiom {ax}"
    if let .thmInfo _ := info then
      if let some tier := tierOfModule? module then
        unless isPrivateName name do
          failures := failures ++ (← theoremFailures env specs name module tier)
  for e in specs do
    if e.tier.isSome then
      match env.find? e.decl with
      | some (.thmInfo _) => pure ()
      | _ => failures := failures.push s!"{e.decl}: only theorems carry a tier"
  if failures.isEmpty then
    IO.println s!"axioms: {checked} declarations audited; only propext, Classical.choice, Quot.sound"
    return 0
  for f in failures do IO.eprintln s!"axioms: {f}"
  IO.eprintln s!"axioms: {failures.size} failure(s)"
  return 1
