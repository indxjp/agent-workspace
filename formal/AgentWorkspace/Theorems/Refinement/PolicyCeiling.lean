import AgentWorkspace.Theorems.Invariants.PolicyCeiling

/-!
# T4 — the ceiling's vector fixtures, decided (ADR-0102 SD6, C14)

The fixtures `Vectors/PolicyCeiling.lean` writes out, and the answers the model gives for them,
checked by `decide`. `tests/formal/policy-ceiling.test.ts` replays the same fixtures against
`policyWidenings` and `meetPolicyCeiling`.
-/

namespace AgentWorkspace.Theorems.Refinement.PolicyCeiling

open AgentWorkspace.Concepts.Agent AgentWorkspace.Concepts.PolicyCeiling

/-- Every switch on, no limits, the default engine, an explicit model, no tools. -/
def wide : Config :=
  { permissions := ⟨true, true, true, true⟩, maxTurns := none, maxBudget := none,
    engine := "claude-agent-sdk", model := some "claude-sonnet-4-5", tools := [] }

/-- A ceiling with no key: it caps nothing. -/
def open_ : Ceiling := default

/-- One fixture: an id, the configuration and the ceiling. -/
abbrev Fixture := String × Config × Option Ceiling

/-- The fixture's vector id. -/
def Fixture.id (f : Fixture) : String := f.1

/-- The configuration the fixture judges. -/
def Fixture.config (f : Fixture) : Config := f.2.1

/-- The ceiling the fixture judges it against. -/
def Fixture.ceiling (f : Fixture) : Option Ceiling := f.2.2

/-- Every field of C14 at once. -/
def allFields : Fixture :=
  ("all-fields",
    { permissions := ⟨true, true, true, false⟩, maxTurns := some 50, maxBudget := some 10,
      engine := "pi", model := some "gpt-5.1", tools := ["zeta", "alpha", "zeta", "beta"] },
    some
      { caps := ["writeFiles", "runCommands", "unrestrictedNetwork"], maxTurns := some 20,
        maxBudget := some 5, engines := some ["claude-agent-sdk", "openai-agents"],
        models := some ["claude-sonnet-4-5"], tools := some ["beta"], minEvalScore := none })

/-- No limits, under a ceiling that caps both. -/
def nullLimit : Fixture :=
  ("null-limit", wide, some { open_ with maxTurns := some 20, maxBudget := some 5 })

/-- The fixtures, one per rule of C14 and then all of them at once. -/
def fixtures : List Fixture :=
  [("no-ceiling", wide, none),
   ("no-key", wide, some open_),
   ("cap-readFiles", wide,
     some { open_ with caps := ["readFiles"] }),
   ("cap-writeFiles", wide,
     some { open_ with caps := ["writeFiles"] }),
   ("cap-runCommands", wide,
     some { open_ with caps := ["runCommands"] }),
   ("cap-unrestrictedNetwork", wide,
     some { open_ with caps := ["unrestrictedNetwork"] }),
   ("cap-switch-already-off", { wide with permissions := ⟨true, true, false, true⟩ },
     some { open_ with caps := ["runCommands"] }),
   nullLimit,
   ("limit-above", { wide with maxTurns := some 50, maxBudget := some 10 },
     some { open_ with maxTurns := some 20, maxBudget := some 5 }),
   ("limit-at", { wide with maxTurns := some 20, maxBudget := some 5 },
     some { open_ with maxTurns := some 20, maxBudget := some 5 }),
   ("limit-below", { wide with maxTurns := some 3, maxBudget := some 1 },
     some { open_ with maxTurns := some 20, maxBudget := some 5 }),
   ("engine-outside", { wide with engine := "pi" },
     some { open_ with engines := some ["claude-agent-sdk"] }),
   ("engine-inside", wide,
     some { open_ with engines := some ["openai-agents", "claude-agent-sdk"] }),
   ("model-outside", { wide with model := some "gpt-5.1" },
     some { open_ with models := some ["claude-sonnet-4-5"] }),
   ("model-null", { wide with model := none },
     some { open_ with models := some ["claude-sonnet-4-5"] }),
   ("tools-duplicate-unsorted", { wide with tools := ["zeta", "alpha", "zeta", "beta"] },
     some { open_ with tools := some ["beta"] }),
   ("tools-empty-allowlist", { wide with tools := ["crm", "crm"] },
     some { open_ with tools := some [] }),
   ("tools-absent-key", { wide with tools := ["crm"] },
     some open_),
   allFields]

/-- Every field at once: the details come in C14's key order, each named once, the tools distinct
and ascending. -/
@[aw_spec (tier := T4) (ts := "packages/contracts/src/policy-ceiling.ts#policyWidenings")]
theorem all_fields_violations :
    violations allFields.config allFields.ceiling =
      ["permissions.writeFiles", "permissions.runCommands", "limits.maxTurns",
        "limits.maxBudgetUsd", "engine:pi", "model:gpt-5.1", "tool:alpha", "tool:zeta"] := by
  decide

/-- Every field at once, met: the switches and limits come down to the ceiling, the tools keep the
allowed ones in input order, and the engine and the model are unchanged. -/
@[aw_spec (tier := T4) (ts := "packages/contracts/src/policy-ceiling.ts#meetPolicyCeiling")]
theorem all_fields_meet :
    meet allFields.config allFields.ceiling =
      { permissions := ⟨true, false, false, false⟩, maxTurns := some 20, maxBudget := some 5,
        engine := "pi", model := some "gpt-5.1", tools := ["beta"] } := by
  decide

/-- A `null` limit never widens, and the meet composes it at the ceiling's value. -/
@[aw_spec (tier := T4) (ts := "packages/contracts/src/policy-ceiling.ts#policyWidenings")
  (ts := "packages/contracts/src/policy-ceiling.ts#meetPolicyCeiling")]
theorem null_limit_never_widens :
    violations nullLimit.config nullLimit.ceiling = [] ∧
    (meet nullLimit.config nullLimit.ceiling).maxTurns = some 20 ∧
    (meet nullLimit.config nullLimit.ceiling).maxBudget = some 5 := by
  decide

/-- On every fixture, the details are empty exactly when the configuration is within, and the
met configuration's only details are the input's engine and model entries. -/
@[aw_spec (tier := T4) (ts := "packages/contracts/src/policy-ceiling.ts#policyWidenings")
  (ts := "packages/contracts/src/policy-ceiling.ts#meetPolicyCeiling")]
theorem fixtures_agree :
    fixtures.all (fun f =>
      (violations f.config f.ceiling == []) == within f.config f.ceiling &&
      violations (meet f.config f.ceiling) f.ceiling ==
        ((widenings f.config f.ceiling).filter Widening.fixed).map Widening.wire) = true := by
  decide

end AgentWorkspace.Theorems.Refinement.PolicyCeiling
