import AgentWorkspace.Theorems.Invariants.BehaviourEngines
import AgentWorkspace.Theorems.Invariants.SdkEngines
import AgentWorkspace.Theorems.Normative.AuthzDecide
import AgentWorkspace.Theorems.Normative.ContractsEngines
import AgentWorkspace.Theorems.Refinement.ContractsEngines
import AgentWorkspace.Theorems.WellFormed.ContractsEngines
import Vectors.Common

/-!
The `engines` family (ENG-02a, #317; extended by ENG-02b, #318, and ENG-02c, #319). Seven files:

* `sdk.json` — `GET /api/engines` and `engines.list()` as one projection of the registry, replayed
  against the real route handler (#319);
* `cli.json` — `aw engines list` and `--engine`, replayed against the real binary (#319);
* `catalog.json` — the engine vocabulary as the contracts publish it, so the replay can compare the
  TypeScript `as const` arrays against the model's `WireEnum` order rather than against a comment;
* `schemas.json` — `EngineCapabilitiesSchema` and `EngineDescriptorSchema` over accepted and
  refused bodies, replayed against the real zod schemas;
* `policy.json` — `parsePolicyBody`'s verdict for each body, replayed against
  `apps/web/server/agents/policy.ts`;
* `migration.json` — migration 0025's per-row rewrite;
* `enforcement.json` — ENG-02b's two enforcements: the save-time capability check over every
  capability/demand pair, and session engine pinning replayed against the **real** run route, where
  "no run row is created" is checked on the rows rather than on a comparison (#318).
-/

namespace Vectors.Engines

open Lean AgentWorkspace AgentWorkspace.Contracts.Engines AgentWorkspace.Behaviour.Engines
  AgentWorkspace.Sdk.Engines AgentWorkspace.Cli.Engines

private def wf (name : String) : String :=
  "AgentWorkspace.Theorems.WellFormed.ContractsEngines." ++ name

private def norm (name : String) : String :=
  "AgentWorkspace.Theorems.Normative.ContractsEngines." ++ name

private def refine (name : String) : String :=
  "AgentWorkspace.Theorems.Refinement.ContractsEngines." ++ name

private def inv (name : String) : String :=
  "AgentWorkspace.Theorems.Invariants.SdkEngines." ++ name

private def authz (name : String) : String :=
  "AgentWorkspace.Theorems.Normative.AuthzDecide." ++ name

private def pin (name : String) : String :=
  "AgentWorkspace.Theorems.Invariants.BehaviourEngines." ++ name

/-! ## The catalogue -/

def catalogFile : List Vector :=
  [{ id := "vocabulary",
     input := Json.mkObj [("question", "the engine vocabulary, in wire order")],
     expected := Json.mkObj
       [("engineIds", Lean.toJson engineIds),
        ("wireProtocols", Lean.toJson wireProtocols),
        ("limitEnforcements", Lean.toJson limitEnforcements),
        ("budgetEnforcements", Lean.toJson budgetEnforcements)],
     witnesses := [wf "wire_orders_match_the_exports",
       wf "engine_ids_are_not_model_providers"] },
   { id := "default-registry",
     input := Json.mkObj [("question", "which engines a deployment registers by default")],
     expected := Json.mkObj [("registered", Lean.toJson defaultRegistered)],
     witnesses := [norm "default_registry_is_the_catalogue"] }]

/-! ## The two schemas -/

private def capabilities (overrides : JValue.Fields := []) : JValue :=
  let base : JValue.Fields :=
    [("mcp", .bool true), ("skills", .bool true), ("subagents", .bool false),
     ("resume", .bool true), ("fork", .bool false), ("interrupt", .bool true),
     ("streamingText", .bool false), ("reasoning", .bool true),
     ("maxTurns", .str "native"), ("maxBudget", .str "native"),
     ("wireProtocols", .arr [.str "anthropic-messages"])]
  .obj (base.map fun (key, prior) =>
    match JValue.lookup key overrides with
    | some replacement => (key, replacement)
    | none => (key, prior))

private def descriptor (overrides : JValue.Fields := []) : JValue :=
  let base : JValue.Fields :=
    [("id", .str "claude-agent-sdk"), ("displayName", .str "Claude Agent SDK"),
     ("version", .str "0.3.278"), ("capabilities", capabilities), ("installed", .bool true)]
  .obj (base.map fun (key, prior) =>
    match JValue.lookup key overrides with
    | some replacement => (key, replacement)
    | none => (key, prior))

private def schemaVector (schema id : String) (input : JValue) (check : JValue → Bool)
    (theoremName : String) : Vector :=
  { id := schema ++ "/" ++ id,
    input := Json.mkObj [("schema", schema), ("body", input.toJson)],
    expected := Json.mkObj [("output", if check input then input.toJson else Json.null)],
    witnesses := [wf theoremName] }

def schemasFile : List Vector :=
  let capabilityCases : List (String × JValue) :=
    [("valid", capabilities),
     ("budget-none", capabilities [("maxBudget", .str "none")]),
     ("turns-none", capabilities [("maxTurns", .str "none")]),
     ("no-protocol", capabilities [("wireProtocols", .arr [])]),
     ("unknown-protocol", capabilities [("wireProtocols", .arr [.str "telepathy"])]),
     ("every-protocol", capabilities [("wireProtocols",
       .arr [.str "anthropic-messages", .str "openai-responses", .str "openai-chat-completions"])]),
     ("unknown-key", .obj [("hitl", .bool true)]),
     ("not-object", .arr []),
     ("missing-reasoning", .obj [("mcp", .bool true), ("skills", .bool true),
       ("subagents", .bool false), ("resume", .bool true), ("fork", .bool false), ("interrupt", .bool true),
       ("streamingText", .bool false), ("maxTurns", .str "native"),
       ("maxBudget", .str "native"), ("wireProtocols", .arr [.str "anthropic-messages"])])]
  let descriptorCases : List (String × JValue) :=
    [("valid", descriptor),
     ("not-installed", descriptor [("installed", .bool false)]),
     ("unregistered-id", descriptor [("id", .str "acp")]),
     ("empty-display-name", descriptor [("displayName", .str "")]),
     ("empty-version", descriptor [("version", .str "")]),
     ("unknown-key", .obj [("id", .str "claude-agent-sdk"), ("displayName", .str "x"),
       ("version", .str "1"), ("capabilities", capabilities), ("installed", .bool true),
       ("note", .str "extra")]),
     ("missing-installed", .obj [("id", .str "claude-agent-sdk"), ("displayName", .str "x"),
       ("version", .str "1"), ("capabilities", capabilities)])]
  (capabilityCases.map fun (id, j) =>
    schemaVector "EngineCapabilitiesSchema" id j engineCapabilities "capabilities_roundtrip") ++
  (descriptorCases.map fun (id, j) =>
    schemaVector "EngineDescriptorSchema" id j engineDescriptor "descriptor_roundtrip")

/-! ## The policy parser

`accept` is the real `AgentPolicySchema` in the replay, so each vector states the body, the
registered engines, and what the union says about the body — and the expected verdict follows from
all three. A vector whose `unionAccepts` is `true` is the interesting one: it is the case a parser
that consulted the union first would get wrong. -/

private def policyVector (id : String) (registered : List String) (unionAccepts : Bool)
    (body : JValue) (witnesses : List String) : Vector :=
  { id,
    input := Json.mkObj [("body", body.toJson), ("registered", Lean.toJson registered),
      ("unionAccepts", unionAccepts)],
    expected := Json.mkObj
      [("verdict", match parsePolicy registered (fun _ => unionAccepts) body with
        | .accepted => "accepted"
        | .invalidBody => "invalid_body"
        | .unsupportedEngine => "unsupported_engine"
        | .invalidPolicy => "invalid_policy"),
       ("status", Lean.toJson (parsePolicy registered (fun _ => unionAccepts) body).status)],
    witnesses }

private def claudePolicyBody : JValue := .obj [("engine", .str "claude-agent-sdk")]

/-- A complete `claude-agent-sdk` policy the real union accepts: the engine plus the `tools`,
`skills` and `limits` `AgentPolicySchema` requires. `claudePolicyBody` alone is refused by the
union for the missing members, so it is the body of the union-refuses vector. -/
private def claudeFullPolicyBody : JValue :=
  .obj [("engine", .str "claude-agent-sdk"),
    ("tools", .obj [("base", .str "claude_code_preset"), ("autoApprove", .arr []),
      ("deny", .arr []), ("permissionMode", .str "default")]),
    ("skills", .obj [("mode", .str "all")]),
    ("limits", .obj [("maxTurns", .null), ("maxBudgetUsd", .null)])]

def policyFile : List Vector :=
  [policyVector "legacy-provider" defaultRegistered true
     (.obj [("provider", .str "claude-agent-sdk")])
     [norm "legacy_provider_discriminant_is_always_refused",
      norm "legacy_refusal_names_the_rename"],
   policyVector "legacy-provider-union-refuses" defaultRegistered false
     (.obj [("provider", .str "claude-agent-sdk")])
     [norm "legacy_provider_discriminant_is_always_refused"],
   policyVector "unregistered-engine" defaultRegistered true (.obj [("engine", .str "acp")])
     [norm "unregistered_engine_is_always_refused",
      norm "unsupported_engine_is_a_four_hundred"],
   policyVector "unregistered-engine-not-a-string" defaultRegistered true
     (.obj [("engine", .num 1 0)])
     [norm "unregistered_engine_is_always_refused"],
   policyVector "registered-engine-accepted" defaultRegistered true claudeFullPolicyBody
     [norm "a_registered_engine_reaches_the_union"],
   policyVector "registered-engine-union-refuses" defaultRegistered false claudePolicyBody
     [norm "a_registered_engine_reaches_the_union"],
   policyVector "both-discriminants" defaultRegistered false
     (.obj [("engine", .str "claude-agent-sdk"), ("provider", .str "anthropic")])
     [norm "naming_both_discriminants_is_refused"],
   policyVector "registry-decides" ["claude-agent-sdk", "acp"] false (.obj [("engine", .str "acp")])
     [norm "the_refusal_is_about_the_registry"]]

/-! ## Migration 0025 -/

private def migrationVector (id : String) (engineSessionId engine : Option String) : Vector :=
  let before : StoredSession := ⟨engineSessionId, engine⟩
  let after := migrateSession before
  { id := "session/" ++ id,
    input := Json.mkObj [("engineSessionId", Lean.toJson engineSessionId),
      ("engine", Lean.toJson engine)],
    expected := Json.mkObj [("engineSessionId", Lean.toJson after.engineSessionId),
      ("engine", Lean.toJson after.engine), ("paired", enginePaired after)],
    witnesses := [refine "session_backfill_pins_exactly_the_identified",
      refine "session_backfill_preserves_the_identity",
      refine "session_backfill_establishes_the_pairing"] }

private def policyMigrationVector (id : String) (p : StoredPolicy) : Vector :=
  let after := migratePolicy p
  { id := "policy/" ++ id,
    input := Json.mkObj [("discriminantKey", Lean.toJson (p.discriminant.map Prod.fst)),
      ("discriminantValue", Lean.toJson (p.discriminant.map Prod.snd)),
      ("rest", Lean.toJson p.rest)],
    expected := Json.mkObj [("discriminantKey", Lean.toJson (after.discriminant.map Prod.fst)),
      ("discriminantValue", Lean.toJson (after.discriminant.map Prod.snd)),
      ("rest", Lean.toJson after.rest)],
    witnesses := [refine "policy_rewrite_renames_the_discriminant",
      refine "policy_rewrite_leaves_no_provider",
      refine "policy_rewrite_is_idempotent"] }

def migrationFile : List Vector :=
  [migrationVector "identified-unpinned" (some "se1") none,
   migrationVector "identified-pinned" (some "se1") (some migratedEngine),
   migrationVector "anonymous" none none,
   policyMigrationVector "legacy" (legacyPolicy [("tools", "claude_code_preset")]),
   policyMigrationVector "already-migrated"
     { discriminant := some ("engine", migratedEngine), rest := [("tools", "claude_code_preset")] },
   policyMigrationVector "null-column" { discriminant := none, rest := [] }]

/-! ## ENG-02b: the two enforcements

The capability vectors cover every pair of `(what the engine honours, what the agent demands)`, which
is every input the decision reads — sixty-four, so the replay is exhaustive rather than illustrative.
The pinning vectors carry the run rows before and after, because "no run row is created" is the half
of the acceptance criterion a verdict alone cannot state. -/

private def capabilityVector (id : String) (cap : AssignmentCapabilities)
    (demand : AssignmentDemand) : Vector :=
  let verdict := saveAgent cap demand
  { id := "capability/" ++ id,
    input := Json.mkObj
      [("capabilities", Json.mkObj
          [("mcp", cap.mcp), ("skills", cap.skills), ("subagents", cap.subagents)]),
       ("demand", Json.mkObj
          [("connectors", demand.connectors), ("skills", demand.skills),
           ("subagents", demand.subagents)])],
    expected := Json.mkObj
      [("verdict", match verdict with
        | CapabilityVerdict.saved => "saved"
        | CapabilityVerdict.unsupported _ => "engine_capability_unsupported"),
       ("status", Lean.toJson verdict.status),
       ("details", Lean.toJson verdict.details)],
    witnesses := [norm "capability_refusal_is_exact",
      norm "a_capability_refusal_names_a_real_gap",
      norm "engine_capability_unsupported_is_a_four_twenty_two",
      norm "claude_agent_sdk_never_refuses_an_assignment",
      norm "capability_check_refines_compose"] }

private def capabilityCases : List (String × AssignmentCapabilities) :=
  [("both", ⟨true, true, false⟩), ("no-mcp", ⟨false, true, false⟩),
   ("no-skills", ⟨true, false, false⟩), ("neither", ⟨false, false, false⟩),
   ("both-and-subagents", ⟨true, true, true⟩), ("no-mcp-and-subagents", ⟨false, true, true⟩),
   ("no-skills-and-subagents", ⟨true, false, true⟩), ("subagents-only", ⟨false, false, true⟩)]

private def demandCases : List (String × AssignmentDemand) :=
  [("nothing", ⟨false, false, false⟩), ("connector", ⟨true, false, false⟩),
   ("skill", ⟨false, true, false⟩), ("connector-and-skill", ⟨true, true, false⟩),
   ("subagent", ⟨false, false, true⟩), ("connector-and-subagent", ⟨true, false, true⟩),
   ("skill-and-subagent", ⟨false, true, true⟩), ("everything", ⟨true, true, true⟩)]

private def claudeEngine : String := EngineId.toWire EngineId.claudeAgentSdk
private def testOnlyEngine : String := "test-only-engine"

private def pinningVector (id : String) (sessionEngine : Option String) (agentEngine : String) :
    Vector :=
  let before : LaunchState := ⟨sessionEngine, Option.none, []⟩
  let outcome := startRun agentEngine before
  { id := "pinning/" ++ id,
    input := Json.mkObj
      [("sessionEngine", Lean.toJson sessionEngine), ("agentEngine", agentEngine),
       ("runsBefore", Lean.toJson before.runs.length)],
    expected := Json.mkObj
      [("verdict", match outcome.1 with
        | LaunchVerdict.created _ => "created"
        | LaunchVerdict.engineMismatch => "session_engine_mismatch"),
       ("status", Lean.toJson outcome.1.status),
       ("runEngine", match outcome.1 with
        | LaunchVerdict.created engine => Lean.toJson engine
        | LaunchVerdict.engineMismatch => Json.null),
       ("runsAfter", Lean.toJson outcome.2.runs.length),
       ("sessionEngine", Lean.toJson outcome.2.sessionEngine)],
    witnesses := [pin "session_engine_mismatch_creates_no_run",
      pin "session_engine_mismatch_is_exactly_a_different_pin",
      pin "session_engine_mismatch_is_a_four_oh_nine",
      pin "a_run_records_the_engine_the_session_is_pinned_to",
      pin "an_unpinned_session_accepts_any_engine",
      pin "a_run_never_repins_the_session"] }

def enforcementFile : List Vector :=
  (capabilityCases.flatMap fun (capId, cap) =>
    demandCases.map fun (demandId, demand) =>
      capabilityVector (capId ++ "/" ++ demandId) cap demand) ++
  [pinningVector "unpinned-session" Option.none claudeEngine,
   pinningVector "same-engine" (some claudeEngine) claudeEngine,
   pinningVector "agent-moved-to-another-engine" (some claudeEngine) testOnlyEngine,
   pinningVector "session-on-another-engine" (some testOnlyEngine) claudeEngine]

/-! ## The catalogue route, the SDK projection and the CLI (ENG-02c, #319)

Each vector states a registry and what a client sees of it: the whole registry in its order, or
nothing at all. The replay drives the **real** `GET /api/engines` handler for the shipped
registry, and the real `listEngines` for a registry the contract cannot describe. -/

private def descriptorJson (d : Descriptor) : Json :=
  Json.mkObj [("id", d.id), ("displayName", d.displayName), ("version", d.version),
    ("installed", d.installed)]

private def registryJson (registry : List Descriptor) : Json :=
  Json.arr (registry.map descriptorJson).toArray

private def unpublishable : Descriptor :=
  { id := "acp", displayName := "ACP agent", version := "0.0.1", installed := false }

/-- A projection vector. `extra` is what `registerEngineForTests` adds to the shipped registry, so
the replay can install exactly the registry the vector states rather than paraphrasing it. -/
private def projectionVector (id : String) (extra : List Descriptor)
    (witnesses : List String) : Vector :=
  let registry := shippedRegistry ++ extra
  { id := "projection/" ++ id,
    input := Json.mkObj [("extraEngines", registryJson extra),
      ("registry", registryJson registry)],
    expected := Json.mkObj
      [("engines", match list registry with
        | some engines => registryJson engines
        | Option.none => Json.null),
       ("status", if (list registry).isSome then (200 : Nat) else 500),
       ("code", match list registry with
        | some _ => Json.null
        | Option.none => Json.str "engine_catalogue_invalid")],
    witnesses }

/-- A `--engine` vector, taken against `registry`: the replay serves exactly that catalogue. -/
private def flagVector (id : String) (requested : Option String)
    (registry : List Descriptor := shippedRegistry) : Vector :=
  { id := "engine-flag/" ++ id,
    input := Json.mkObj [("requested", match requested with
      | some r => Json.str r
      | Option.none => Json.null), ("registry", registryJson registry)],
    expected := Json.mkObj [("outcome", match resolveEngineFlag registry requested with
      | .absent => "absent"
      | .resolved engine => "resolved:" ++ engine
      | .refused code => "refused:" ++ code)],
    witnesses := [inv "the_engine_flag_is_resolved_or_refused"] }

def sdkFile : List Vector :=
  [{ id := "request",
     input := Json.mkObj [("call", "engines.list()")],
     expected := Json.mkObj [("method", listRequest.method), ("path", listRequest.path),
       ("expect", (listRequest.expect : Nat)), ("columns", Lean.toJson columns)],
     witnesses := [inv "the_shipped_registry_projects_to_itself",
       inv "the_columns_are_scalar_fields"] },
   projectionVector "shipped" []
     [inv "list_is_the_registry", inv "list_keeps_the_registry_length",
      inv "every_output_mode_prints_the_whole_registry"],
   projectionVector "undescribable" [unpublishable]
     [inv "an_undescribable_engine_refuses_the_whole_catalogue",
      inv "the_refusal_names_the_published_code",
      inv "one_undescribable_engine_hides_the_describable_one"],
   { id := "authz/get-api-engines",
     input := Json.mkObj [("method", "GET"), ("path", "/api/engines")],
     expected := Json.mkObj [("readableBy", Lean.toJson ["owner", "admin", "builder", "viewer"]),
       ("writableBy", Lean.toJson ["owner"])],
     witnesses := [authz "engine_catalogue_is_read_by_every_role"] }]

/-- `aw engines list` and `aw agents create|update --engine`, replayed against the real binary. -/
def cliFile : List Vector :=
  [{ id := "list/table",
     input := Json.mkObj [("argv", Lean.toJson ["engines", "list"]),
       ("registry", registryJson shippedRegistry)],
     expected := Json.mkObj [("rows", registryJson (rows .human shippedRegistry)),
       ("columns", Lean.toJson columns), ("exitCode", (0 : Nat))],
     witnesses := [inv "every_output_mode_prints_the_whole_registry",
       inv "the_columns_are_scalar_fields"] },
   { id := "list/json",
     input := Json.mkObj [("argv", Lean.toJson ["engines", "list", "--json"]),
       ("registry", registryJson shippedRegistry)],
     expected := Json.mkObj [("rows", registryJson (rows .json shippedRegistry)),
       ("exitCode", (0 : Nat))],
     witnesses := [inv "every_output_mode_prints_the_whole_registry",
       inv "the_table_and_json_show_the_same_rows"] },
   flagVector "absent" Option.none,
   flagVector "resolved" (some "claude-agent-sdk"),
   flagVector "unregistered" (some "acp"),
   flagVector "uninstalled" (some "claude-agent-sdk")
     (shippedRegistry.map fun d => { d with installed := false })]

def files : List (String × Json) :=
  [("sdk.json", file "engines"
      "GET /api/engines, engines.list() and aw engines list as a projection of the registry"
      sdkFile),
   ("cli.json", file "engines"
      "aw engines list and the --engine flag, resolved against the catalogue" cliFile),
   ("catalog.json", file "engines"
      "The engine vocabulary as the contracts publish it, in wire order" catalogFile),
   ("schemas.json", file "engines"
      "EngineCapabilitiesSchema and EngineDescriptorSchema over accepted and refused bodies"
      schemasFile),
   ("policy.json", file "engines"
      "parsePolicyBody's verdict for each body, registry and union answer" policyFile),
   ("migration.json", file "engines"
      "Migration 0025's per-row rewrite of sessions.engine and agents.policy" migrationFile),
   ("enforcement.json", file "engines"
      "The save-time capability check and session engine pinning" enforcementFile)]

end Vectors.Engines
