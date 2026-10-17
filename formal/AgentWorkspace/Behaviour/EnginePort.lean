import AgentWorkspace.Behaviour.SandboxEnv
import AgentWorkspace.Behaviour.RunCompose
import AgentWorkspace.Contracts.Engines

/-!
# The engine port (ENG-04, #303)

The runner executes an agent through a **port** chosen by `request.engine`, and an adapter behind
that port is the only thing that knows an engine SDK exists. Three decisions follow, and all
three are modelled here as pure functions over explicit state:

1. **The registry lookup** (`apps/runner/src/engines.ts`). An engine this runtime image does not
   carry is `engine_not_installed`, answered *before any output frame* — which is only possible
   because the lookup and the compile both happen before `start`.
2. **`compile`** (`packages/engine/src/port.ts`, implemented by each adapter). A pure function
   from the neutral request to the engine's own options, whose refusals are typed values rather
   than throws.
3. **The protocol check** (`apps/web/server/engines/protocol.ts`). An engine reaches its model
   through the gateway, so a run is servable only when the engine speaks a dialect the gateway
   serves for that connection's provider.

## Current and Target

ENG-04 is behaviour-preserving for the Claude engine, and `docs/formal/README.md` asks that where
today's code and the target differ both are modelled and related. They differ in exactly one
place — *where the compile step lives* — and not at all in what it computes, which is why
`Refinement/EnginePortCompile.lean` can state the relation as an equality rather than as a
simulation. `compileCurrent` is `packages/core/src/config.ts`'s function as it was; `compileTarget`
is the adapter's `compile`, which parses the engine arm and then calls the same computation.
-/

namespace AgentWorkspace.Behaviour.EnginePort

open AgentWorkspace AgentWorkspace.Contracts.Engines

/-! ## 0. What an adapter declares about itself

`Contracts/Engines.lean` models `EngineCapabilitiesSchema` as a predicate over a JSON value,
because what it is *about* there is whether a wire document validates. What the decisions below
need is the two or three answers a compile consults, so they are a record: a capability check
written against a JSON predicate would have to re-extract a field before every comparison, and
the extraction — not the decision — would be what the theorem was about. -/

/-- The capabilities a compile consults. A strict subset of the wire schema's keys, by design:
the rest describe what a *deployment* may be asked for and are decided elsewhere. -/
structure Capabilities where
  /-- A session can be branched from an earlier point rather than only continued. -/
  fork : Bool
  /-- A session can be continued from a previously reported engine session id. -/
  resume : Bool
  /-- `SKILL.md` skills can be materialised for the engine. -/
  skills : Bool
  /-- The gateway dialects this engine speaks, in the engine's own order of preference. -/
  wireProtocols : List String
  deriving DecidableEq, Repr, Inhabited

/-- The Claude Agent SDK's capabilities, as R-01 measured them and
`packages/engine-claude-agent-sdk/src/engine.ts` declares them. -/
def claudeAgentSdkCapabilities : Capabilities :=
  { fork := false, resume := true, skills := true, wireProtocols := ["anthropic-messages"] }

/-! ## 1. The registry -/

/-- Why a request was refused before it produced anything. Each is a stable code on the wire. -/
inductive Refusal where
  /-- No adapter for `request.engine` is installed in this runtime image. -/
  | engineNotInstalled
  /-- The engine arm of the policy is not a policy this engine can read. -/
  | enginePolicyInvalid
  /-- The request asks for something the engine's declared capabilities say it cannot do. -/
  | engineCapabilityUnsupported
  /-- The sandbox environment would carry a provider credential. Spec A.11. -/
  | engineCredentialRefused
  /-- A grant would let the engine write outside what the platform granted. -/
  | enginePathGrantRefused
  deriving DecidableEq, Repr, Inhabited

namespace Refusal

/-- The wire code each refusal travels under. -/
def code : Refusal → String
  | engineNotInstalled => "engine_not_installed"
  | enginePolicyInvalid => "engine_policy_invalid"
  | engineCapabilityUnsupported => "engine_capability_unsupported"
  | engineCredentialRefused => "engine_credential_refused"
  | enginePathGrantRefused => "engine_path_grant_refused"

end Refusal

