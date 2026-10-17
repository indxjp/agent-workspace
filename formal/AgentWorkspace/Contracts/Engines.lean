import AgentWorkspace.Prelude.Json
import AgentWorkspace.Prelude.Codec
import AgentWorkspace.Prelude.WireEnum

/-!
# `packages/contracts/src/engines.ts`

The engine catalogue on the wire (ADR-0065, ENG-02). `Concepts/Engine.lean` already names the
concept and proves the three rules that hold before any TypeScript exists; that module is
deliberately abstract and says so: "there is no wire codec here, because no engine id is on the wire
until ENG-02". This module is the codec, and it refines that one.

Two vocabularies live here and must not be confused with a third:

* `EngineId` — the harness that runs the agent loop. Two members since ENG-09 (#308) appended
  `openai-agents` after `claude-agent-sdk`, three since ENG-08 (#307) appended `pi`, and four since
  ENG-10 (#309) appended `mastra`.
* `WireProtocol` — the HTTP dialect an engine speaks to reach the gateway. Three members, because
  the gateway serves three ingresses; an engine advertises which of them it speaks.
* **not** `Runs.modelProviders`, which is who serves the *model*. `runs.provider` keeps that
  meaning, which is the whole reason the engine got its own field name.

`Concepts.Engine.Engine` lists five engines — the reference one and the four ADR-0065 plans — while
`EngineId` lists one. That is not a disagreement: the concept enumerates what the design admits, and
this enumeration is what a deployment can be asked for today. A later unit appends a member here as
its adapter lands, and the wire order is the TypeScript `as const` order, never re-sorted.

The helpers at the bottom (`checked`, `object`, …) are this module's own. `Contracts/Runs.lean` has
the same six, but it imports *this* module rather than the other way round, so they cannot be shared
without inverting the dependency.
-/

namespace AgentWorkspace.Contracts.Engines

open AgentWorkspace

/-! ## The two enumerations -/

/-- `ENGINE_IDS`: the engines this platform's contracts publish. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d1--vocabulary")
  (ts := "packages/contracts/src/engines.ts#ENGINE_IDS")]
inductive EngineId where
  | claudeAgentSdk
  /-- The OpenAI Agents SDK (ENG-09, #308), appended in the wire order. -/
  | openaiAgents
  /-- The pi coding agent (ENG-08, #307), appended in the wire order. -/
  | pi
  /-- Mastra (ENG-10, #309), appended in the wire order. -/
  | mastra
  deriving DecidableEq, Repr, Inhabited

namespace EngineId

/-- The wire spelling, as `ENGINE_IDS` lists it. -/
def toWire : EngineId → String
  | claudeAgentSdk => "claude-agent-sdk"
  | openaiAgents => "openai-agents"
  | pi => "pi"
  | mastra => "mastra"

instance : WireEnum EngineId where
  all := [claudeAgentSdk, openaiAgents, pi, mastra]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end EngineId

/-- `WIRE_PROTOCOLS`: the HTTP dialects the gateway serves, in the order the contract lists them. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d7--an-engine-speaks-the-connections-native-protocol-when-it-can")
  (ts := "packages/contracts/src/engines.ts#WIRE_PROTOCOLS")]
inductive WireProtocol where
  | anthropicMessages
  | openaiResponses
  | openaiChatCompletions
  deriving DecidableEq, Repr, Inhabited

namespace WireProtocol

/-- The wire spelling, as `WIRE_PROTOCOLS` lists it. -/
def toWire : WireProtocol → String
  | anthropicMessages => "anthropic-messages"
  | openaiResponses => "openai-responses"
  | openaiChatCompletions => "openai-chat-completions"

instance : WireEnum WireProtocol where
  all := [anthropicMessages, openaiResponses, openaiChatCompletions]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end WireProtocol

/-- `ENGINE_LIMIT_ENFORCEMENTS`: who enforces `maxTurns` — the engine, or the adapter around it. -/
@[aw_spec (ts := "packages/contracts/src/engines.ts#ENGINE_LIMIT_ENFORCEMENTS")]
inductive LimitEnforcement where
  | native
  | adapter
  deriving DecidableEq, Repr, Inhabited

namespace LimitEnforcement

def toWire : LimitEnforcement → String
  | native => "native"
  | adapter => "adapter"

instance : WireEnum LimitEnforcement where
  all := [native, adapter]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end LimitEnforcement

/-- `ENGINE_BUDGET_ENFORCEMENTS`: as {@link LimitEnforcement}, plus `none` for an engine that
offers nowhere at all to enforce a per-run budget. -/
@[aw_spec (ts := "packages/contracts/src/engines.ts#ENGINE_BUDGET_ENFORCEMENTS")]
inductive BudgetEnforcement where
  | native
  | adapter
  /-- `'none'` on the wire. The constructor is not called `none`, because that name is
  `Option.none` in every pattern match this module writes. -/
  | absent
  deriving DecidableEq, Repr, Inhabited

namespace BudgetEnforcement

def toWire : BudgetEnforcement → String
  | native => "native"
  | adapter => "adapter"
  | absent => "none"

instance : WireEnum BudgetEnforcement where
  all := [native, adapter, absent]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end BudgetEnforcement

/-- `ENGINE_CAPABILITY_KEYS`: the three capabilities an agent can demand — connectors and skills
through its *assignments*, subagents through its version body (ADR-0133 D14) — and so the values
an `engine_capability_unsupported` refusal may name.

It is a strict subset of {@link engineCapabilities}'s keys, and deliberately so: the rest of the
capability set describes what a *run* may ask for (`resume`, `interrupt`, a turn cap), which no save
decides, so naming one of those in a save-time refusal would promise a check that does not exist. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d3--what-the-platform-refuses-to-own")
  (ts := "packages/contracts/src/engines.ts#ENGINE_CAPABILITY_KEYS")]
inductive CapabilityKey where
  | mcp
  | skills
  | subagents
  deriving DecidableEq, Repr, Inhabited

namespace CapabilityKey

/-- The wire spelling, as `ENGINE_CAPABILITY_KEYS` lists it — and as the key of
`EngineCapabilitiesSchema` it refers to. -/
def toWire : CapabilityKey → String
  | mcp => "mcp"
  | skills => "skills"
  | subagents => "subagents"

instance : WireEnum CapabilityKey where
  all := [mcp, skills, subagents]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end CapabilityKey

/-! ## The wire spellings, as lists

Every consumer that needs the vocabulary as strings — `Contracts/Runs.lean`'s `runs.engine`,
`Contracts/Sessions.lean`'s `sessions.engine`, `Er/Core.lean`'s two `CHECK`s — reads it from here,
so a member added to an `inductive` above cannot be forgotten in one of them. -/

/-- `ENGINE_IDS`, as the strings a JSON document carries. -/
def engineIds : List String := WireEnum.wires EngineId

/-- `WIRE_PROTOCOLS`, as the strings a JSON document carries. -/
def wireProtocols : List String := WireEnum.wires WireProtocol

def limitEnforcements : List String := WireEnum.wires LimitEnforcement
def budgetEnforcements : List String := WireEnum.wires BudgetEnforcement

/-- `ENGINE_CAPABILITY_KEYS`, as the strings a refusal's `details` carries. -/
def capabilityKeys : List String := WireEnum.wires CapabilityKey

/-! ## `EngineCapabilitiesSchema` and `EngineDescriptorSchema`

The same no-transform, strict-object modelling `Contracts/Runs.lean` uses: the predicate says
exactly which keys are allowed and what each one must be, and the codec is the predicate. -/

/-- A no-transform Zod schema. Its two codec laws follow from the field predicate. -/
def checked (p : JValue → Bool) : Codec JValue where
  encode := id
  decode j := if p j then some j else none
  valid := p
  decode_encode := by intro a h; simp [h]
  valid_of_decode := by
    intro j a h
    cases hp : p j with
    | false => simp [hp] at h
    | true =>
      simp [hp] at h
      subst a
      exact hp

def boolean (j : JValue) : Bool := (Codec.bool.decode j).isSome
def stringMin (n : Nat) (j : JValue) : Bool := ((Codec.stringLen n none).decode j).isSome

def enum (names : List String) (j : JValue) : Bool :=
  match j with
  | .str s => names.contains s
  | _ => false

/-- A non-empty array every member of which satisfies `p`. `wireProtocols: []` is refused rather
than read as "any", which is the mistake `.min(1)` exists to prevent. -/
def nonEmptyArrayOf (p : JValue → Bool) (j : JValue) : Bool :=
  match j with
  | .arr xs => !xs.isEmpty && xs.all p
  | _ => false

def fields (fs : JValue.Fields) (rules : List (String × (JValue → Bool))) : Bool :=
  Obj.onlyKeys (rules.map Prod.fst) fs &&
    rules.all (fun (name, check) => (JValue.lookup name fs).any check)

def object (rules : List (String × (JValue → Bool))) : JValue → Bool
  | .obj fs => fields fs rules
  | _ => false

/-- `EngineCapabilitiesSchema`: what one engine can honour of the portable core (ADR-0065 D4), in
the field order the TypeScript declares. -/
@[aw_spec (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d2--what-the-platform-owns")
  (ts := "packages/contracts/src/engines.ts#EngineCapabilitiesSchema")]
def engineCapabilities : JValue → Bool := object
  [("mcp", boolean), ("skills", boolean), ("subagents", boolean), ("resume", boolean),
   ("fork", boolean), ("interrupt", boolean), ("streamingText", boolean), ("reasoning", boolean),
   ("maxTurns", enum limitEnforcements), ("maxBudget", enum budgetEnforcements),
   ("wireProtocols", nonEmptyArrayOf (enum wireProtocols))]

/-- `EngineDescriptorSchema`: one engine as a deployment offers it. -/
@[aw_spec (ts := "packages/contracts/src/engines.ts#EngineDescriptorSchema")]
def engineDescriptor : JValue → Bool := object
  [("id", enum engineIds), ("displayName", stringMin 1), ("version", stringMin 1),
   ("capabilities", engineCapabilities), ("installed", boolean)]

def engineCapabilitiesCodec := checked engineCapabilities
def engineDescriptorCodec := checked engineDescriptor

end AgentWorkspace.Contracts.Engines
