import Tools.Environment

/-!
`lake exe imports [Module …]` — the model's dependency direction, read from the compiled
module headers
(ADR-0030: import edges are resolved by the compiler, not matched by regex):

`Prelude → Contracts → Concepts/Er → Authz → Behaviour/Lifecycle/Events → Sdk/Cli → Theorems`

`Trace` is imported by everything and imports nothing of the model. `Contracts` sees only
`Prelude`; `Sdk` and `Cli` see only `Prelude`, `Contracts` and `Events`; no module outside
`Theorems` (except the root `AgentWorkspace`) imports `Theorems`.
-/

open Lean

/-- The layer of a model module, by its second name component. -/
def layerOf? (module : Name) : Option String :=
  match module.components with
  | [`AgentWorkspace] => some "Root"
  | `AgentWorkspace :: dir :: _ => some dir.toString
  | _ => none

def rank : String → Option Nat
  | "Trace" => some 0 | "Prelude" => some 1 | "Contracts" => some 2
  | "Concepts" | "Er" => some 3 | "Authz" => some 4
  | "Behaviour" | "Lifecycle" | "Events" => some 5
  | "Sdk" | "Cli" => some 6 | "Theorems" => some 7 | "Root" => some 8
  | _ => none

/-- Whether a module in layer `src` may import one in layer `dst`. -/
def allowed (src dst : String) : Bool :=
  match rank src, rank dst with
  | some s, some d =>
    if src == "Trace" then dst == "Trace"
    else if src == "Sdk" || src == "Cli" then
      ["Trace", "Prelude", "Contracts", "Events", "Sdk", "Cli"].contains dst
    else if src == "Contracts" then
      ["Trace", "Prelude", "Contracts"].contains dst
    else if dst == "Theorems" then src == "Theorems" || src == "Root"
    else d ≤ s
  | _, _ => false

def main (args : List String) : IO UInt32 := do
  let env ← Tools.loadModules (Tools.moduleArgs args)
  let mut failures : Array String := #[]
  let mut edges := 0
  for (module, data) in env.header.moduleNames.zip env.header.moduleData do
    let some src := layerOf? module | continue
    if (rank src).isNone then
      failures := failures.push s!"{module}: unknown layer {src}"
      continue
    for imp in data.imports do
      let some dst := layerOf? imp.module | continue
      edges := edges + 1
      unless allowed src dst do
        failures := failures.push s!"{module} ({src}) must not import {imp.module} ({dst})"
  if failures.isEmpty then
    IO.println s!"imports: {edges} model import edges follow the layer direction"
    return 0
  for f in failures do IO.eprintln s!"imports: {f}"
  return 1