/-- One adapter as the registry holds it: an id, a version, and whether its package loaded. -/
structure InstalledAdapter where
  id : String
  version : String
  /-- The engine's own configuration directory, declared by the adapter (`.claude` for Claude). -/
  protectedConfigDirectory : String
  /-- `false` models a row whose package is declared by this runner and absent from the image. -/
  loads : Bool
  deriving DecidableEq, Repr, Inhabited

/-- What a lookup answers. There is no third arm and no default engine: running a request on an
engine other than the one it named is the failure the registry exists to make impossible. -/
inductive Lookup where
  | found (adapter : InstalledAdapter)
  | refused (reason : Refusal)
  deriving DecidableEq, Repr, Inhabited

/-- Look one engine up in a table of rows.

A row whose package does not load is `engine_not_installed`, the same answer as a row that is not
there at all: from the caller's side those are one fact about this image. A row whose adapter
reports a *different* id is refused too — the tool policy, the skills and the session were all
composed for one engine. -/
def loadEngine (table : List InstalledAdapter) (id : String) : Lookup :=
  match table.find? (fun row => row.id == id) with
  | none => .refused .engineNotInstalled
  | some row => if row.loads then .found row else .refused .engineNotInstalled

/-- What `GET /healthz` reports: the rows that actually loaded, in the table's order.

The *result of loading*, never a reading of the table — a row whose package is missing is an
engine this deployment knows about and cannot run, and reporting it as installed because it is in
a list would be the catalogue lying about the runtime. -/
def installedEngines (table : List InstalledAdapter) : List (String × String) :=
  (table.filter (fun row => row.loads)).map (fun row => (row.id, row.version))

/-! ## 2. The neutral request and `compile` -/

/-- How this run relates to an engine session. A union, so a continuing mode cannot lack an id. -/
inductive SessionSelector where
  | fresh
  | resume (engineSessionId : String)
  | fork (engineSessionId : String)
  deriving DecidableEq, Repr, Inhabited

/-- The gateway connection, handed to the adapter programmatically.

`none` is the pre-ENG-04 private-contract body, whose credential is still two environment entries
named after the Claude CLI. It is an explicit arm rather than an omission so that an adapter has
to *decide* what to do about it. -/
structure Gateway where
  baseUrl : String
  token : String
  protocol : String
  deriving DecidableEq, Repr, Inhabited

/-- One run, as the port sees it. `policyReadable` stands for "this engine's adapter could parse
the engine arm": the arm's contents are engine-native and not something this model can quantify
over, so what is modelled is the decision the adapter reaches about it. -/
structure Request where
  runId : String
  sessionId : String
  cwd : String
  engine : String
  policyReadable : Bool
  session : SessionSelector
  gateway : Option Gateway
  /-- The complete subprocess environment the adapter will compile from. -/
  env : List (String × String)
  deriving DecidableEq, Repr, Inhabited

/-- What `compile` answers. The success arm carries the compiled environment, which is the part
every theorem below is about; an engine's other options are its own business. -/
inductive CompileResult where
  | compiled (env : List (String × String))
  | refused (reason : Refusal)
  deriving DecidableEq, Repr, Inhabited

/-- The derived entries the Claude adapter adds to a request's environment.

Exactly `packages/engine-claude-agent-sdk/src/compile.ts`: the tenant session scope and A.11's two
identity variables. Derived last, so they always win. The gateway connection is **not** derived:
on today's private contract the request's own `env` already carries `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN`, and `request.gateway` is read only as the token `runTokenFor` checks
against. Translating it into the environment is deferred to the private contract's v2. -/
def derivedEnv (request : Request) (projectKey configDir : String) : List (String × String) :=
  [("CLAUDE_CONFIG_DIR", configDir),
   ("CLAUDE_CODE_PROJECT_DIR_NAME", projectKey),
   ("AGENT_WORKSPACE_RUN_ID", request.runId),
   ("AGENT_WORKSPACE_SESSION_ID", request.sessionId)]

/-- The run token this environment is checked against: the gateway's when the request carries a
connection, and otherwise whatever `ANTHROPIC_AUTH_TOKEN` already holds.

The second arm is the pre-ENG-04 body, and modelling it is the point: the rule applies to the
requests the platform composes *today*, not only to the ones the contract's v2 will compose. -/
def runTokenFor (request : Request) : String :=
  match request.gateway with
  | some g => g.token
  | none =>
    match request.env.find? (fun kv => kv.1 == "ANTHROPIC_AUTH_TOKEN") with
    | some kv => kv.2
    | none => ""

