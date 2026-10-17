import AgentWorkspace.Concepts.Run
import AgentWorkspace.Concepts.RuntimeProfile

/-!
# The engine concept

An **engine** is "the harness that turns an agent definition and a prompt into model calls, tool
calls and a stream of events"
(`docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md` D1). It is the
extension point ADR-0065 opens: the Claude Agent SDK is the reference engine today, and `pi`, the
OpenAI Agents SDK, Mastra and a generic ACP adapter are planned behind one port.

This module is the vocabulary of that record and the three rules of it that can be stated before
any TypeScript exists. It is deliberately **abstract**: there is no wire codec here, because no
engine id is on the wire until ENG-02 (#301). `WireEnum` instances, the `engines` contract module
and the `Er/Target` glossary term are that unit's, and it refines this one.

ADR-0065 D1 fixes four words, and this module keeps them one vocabulary rather than four copies:

* `Engine` — the harness (new here);
* `ModelProvider` — who serves the model; already `Concepts.Run.ModelProvider`, re-exported;
* `RuntimeDriver` — where the sandbox runs; already `Concepts.RuntimeProfile.Driver`, re-exported;
* `WireProtocol` — the HTTP dialect an engine speaks to the gateway (new here).

**Composition.** An agent states requirements over the portable core (D4); an engine states which
of those concepts it supports and which protocols it speaks (D2). `compose` is the abstract
decision the control plane takes at agent save and again at run compose. Its whole content is
D3's rule: **refuse, never ignore.** It accepts only when every requirement is supported, and
otherwise refuses naming at least one concept that is not. It never accepts while dropping one.

**Billing.** `RunBilling` carries both what the gateway metered and what the engine said about
itself. `billed` reads the ledger alone (D6), so `engineReported` is present precisely in order
to be provably ignored.

**Sessions.** `SessionRuns` is the abstract session of D8: an engine pinned at creation and the
runs launched into it. `launch` refuses a run for another engine rather than re-pinning, so the
pinning invariant holds of every reachable state rather than of a checked one.
-/

namespace AgentWorkspace.Concepts.Engine

open AgentWorkspace

/-! ## The vocabulary (ADR-0065 D1) -/

/-- The engines ADR-0065 D1 names: the reference engine and the four planned ones. No `WireEnum`
instance, because no engine id is on the wire before ENG-02. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d1--vocabulary")]
inductive Engine where
  | claudeAgentSdk
  | pi
  | openaiAgents
  | mastra
  | acp
  deriving DecidableEq, Repr, Inhabited

/-- Who serves the model: a property of a model connection, never the engine (ADR-0065 D1). The
term already exists as `Concepts.Run.ModelProvider`; this is the same type, not a second one. -/
abbrev ModelProvider := Concepts.Run.ModelProvider

/-- Where the sandbox runs (ADR-0065 D1). The term already exists as
`Concepts.RuntimeProfile.Driver`; this is the same type, not a second one. -/
abbrev RuntimeDriver := Concepts.RuntimeProfile.Driver

/-- The HTTP dialect an engine speaks to the gateway (ADR-0065 D1 and D7). -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d1--vocabulary")]
inductive WireProtocol where
  | anthropicMessages
  | openaiResponses
  | openaiChatCompletions
  deriving DecidableEq, Repr, Inhabited

/-- The portable core every engine honours or refuses by name (ADR-0065 D4). Anything outside
this list is an engine-native policy arm and is not a requirement any other engine sees.

`subagents` joined the core with ADR-0133 D14: an agent may name subagents, and an engine declares
whether it can run them, so a demand for them is refused by name like any other concept. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d4--the-portable-core-every-engine-honours")]
inductive PortableConcept where
  | instructions
  | permissionReadFiles
  | permissionWriteFiles
  | permissionRunCommands
  | permissionUnrestrictedNetwork
  | fileGrants
  | connectors
  | skills
  | subagents
  | modelSelection
  | limits
  deriving DecidableEq, Repr, Inhabited

namespace PortableConcept

/-- The eleven portable concepts, so a statement can quantify over the whole core. -/
def all : List PortableConcept :=
  [instructions, permissionReadFiles, permissionWriteFiles, permissionRunCommands,
    permissionUnrestrictedNetwork, fileGrants, connectors, skills, subagents, modelSelection,
    limits]

/-- `all` really is every constructor. -/
theorem mem_all (c : PortableConcept) : c ∈ all := by cases c <;> decide

end PortableConcept

/-! ## Composition (ADR-0065 D3 and D4) -/

/-- What one engine can do: which portable concepts it honours, and which protocols it speaks.
`supports` is a predicate rather than a list so that the statements below quantify over every
engine an adapter could ever describe, not only the five named today. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d2--what-the-platform-owns")]
structure EngineCapabilities where
  engine : Engine
  supports : PortableConcept → Bool
  speaks : WireProtocol → Bool

/-- What one agent needs: the portable concepts its configuration uses, and the wire protocol of
the model connection it was given. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d4--the-portable-core-every-engine-honours")]
structure AgentRequirements where
  required : List PortableConcept
  connectionProtocol : WireProtocol

/-- The outcome of composing an agent with an engine: accepted, or refused naming the portable
concepts the engine does not support. There is no third arm, and in particular no arm that
accepts having dropped something (ADR-0065 D3). -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d3--what-the-platform-refuses-to-own")]
inductive ComposeResult where
  | accepted
  | refused (missing : List PortableConcept)
  deriving DecidableEq, Repr, Inhabited

/-- The portable requirements this engine cannot honour, in the order the agent states them. -/
def unsupported (need : AgentRequirements) (cap : EngineCapabilities) : List PortableConcept :=
  need.required.filter (fun c => !cap.supports c)

/-- Compose an agent's portable requirements with an engine's capabilities: accept when the
engine supports every one, otherwise refuse naming those it does not. This is the decision the
control plane takes at agent save and again at run compose (ADR-0065 D3). -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d3--what-the-platform-refuses-to-own")]
def compose (need : AgentRequirements) (cap : EngineCapabilities) : ComposeResult :=
  match unsupported need cap with
  | [] => .accepted
  | missing => .refused missing

/-- Whether the gateway has to translate for this pairing: only when the engine cannot speak the
connection's own protocol (ADR-0065 D7). An engine that speaks it does, and translation — which
is approximate — is reserved for single-protocol engines. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d7--an-engine-speaks-the-connections-native-protocol-when-it-can")]
def needsTranslation (need : AgentRequirements) (cap : EngineCapabilities) : Bool :=
  !cap.speaks need.connectionProtocol

/-! ## Billing (ADR-0065 D6) -/

/-- What a run knows about its usage: the gateway's ledger rows, and whatever the engine said
about itself. The second field exists so that its irrelevance can be stated. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d6--billing-is-always-gateway-metered")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")]
structure RunBilling where
  engine : Engine
  /-- The gateway's usage records for this run, one per upstream response. -/
  gatewayLedger : List Concepts.Usage.Counters
  /-- What the engine reported about itself. Informational only. -/
  engineReported : Concepts.Usage.Counters

