import AgentWorkspace.Trace.Spec

/-!
# One runtime image per engine: the `engine → image` map (ENG-07, #306)

ADR-0073 packages each engine in its own runtime image and lets a deployment choose which engines
it offers by which images it configures. This module models the four observable parts of that
decision, as pure functions over explicit values:

* **the map and its parsing** — `packages/runtime/src/engine-images.ts`'s `parseEngineImageMap`
  and `readEngineImageMap`, the control plane's `readConfiguredEngineImages`
  (`apps/web/server/engines/images.ts`), which checks shape only, and the runner manager's
  `engineImagesFor` (`apps/runner/src/manager-start.ts`), which also requires digests in
  production;
* **`installed`** — `GET /api/engines` reports an engine installed exactly when the map holds an
  image for it (`apps/web/server/engines/registry.ts`'s `registeredEngines`);
* **driver dispatch** — every image-taking driver resolves the image of `config.engine` before it
  creates anything (`requireEngineImage`), and the ACA session pool, which holds one image, refuses
  any other engine (ADR-0073 D6);
* **the run route** — a run for an engine with no image is `422 engine_not_installed` before a run
  row exists.

## What the model takes as given

*What an image contains* is not something Lean can observe. The model gives every image reference
an engine **label** (`io.agent-workspace.engine`) through a function `label`, and the dispatch
theorems take as an explicit hypothesis that the configured map is **label-honest**: the image
configured under engine `e` carries label `e`. That the label describes the bytes is enforced by the
image build (`scripts/engine-images.mjs --verify-label` inside `runtime.Dockerfile`), and is listed
under the PR's declared gaps.

*Whether a string is an image reference* is a parameter `shaped` of the parser rather than a model
of the TypeScript regular expression: the theorems hold for every shape predicate, and the vectors
use `charShaped`, a character-class check whose answer agrees with the regular expression on every
value the vectors carry.

## Why a fault list and an accepted map are two folds

`parseEngineImageMap` makes one pass that both collects the faulting keys and builds the map. The
model splits that pass into {@link faultFold}, which sees only each entry's key and its value's
*verdict*, and {@link acceptFold}, which builds the map. The split is what makes ADR-0073 D5 — the
refusal names keys and never a value — a statement about the definition rather than about a
string: the fault record is computed from a list in which the values have already been replaced by
their verdicts.
-/

namespace AgentWorkspace.Behaviour.EngineImages

/-- The configured map, as an association list from engine id to image reference. -/
@[aw_spec (ts := "packages/runtime/src/engine-images.ts#EngineImageMap")]
abbrev EngineImageMap := List (String × String)

/-- The image configured for `engine`, if any: the first entry with that key. -/
def lookup (images : EngineImageMap) (engine : String) : Option String :=
  (images.find? fun entry => entry.1 == engine).map (·.2)

/-- An engine has an image exactly when some entry carries its key. -/
theorem lookup_isSome_iff (images : EngineImageMap) (engine : String) :
    (lookup images engine).isSome = true ↔ ∃ image, (engine, image) ∈ images := by
  unfold lookup
  rw [Option.isSome_map, List.find?_isSome]
  constructor
  · rintro ⟨⟨key, image⟩, hmem, hkey⟩
    simp only [beq_iff_eq] at hkey
    subst hkey
    exact ⟨image, hmem⟩
  · rintro ⟨image, hmem⟩
    exact ⟨(engine, image), hmem, by simp⟩

/-- The image {@link lookup} answers is an entry of the map under that engine. -/
theorem lookup_some_mem (images : EngineImageMap) (engine image : String)
    (h : lookup images engine = some image) : (engine, image) ∈ images := by
  unfold lookup at h
  rcases hf : images.find? (fun entry => entry.1 == engine) with _ | ⟨key, value⟩
  · simp [hf] at h
  · simp only [hf, Option.map_some, Option.some.injEq] at h
    have hmem := List.mem_of_find?_eq_some hf
    have hkey := List.find?_some hf
    simp only [beq_iff_eq] at hkey
    subst hkey
    subst h
    exact hmem

/-- ENG-02's `installed`, since ENG-07: the map holds an image for the engine. -/
@[aw_spec (ts := "packages/runtime/src/engine-images.ts#engineImageInstalled")]
def installed (images : EngineImageMap) (engine : String) : Bool :=
  (lookup images engine).isSome

/-! ## Parsing -/

/-- What the parser concludes about one configured value. -/
inductive ValueVerdict where
  | ok
  | malformed
  | unpinned
  deriving DecidableEq, Repr, Inhabited

/-- The characters an image reference is built from. -/
def referenceChar (c : Char) : Bool :=
  c.isAlphanum || c == '.' || c == '_' || c == '-' || c == '/' || c == ':' || c == '@'

/-- The shape predicate the vectors use: non-empty, starting with a letter or digit, and built
only from {@link referenceChar}. -/
def charShaped (value : String) : Bool :=
  match value.toList with
  | [] => false
  | c :: rest => c.isAlphanum && rest.all referenceChar

private def lowerHex (c : Char) : Bool :=
  c.isDigit || ('a' ≤ c && c ≤ 'f')

/-- The value ends in `@sha256:` and 64 lower-case hexadecimal digits. -/
def digestPinned (value : String) : Bool :=
  let cs := value.toList
  cs.length ≥ 72 &&
    (cs.drop (cs.length - 72)).take 8 == "@sha256:".toList &&
    (cs.drop (cs.length - 64)).all lowerHex

/-- One value's verdict: malformed before unpinned, and unpinned only when digests are required. -/
def classify (shaped : String → Bool) (requireDigest : Bool) (value : String) : ValueVerdict :=
  if !shaped value then .malformed
  else if requireDigest && !digestPinned value then .unpinned
  else .ok

/-- The keys at fault, by kind — `EngineImageConfigurationError`'s `keys`, before concatenation.
Every field is a list of **keys**; there is nowhere in this record to put a value. -/
structure Faults where
  unknown : List String := []
  malformed : List String := []
  unpinned : List String := []
  duplicates : List String := []
  deriving DecidableEq, Repr, Inhabited

/-- The keys in the order the refusal names them: unknown, malformed, unpinned, duplicate. -/
def Faults.keys (f : Faults) : List String :=
  f.unknown ++ f.malformed ++ f.unpinned ++ f.duplicates

/-- The fault pass over `(key, verdict)` pairs. `accepted` is the keys already accepted: a later
entry with an accepted key is a duplicate, exactly as `map.has(engineId)` decides it. -/
def faultFold (known : List String) :
    List String → Faults → List (String × ValueVerdict) → Faults
  | _, f, [] => f
  | accepted, f, (key, verdict) :: rest =>
    if accepted.contains key then
      faultFold known accepted { f with duplicates := f.duplicates ++ [key] } rest
    else if !known.contains key then
      faultFold known accepted { f with unknown := f.unknown ++ [key] } rest
    else
      match verdict with
      | .ok => faultFold known (accepted ++ [key]) f rest
      | .malformed => faultFold known accepted { f with malformed := f.malformed ++ [key] } rest
      | .unpinned => faultFold known accepted { f with unpinned := f.unpinned ++ [key] } rest

/-- `faultFold`'s equation lemma, generated here beside the definition rather than in whichever
theorem module first unfolds it. -/
private theorem faultFold_nil (known accepted : List String) (f : Faults) :
    faultFold known accepted f [] = f := by
  rw [faultFold.eq_def]

/-- The accepting pass: the entries the fault pass accepts, in order. -/
def acceptFold (known : List String) (verdict : String → ValueVerdict) :
    EngineImageMap → EngineImageMap → EngineImageMap
  | accepted, [] => accepted
  | accepted, (key, value) :: rest =>
    if accepted.any (fun e => e.1 == key) || !known.contains key || verdict value != .ok then
      acceptFold known verdict accepted rest
    else acceptFold known verdict (accepted ++ [(key, value)]) rest

/-- Each entry with its value replaced by the value's verdict. -/
def verdicts (verdict : String → ValueVerdict) (entries : EngineImageMap) :
    List (String × ValueVerdict) :=
  entries.map fun entry => (entry.1, verdict entry.2)

/-- The parser's answer: the whole map, or the faults — never a partial map. -/
inductive Parsed where
  | ok (images : EngineImageMap)
  | error (faults : Faults)
  deriving DecidableEq, Repr, Inhabited

/-- `parseEngineImageMap`. -/
@[aw_spec (ts := "packages/runtime/src/engine-images.ts#parseEngineImageMap")]
def parse (known : List String) (shaped : String → Bool) (requireDigest : Bool)
    (entries : EngineImageMap) : Parsed :=
  let verdict := classify shaped requireDigest
  let faults := faultFold known [] {} (verdicts verdict entries)
  if faults.keys.isEmpty then .ok (acceptFold known verdict [] entries) else .error faults

/-! ## Reading an environment -/

/-- `engineImageEnvName`: `AGENT_WORKSPACE_RUNTIME_IMAGE_` and the id upper-cased, `-` as `_`. -/
@[aw_spec (ts := "packages/runtime/src/engine-images.ts#engineImageEnvName")]
def envName (engine : String) : String :=
  "AGENT_WORKSPACE_RUNTIME_IMAGE_" ++ engine.map fun c => if c == '-' then '_' else c.toUpper

/-- An environment, as the variables it sets. -/
abbrev Env := List (String × String)

/-- One variable's value. -/
def Env.get (env : Env) (name : String) : Option String :=
  (env.find? fun entry => entry.1 == name).map (·.2)

/-- The value one engine is configured with: its own variable, or — for `claude-agent-sdk` only —
the pre-ENG-07 `RUNTIME_IMAGE`. An empty value is no value. -/
def envEntry (env : Env) (engine : String) : Option (String × String) :=
  let own := env.get (envName engine)
  let legacy := if engine == "claude-agent-sdk" then env.get "RUNTIME_IMAGE" else none
  match own.orElse fun _ => legacy with
  | some value => if value.isEmpty then none else some (engine, value)
  | none => none

/-- `readEngineImageMap`: read only the published engines' variables, then parse. -/
@[aw_spec (ts := "packages/runtime/src/engine-images.ts#readEngineImageMap")]
def readEnv (known : List String) (shaped : String → Bool) (requireDigest : Bool) (env : Env) :
    Parsed :=
  parse known shaped requireDigest (known.filterMap (envEntry env))

/-- The development default: `claude-agent-sdk` in the image `compose.yaml` builds. -/
def developmentImages : EngineImageMap := [("claude-agent-sdk", "agent-workspace/runtime:dev")]

/-- `readConfiguredEngineImages`: the control plane checks each value's shape and **never its
digest**, in production or out — it never starts a container and reads the map only to answer
`installed` and the `422` (ADR-0073 D5). Outside production an environment that configures no
engine at all gets {@link developmentImages}. -/
@[aw_spec (ts := "apps/web/server/engines/images.ts#readConfiguredEngineImages")]
def controlPlane (known : List String) (shaped : String → Bool) (env : Env) : Parsed :=
  let production := env.get "NODE_ENV" == some "production"
  match readEnv known shaped false env with
  | .ok [] => if production then .ok [] else .ok developmentImages
  | other => other

/-- `engineImagesFor`: the runner manager, which starts sandboxes from the map, is where the digest
rule lives — digests are required in production — and a manager with no image at all refuses to
start, with a refusal that names no key. -/
@[aw_spec (ts := "apps/runner/src/manager-start.ts#engineImagesFor")]
def runnerManager (known : List String) (shaped : String → Bool) (env : Env) : Parsed :=
  match readEnv known shaped (env.get "NODE_ENV" == some "production") env with
  | .ok [] => .error {}
  | other => other

/-! ## The catalogue -/

/-- A registered engine, in the one field this family observes: its id. -/
structure Registered where
  id : String
  deriving DecidableEq, Repr, Inhabited

/-- One catalogue row: the engine and this deployment's `installed`. -/
structure CatalogueRow where
  id : String
  installed : Bool
  deriving DecidableEq, Repr, Inhabited

/-- `registeredEngines`: every registered engine, with `installed` read from the map. -/
@[aw_spec (ts := "apps/web/server/engines/registry.ts#registeredEngines")]
def catalogue (registered : List Registered) (images : EngineImageMap) : List CatalogueRow :=
  registered.map fun engine => { id := engine.id, installed := installed images engine.id }

/-! ## Dispatch -/

/-- The drivers that take an image from the map. -/
inductive ImageDriver where
  | docker
  | kubernetes
  | cloudRunService
  deriving DecidableEq, Repr, Inhabited

/-- The sandboxes a driver has created: `(session, image reference)`, in creation order. -/
structure Sandboxes where
  created : List (String × String) := []
  deriving DecidableEq, Repr, Inhabited

/-- What `create()` answers. -/
inductive CreateResult where
  | created (image : String)
  | refused (code : String)
  deriving DecidableEq, Repr, Inhabited

/-- `create()` of every image-taking driver: resolve the image of the run's engine first, and
create nothing when there is none. The driver does not change the decision — all three call
`requireEngineImage` before their first side effect. -/
@[aw_spec (ts := "packages/runtime/src/engine-images.ts#requireEngineImage")
  (ts := "packages/runtime/src/docker.ts#createDockerDriver")
  (ts := "packages/runtime/src/kubernetes.ts#createKubernetesDriver")
  (ts := "packages/runtime/src/cloud-run.ts#createCloudRunDriver")]
def create (_driver : ImageDriver) (images : EngineImageMap) (state : Sandboxes)
    (session engine : String) : CreateResult × Sandboxes :=
  match lookup images engine with
  | none => (.refused "engine_not_installed", state)
  | some image => (.created image, { created := state.created ++ [(session, image)] })

/-- Run a sequence of `(session, engine)` creations through one driver. -/
def createAll (driver : ImageDriver) (images : EngineImageMap) :
    Sandboxes → List (String × String) → Sandboxes
  | state, [] => state
  | state, (session, engine) :: rest =>
    createAll driver images (create driver images state session engine).2 rest

/-- `create()` of the ACA session pool, which holds exactly one image for one engine. -/
@[aw_spec (ts := "packages/runtime/src/aca-sessions.ts#createAcaSessionsDriver")]
def createInPool (poolEngine poolImage : String) (state : Sandboxes) (session engine : String) :
    CreateResult × Sandboxes :=
  if engine == poolEngine then
    (.created poolImage, { created := state.created ++ [(session, poolImage)] })
  else (.refused "engine_not_installed", state)

/-- A map is label-honest when the image configured under engine `e` carries label `e`. -/
def LabelHonest (label : String → String) (images : EngineImageMap) : Prop :=
  ∀ engine image, (engine, image) ∈ images → label image = engine

/-! ## The run route -/

/-- What `POST /api/agents/:id/runs` answers, in the part this family decides. -/
inductive RouteAnswer where
  /-- The run row is written; the list is the store afterwards. -/
  | accepted (runs : List String)
  | refused (status : Nat) (code : String) (runs : List String)
  deriving DecidableEq, Repr, Inhabited

/-- `startRun`, after the session's engine is pinned: refuse an engine with no image before
`store.create`. -/
@[aw_spec (ts := "apps/web/server/runs/api.ts#startRun")]
def startRun (images : EngineImageMap) (runs : List String) (runId engine : String) :
    RouteAnswer :=
  if installed images engine then .accepted (runs ++ [runId])
  else .refused 422 "engine_not_installed" runs

end AgentWorkspace.Behaviour.EngineImages
