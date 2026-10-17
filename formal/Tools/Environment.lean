import Lean
import AgentWorkspace.Trace.Spec

/-!
Shared loading for the `lake exe` tools: import the whole model and enumerate its own
declarations (those defined in an `AgentWorkspace.*` module), in name order.
-/

namespace Tools

open Lean

/-- The module a declaration was defined in, if it was imported. -/
def moduleOf? (env : Environment) (decl : Name) : Option Name := do
  let idx ← env.getModuleIdxFor? decl
  env.header.moduleNames[idx.toNat]?

/-- Whether `module` belongs to the model (`AgentWorkspace` or below it). -/
def isModelModule (module : Name) : Bool :=
  (`AgentWorkspace).isPrefixOf module

/-- Load the environment of the given modules (default: the root module `AgentWorkspace`).
A unit checks its own modules before they are imported by the root by naming them. -/
unsafe def loadModulesUnsafe (modules : Array Name) : IO Environment := do
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let modules := if modules.isEmpty then #[`AgentWorkspace] else modules
  importModules (modules.map fun m => { module := m }) {} (trustLevel := 1024) (loadExts := true)

@[implemented_by loadModulesUnsafe] opaque loadModules : Array Name → IO Environment

/-- Parse module names given on the command line (`AgentWorkspace.Contracts.Agents`). -/
def moduleArgs (args : List String) : Array Name :=
  (args.filter (fun a => !a.startsWith "-")).toArray.map String.toName

/-- Run a `CoreM` action against a loaded environment. -/
def runCore {α : Type} (env : Environment) (act : CoreM α) : IO α := do
  let ctx : Core.Context := {
    fileName := "<formal-tool>", fileMap := default, options := {},
    maxHeartbeats := 0 }
  let (a, _) ← act.toIO ctx { env }
  return a

/-- Every declaration defined in a model module, excluding compiler-generated auxiliaries. -/
def modelDeclarations (env : Environment) : Array (Name × Name × ConstantInfo) := Id.run do
  let mut out := #[]
  for (name, info) in env.constants.map₁.toList do
    if name.isInternalDetail then continue
    match moduleOf? env name with
    | some module => if isModelModule module then out := out.push (name, module, info)
    | none => pure ()
  return out.qsort (fun a b => Name.lt a.1 b.1)

/-- Write `contents` to `path`, creating parent directories; `-` means standard output. -/
def emit (path : System.FilePath) (contents : String) : IO Unit := do
  if path.toString == "-" then
    IO.print contents
  else
    if let some parent := path.parent then IO.FS.createDirAll parent
    IO.FS.writeFile path contents

end Tools