/-- The billed usage of a run: the sum over the gateway's ledger, and nothing else. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d6--billing-is-always-gateway-metered")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")]
def billed (b : RunBilling) : Concepts.Usage.Counters :=
  Concepts.Usage.Counters.sum b.gatewayLedger

/-! ## Session pinning (ADR-0065 D8) -/

/-- A run as the session model sees it: which engine executed it. -/
structure EngineRun where
  engine : Engine
  deriving DecidableEq, Repr, Inhabited

/-- The abstract session of ADR-0065 D8: an engine pinned when the session is created, and the
runs launched into it so far. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d8--a-session-is-pinned-to-one-engine")]
structure SessionRuns where
  pinned : Engine
  runs : List EngineRun
  deriving DecidableEq, Repr, Inhabited

namespace SessionRuns

/-- A session at its first run: pinned, with nothing launched yet. -/
def pin (e : Engine) : SessionRuns := ⟨e, []⟩

/-- Launch a run into a session. A request for another engine is refused (`409
session_engine_mismatch`) rather than re-pinning the session or running it anyway. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d8--a-session-is-pinned-to-one-engine")]
def launch (s : SessionRuns) (e : Engine) : Option SessionRuns :=
  if e = s.pinned then some { s with runs := s.runs ++ [⟨e⟩] } else none

/-- Launch a whole request sequence, stopping at the first refusal. -/
def launchAll : SessionRuns → List Engine → Option SessionRuns
  | s, [] => some s
  | s, e :: rest => (s.launch e).bind (fun s' => launchAll s' rest)

end SessionRuns

end AgentWorkspace.Concepts.Engine