/-- The assembled environment, before it is checked. -/
def assembledEnv (request : Request) (projectKey configDir : String) : List (String × String) :=
  let derived := derivedEnv request projectKey configDir
  let names := derived.map Prod.fst
  request.env.filter (fun kv => !names.contains kv.1) ++ derived

/-- **The target compile**: parse the engine arm, check the capability, assemble, then check A.11.

The order is the invariant, not an optimisation. A policy the adapter cannot read is refused
before an environment is assembled, and an environment carrying a credential is refused before
anything is started — which is what lets the runner answer with a code *before any output frame*. -/
def compileTarget (capabilities : Capabilities) (request : Request)
    (projectKey configDir : String) : CompileResult :=
  if !request.policyReadable then .refused .enginePolicyInvalid
  else
    match request.session with
    | .fork _ =>
      if capabilities.fork then
        let env := assembledEnv request projectKey configDir
        if SandboxEnv.accepts (runTokenFor request) env then .compiled env
        else .refused .engineCredentialRefused
      else .refused .engineCapabilityUnsupported
    | _ =>
      let env := assembledEnv request projectKey configDir
      if SandboxEnv.accepts (runTokenFor request) env then .compiled env
      else .refused .engineCredentialRefused

/-- **The current compile**, as `packages/core/src/config.ts` computed it before ENG-04.

One function, no engine arm to parse and no capability to consult, refusing only the one key A.11
names. `Refinement/EnginePortCompile.lean` relates the two. -/
def compileCurrent (request : Request) (projectKey configDir : String) :
    Option (List (String × String)) :=
  RunCompose.compiledEnvironment request.env request.runId request.sessionId projectKey configDir

/-! ## 3. The run, and what it may emit -/

/-- What one `/run` produced, as an observer of the stream sees it.

`frames` counts the `agent.*` frames written before the terminal one. The invariant this exists
to state is that a refusal is accompanied by **zero** of them. -/
structure RunOutcome where
  frames : Nat
  terminal : String
  code : Option String
  deriving DecidableEq, Repr, Inhabited

/-- Serve one `/run`: look the engine up, compile, and only then start.

A refusal is a `run-error` carrying the code and no frames. A success is a `run-done` after
however many frames the engine produced. There is no path that emits a frame and then refuses,
and that is the whole content of the T2 invariant. -/
def serveRun (table : List InstalledAdapter) (capabilities : Capabilities)
    (request : Request) (projectKey configDir : String) (framesIfStarted : Nat) : RunOutcome :=
  match loadEngine table request.engine with
  | .refused reason => { frames := 0, terminal := "run-error", code := some reason.code }
  | .found _ =>
    match compileTarget capabilities request projectKey configDir with
    | .refused reason => { frames := 0, terminal := "run-error", code := some reason.code }
    | .compiled _ => { frames := framesIfStarted, terminal := "run-done", code := none }

/-! ## 4. The protocol check -/

/-- The dialect every provider answers, because it is the gateway's own request shape. -/
def gatewayNativeProtocol : String := "anthropic-messages"

/-- The two dialects the gateway forwards rather than translates. -/
def forwardedProtocols : List String := ["openai-responses", "openai-chat-completions"]

/-- The providers an OpenAI body is forwarded to (ADR-0068 D3's `forwardingRow`). -/
def forwardingProviders : List String := ["openai", "azure-openai", "openai-compatible"]

/-- Every protocol the gateway can serve a run over, for one connection's provider. -/
def gatewayProtocolsFor (provider : String) : List String :=
  if forwardingProviders.contains provider then gatewayNativeProtocol :: forwardedProtocols
  else [gatewayNativeProtocol]

/-- Which protocol this run will use, or `none` for `engine_model_protocol_unsupported`.

The **engine's** order decides, not the gateway's: an engine that lists a dialect first is saying
it would rather speak it, which is what makes the capability an ordered list rather than a set. -/
def resolveWireProtocol (engineProtocols : List String) (provider : String) : Option String :=
  engineProtocols.find? (gatewayProtocolsFor provider).contains

/-- Compose accepts this pair. A named predicate, so the normative theorem reads as its claim. -/
def composeAccepts (engineProtocols : List String) (provider : String) : Bool :=
  (resolveWireProtocol engineProtocols provider).isSome

end AgentWorkspace.Behaviour.EnginePort
