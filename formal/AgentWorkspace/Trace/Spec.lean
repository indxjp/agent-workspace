import Lean

/-!
# Traceability attribute

`@[aw_spec (tier := T1) (doc := "docs/…#anchor") (ts := "path#symbol")]` records which document
sentence and which TypeScript symbol a Lean declaration formalises, and — for theorems — which
tier of the taxonomy (docs/formal/00-orchestrator-prompt.md §6) it belongs to. The catalogue
extractor (`lake exe catalogue`) reads these entries; it never infers a citation from a name.
-/

namespace AgentWorkspace.Trace

open Lean Elab

/-- The theorem tiers: well-formedness, normative, invariant, adversarial, refinement, meta. -/
inductive Tier where
  | T0 | T1 | T2 | T3 | T4 | T5
  deriving DecidableEq, Repr, Inhabited, ToJson, FromJson

def Tier.ofName? : Name → Option Tier
  | `T0 => some .T0 | `T1 => some .T1 | `T2 => some .T2
  | `T3 => some .T3 | `T4 => some .T4 | `T5 => some .T5
  | _ => none

/-- One `@[aw_spec]` application. -/
structure SpecEntry where
  decl : Name
  tier : Option Tier
  docs : Array String
  ts : Array String
  deriving Inhabited, Repr

initialize specExtension : SimplePersistentEnvExtension SpecEntry (Array SpecEntry) ←
  registerSimplePersistentEnvExtension {
    addEntryFn := Array.push
    addImportedFn := fun arrays => arrays.foldl (· ++ ·) #[]
  }

declare_syntax_cat specArg
syntax "(" &"tier" " := " ident ")" : specArg
syntax "(" &"doc" " := " str ")" : specArg
syntax "(" &"ts" " := " str ")" : specArg

/-- Records traceability metadata for a declaration; see the module docstring. -/
syntax (name := awSpec) "aw_spec" (ppSpace specArg)* : attr

private def parseSpecArgs (decl : Name) (args : Array Syntax) : AttrM SpecEntry := do
  let mut entry : SpecEntry := { decl, tier := none, docs := #[], ts := #[] }
  for arg in args do
    match arg with
    | `(specArg| (tier := $t:ident)) =>
      if entry.tier.isSome then throwErrorAt arg "@[aw_spec]: tier given twice"
      match Tier.ofName? t.getId with
      | some tier => entry := { entry with tier := some tier }
      | none => throwErrorAt t "@[aw_spec]: tier must be one of T0 … T5"
    | `(specArg| (doc := $s:str)) =>
      let cite := s.getString
      unless cite.startsWith "docs/" || cite.endsWith ".md" || (cite.splitOn ".md#").length == 2 do
        throwErrorAt s "@[aw_spec]: doc must be a repository-relative document path"
      entry := { entry with docs := entry.docs.push cite }
    | `(specArg| (ts := $s:str)) =>
      entry := { entry with ts := entry.ts.push s.getString }
    | _ => throwErrorAt arg "@[aw_spec]: unrecognised argument"
  return entry

initialize registerBuiltinAttribute {
  name := `awSpec
  descr := "traceability: document anchor, TypeScript symbol and theorem tier"
  applicationTime := .afterTypeChecking
  add := fun decl stx kind => do
    unless kind == .global do throwError "@[aw_spec] must be global"
    let entry ← parseSpecArgs decl stx[1].getArgs
    if entry.docs.isEmpty && entry.ts.isEmpty then
      throwError "@[aw_spec] needs at least one doc or ts citation"
    modifyEnv (specExtension.addEntry · entry)
}

/-- Every `@[aw_spec]` entry visible in the environment, in a deterministic order. -/
def specEntries (env : Environment) : Array SpecEntry :=
  let imported := specExtension.getState env
  let local_ := (specExtension.getEntries env).toArray
  (imported ++ local_).qsort (fun a b => Name.lt a.decl b.decl)

end AgentWorkspace.Trace
