import Tools.Environment

/-!
`lake exe catalogue [out.json [Module …]]` — the machine-readable catalogue of every `@[aw_spec]`
declaration: name, module, kind, tier, citations, docstring and statement. The Node renderer
(`scripts/formal/generate.mjs`) turns it into `docs/formal/catalogue.md` and
`docs/formal/traceability.md`.
-/

open Lean AgentWorkspace.Trace

def kindOf : ConstantInfo → String
  | .thmInfo _ => "theorem"
  | .defnInfo _ => "def"
  | .inductInfo _ => "inductive"
  | .opaqueInfo _ => "opaque"
  | .axiomInfo _ => "axiom"
  | .ctorInfo _ => "constructor"
  | _ => "other"

/-- The pretty-printed type on one line, whitespace collapsed. -/
def statementOf (info : ConstantInfo) : CoreM String := do
  let fmt ← (Meta.ppExpr info.type).run'
  let words := ((toString fmt).replace "\n" " ").splitOn " " |>.filter (· ≠ "")
  return " ".intercalate words

def main (args : List String) : IO UInt32 := do
  let out := args.headD "-"
  let env ← Tools.loadModules (Tools.moduleArgs args.tail)
  let entries := specEntries env
  let mut rows : Array Json := #[]
  for e in entries do
    let some info := env.find? e.decl
      | throw <| IO.userError s!"@[aw_spec] entry for unknown declaration {e.decl}"
    let module := (Tools.moduleOf? env e.decl).getD .anonymous
    let docstring ← Tools.runCore env (return (← findDocString? env e.decl).getD "")
    let statement ← Tools.runCore env
      (withOptions (fun o => o.set `format.width (1000 : Nat)) (statementOf info))
    rows := rows.push <| Json.mkObj [
      ("name", toJson e.decl.toString),
      ("module", toJson module.toString),
      ("kind", toJson (kindOf info)),
      ("tier", match e.tier with | some t => toJson t | none => Json.null),
      ("doc", toJson e.docs),
      ("ts", toJson e.ts),
      ("docstring", toJson docstring.trimAscii.toString),
      ("statement", toJson statement)]
  Tools.emit out ((Json.mkObj [("entries", Json.arr rows)]).pretty 120 ++ "\n")
  IO.eprintln s!"catalogue: {rows.size} entries"
  return 0
