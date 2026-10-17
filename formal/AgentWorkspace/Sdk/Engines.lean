import AgentWorkspace.Contracts.Engines

/-!
# `engines.list()` — the catalogue, projected

ENG-02c (#319) puts the engine catalogue on the wire: `GET /api/engines` answers the descriptors
this deployment registers, `aw.engines.list()` reads them, and `aw engines list` prints them.

What is modelled here is the **projection**, not the descriptors' contents (`Contracts/Engines.lean`
is the codec for those). Three observations make the projection worth a model of its own:

* the route is a *total* function of the registry — there is no filter, no sort and no page, so the
  list a client sees is the registry itself;
* the one way it can fail is the deployment's own: a registry holding a descriptor
  `EngineDescriptorSchema` cannot express. That refuses the catalogue **whole**. A filtered `200`
  would answer "these are the engines this deployment offers" with a list that is not, and the
  caller's next decision — which engine to put on an agent policy — would be taken against it
  (ADR-0065 D3: refuse, never narrow);
* the SDK unwraps the `{ engines }` envelope and changes nothing else, so `list` is the route's
  answer with the envelope removed.

`Descriptor` keeps only the fields the projection can observe. `capabilities` is deliberately
absent: nothing in this layer reads it, and a model that carried it would invite a theorem about
capabilities that belongs in `Contracts/Engines.lean`.
-/

namespace AgentWorkspace.Sdk.Engines

open AgentWorkspace AgentWorkspace.Contracts.Engines

/-- One registered engine, in the fields this layer observes. -/
@[aw_spec (ts := "apps/web/server/engines/registry.ts#RegisteredEngine")]
structure Descriptor where
  /-- Widened to `String`, exactly as the registry widens it: a deployment can register an id the
  contracts do not publish, and that possibility is the whole of {@link serve}'s refusal. -/
  id : String
  displayName : String
  version : String
  installed : Bool
  deriving DecidableEq, Repr, Inhabited

/-- The one request this family sends. -/
structure Request where
  method : String
  path : String
  expect : Nat
  deriving DecidableEq, Repr, Inhabited

/-- `engines.list()`: `GET /api/engines`, expecting `200`. -/
@[aw_spec (ts := "packages/sdk/src/resources/engines.ts#EnginesClient")]
def listRequest : Request := { method := "GET", path := "/api/engines", expect := 200 }

/-- Whether `EngineDescriptorSchema` can describe this descriptor: its id is one the contracts
publish. Every other field of a registered engine is already validated by the contract's own
schema on the way into the registry. -/
def publishable (d : Descriptor) : Bool := engineIds.contains d.id

/-- What `GET /api/engines` answers. -/
inductive Answer where
  /-- `200 { engines }`, in the registry's order. -/
  | catalogue (engines : List Descriptor)
  /-- `500 engine_catalogue_invalid`: this deployment's registry cannot be published. -/
  | refused (code : String)
  deriving DecidableEq, Repr, Inhabited

/-- `listEngines`: the whole registry, or nothing. -/
@[aw_spec (ts := "apps/web/server/engines/handlers.ts#listEngines")]
def serve (registry : List Descriptor) : Answer :=
  if registry.all publishable then .catalogue registry
  else .refused "engine_catalogue_invalid"

/-- `engines.list()`: the route's answer with the `{ engines }` envelope removed. `none` is the
typed `ApiProblemError` the SDK raises, never an empty catalogue. -/
@[aw_spec (ts := "packages/sdk/src/resources/engines.ts#EnginesClient")]
def list (registry : List Descriptor) : Option (List Descriptor) :=
  match serve registry with
  | .catalogue engines => some engines
  | .refused _ => Option.none

/-- The registry this release ships: four engines (ENG-09 added `openai-agents`, ENG-08 `pi`,
ENG-10 `mastra`).
Under the development default image map only `claude-agent-sdk` has an image, so only it is
installed. -/
def shippedRegistry : List Descriptor :=
  [{ id := EngineId.toWire .claudeAgentSdk, displayName := "Claude Agent SDK",
     version := "0.3.296", installed := true },
   { id := EngineId.toWire .openaiAgents, displayName := "OpenAI Agents SDK",
     version := "0.20.0", installed := false },
   { id := EngineId.toWire .pi, displayName := "pi coding agent",
     version := "1.1.0", installed := false },
   { id := EngineId.toWire .mastra, displayName := "Mastra",
     version := "1.76.0", installed := false }]

end AgentWorkspace.Sdk.Engines
