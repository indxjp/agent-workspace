import AgentWorkspace.Prelude.Text

/-!
# The sandbox environment contract (ENG-04, #303)

Spec A.11: *"Provider master credentials never enter a sandbox."* Until this unit that sentence
was enforced in two Claude-shaped places, each of them a check about one provider's spelling of
one credential. A second engine brings `OPENAI_API_KEY`, `GEMINI_API_KEY` and whatever the third
one calls its own, so the rule is restated here as a property of the **environment**:

1. `ANTHROPIC_API_KEY` is absent, case-insensitively. Kept by name because A.11 names it, and
   because it is the one variable the Claude CLI reads *in preference to* the gateway token — so
   its absence is what makes `ANTHROPIC_AUTH_TOKEN` the credential the run actually uses.
2. Every variable whose name ends `_API_KEY` or `_AUTH_TOKEN` holds **this run's** gateway token.
   Not "something short-lived", and not "a name on a list": a credential-shaped variable holding
   anything the gateway did not mint is a provider credential by definition.

Rule 2 is the half a name list cannot express and the half that generalises. What it does not
cover is stated rather than implied: a credential smuggled through a variable named neither way
is outside this check, which is why `RunEnvironment`'s reserved names and the gateway's own
issuance remain the primary defences and this is the gate that catches a regression in either.

`packages/engine/src/sandbox-env.ts` is the TypeScript.
-/

namespace AgentWorkspace.Behaviour.SandboxEnv

open AgentWorkspace

/-- A.11's own forbidden entry, by name. -/
def providerMasterCredentialEnv : String := "ANTHROPIC_API_KEY"

/-- The two suffixes that make a variable credential-shaped. -/
def credentialSuffixes : List String := ["_API_KEY", "_AUTH_TOKEN"]

/-- Upper-case ASCII folding: environment names are case-insensitive on Windows, so a gate that
read `anthropic_api_key` as a different variable would be a gate with a spelling past it. -/
def upperAscii (s : String) : String :=
  String.ofList (s.toList.map fun c => if Text.isAsciiLower c then c.toUpper else c)

/-- Does this name end with the given suffix? -/
def endsWithSuffix (name suffix : String) : Bool :=
  suffix.toList.reverse.isPrefixOf name.toList.reverse

/-- Is this variable name one the rules above treat as carrying a credential? -/
def isCredentialEnvName (name : String) : Bool :=
  credentialSuffixes.any (endsWithSuffix (upperAscii name))

/-- The verdict. The refusal names the variable, because the operator's next action is about it. -/
inductive Verdict where
  /-- Usable, and `checked` says how many credential-shaped variables were examined. -/
  | ok (checked : Nat)
  /-- Refused, naming the offending variable. -/
  | refused (variable_ : String)
  deriving DecidableEq, Repr, Inhabited

/-- Decide whether one compiled sandbox environment may be handed to an engine.

`ok` carries a count for the ADR-0015 reason the repository applies to every gate: a verdict that
reported success without saying what it looked at would pass identically over an environment
something upstream had emptied.

The comparison against `runToken` is by **value**, not by prefix or length. A token that merely
resembles the issued one is a different token, and a run whose credential is a different token is
a run reaching the gateway as somebody else. -/
def verdict (runToken : String) : List (String × String) → Verdict
  | [] => .ok 0
  | (name, value) :: rest =>
    if upperAscii name == providerMasterCredentialEnv then .refused name
    else if isCredentialEnvName name then
      if value != runToken then .refused name
      else match verdict runToken rest with
        | .ok n => .ok (n + 1)
        | .refused v => .refused v
    else verdict runToken rest

/-- An empty environment is accepted, having checked nothing.

Proved through `verdict.eq_def` so that equation is generated here, beside the definition, rather
than in the theorem module that first rewrites with it. -/
theorem verdict_nil (runToken : String) : verdict runToken [] = .ok 0 := by
  rw [verdict.eq_def]

/-- The environment is usable. A named predicate, so a theorem reads as the claim it makes. -/
def accepts (runToken : String) (env : List (String × String)) : Bool :=
  match verdict runToken env with
  | .ok _ => true
  | .refused _ => false

end AgentWorkspace.Behaviour.SandboxEnv
