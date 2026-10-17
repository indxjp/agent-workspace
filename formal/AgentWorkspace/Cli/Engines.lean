import AgentWorkspace.Sdk.Engines

/-!
# `aw engines list` — the same projection, rendered

The CLI adds no filter of its own: `aw engines list` is `engines.list()` printed. The two things
it *does* decide are modelled, because both are places a projection could quietly stop being one:

* **which rows are printed.** Every mode prints every descriptor the SDK returned, in order. The
  table's `columns` choose which *fields* a human sees; they never choose rows, which is why
  `--json` and the default table are the same list.
* **what `--engine` resolves to.** `aw agents create|update --engine <id>` asks the catalogue
  first and refuses an id it does not find, so an engine this deployment does not register is a
  refusal with nothing created rather than an agent left on an engine nobody asked for.
-/

namespace AgentWorkspace.Cli.Engines

open AgentWorkspace AgentWorkspace.Sdk.Engines

/-- The output modes `aw` selects between for a listing. -/
inductive OutputMode where
  | human | json | jsonl
  deriving DecidableEq, Repr, Inhabited

def outputModes : List OutputMode := [.human, .json, .jsonl]

/-- The table columns `engines list` prints. `capabilities` is absent on purpose: ten fields in
one cell is JSON nobody can read across, and `--json` prints the whole descriptor. -/
@[aw_spec (ts := "packages/aw/src/commands/engines.ts#engineCommands")]
def columns : List String := ["id", "displayName", "version", "installed"]

/-- The rows one mode prints. Every mode prints every descriptor, in order: a mode chooses the
rendering, never the result set. -/
@[aw_spec (ts := "packages/aw/src/output.ts#writeResult")]
def rows (_mode : OutputMode) (engines : List Descriptor) : List Descriptor := engines

/-- `aw engines list`: the SDK's answer, unchanged, or nothing when the request was refused. -/
@[aw_spec (ts := "packages/aw/src/commands/engines.ts#engineCommands")]
def listCommand (mode : OutputMode) (registry : List Descriptor) : Option (List Descriptor) :=
  (list registry).map (rows mode)

/-- What `--engine <id>` resolves to, against the catalogue the CLI just read. -/
inductive EngineFlag where
  /-- The flag was not given: the policy arm stays whatever the server derives. -/
  | absent
  /-- The catalogue names this id; it becomes the policy arm. -/
  | resolved (id : String)
  /-- `unsupported_engine`: refused before anything is created or changed. -/
  | refused (code : String)
  deriving DecidableEq, Repr, Inhabited

/-- `resolveEngineFlag`. The catalogue is the authority, not `ENGINE_IDS`: a deployment installs
some of what the contracts publish, and naming an engine it has not installed is the mistake this
refusal is about. So the flag resolves only to a descriptor with this id **and** `installed`; one
the catalogue lists as not installed is refused like one it does not list at all. -/
@[aw_spec (ts := "packages/aw/src/commands/agents.ts#agentCommands")]
def resolveEngineFlag (registry : List Descriptor) : Option String → EngineFlag
  | Option.none => .absent
  | some requested =>
    if registry.any (fun d => d.id == requested && d.installed) then .resolved requested
    else .refused "unsupported_engine"

end AgentWorkspace.Cli.Engines
