import AgentWorkspace.Cli.Engines

namespace AgentWorkspace.Theorems.Invariants.SdkEngines

open AgentWorkspace AgentWorkspace.Contracts.Engines AgentWorkspace.Sdk.Engines
  AgentWorkspace.Cli.Engines

/-! # T2 — `engines.list` and `aw engines list` are a total projection of the registry

The invariant this unit adds: **every registered descriptor appears exactly once, in the
registry's order** — at the route, through the SDK, and through the CLI. It is stated as one
equation, `list registry = some registry`, because that single statement carries all three claims
at once: the same elements (nothing dropped, nothing invented), the same multiplicity (exactly
once), and the same order.

The other half is the failure. A registry the published contract cannot describe refuses the
catalogue **whole**. A projection that silently dropped the offending descriptor would still
satisfy "every descriptor that appears, appears once" while answering a question it was not
asked, so the refusal is proved as its own theorem rather than left as a consequence.
-/

/-! ## The projection -/

/-- The whole of "a total projection": for a registry the contract can describe, the list a client
receives **is** the registry — the same descriptors, each exactly once, in the registry's order. -/
@[aw_spec (tier := T2) (ts := "packages/sdk/src/resources/engines.ts#EnginesClient")
  (ts := "apps/web/server/engines/handlers.ts#listEngines")]
theorem list_is_the_registry (registry : List Descriptor)
    (h : registry.all publishable = true) : list registry = some registry := by
  unfold list serve
  simp [h]

/-- Nothing is dropped and nothing is invented, stated as the count the equation implies. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/engines/handlers.ts#listEngines")]
theorem list_keeps_the_registry_length (registry : List Descriptor)
    (h : registry.all publishable = true) :
    (list registry).map List.length = some registry.length := by
  rw [list_is_the_registry registry h]
  rfl

/-- The CLI is the same projection again: `aw engines list` prints the SDK's answer unchanged, in
every output mode. A mode chooses the rendering, never the result set. -/
@[aw_spec (tier := T2) (ts := "packages/aw/src/commands/engines.ts#engineCommands")]
theorem every_output_mode_prints_the_whole_registry (registry : List Descriptor)
    (h : registry.all publishable = true) (mode : OutputMode) :
    listCommand mode registry = some registry := by
  unfold listCommand rows
  rw [list_is_the_registry registry h]
  rfl

/-- The table and `--json` answer with the same rows. The columns below are about fields. -/
@[aw_spec (tier := T2) (ts := "packages/aw/src/output.ts#writeResult")]
theorem the_table_and_json_show_the_same_rows (registry : List Descriptor)
    (a b : OutputMode) : rows a registry = rows b registry := rfl

/-- The columns name fields of a descriptor, and `capabilities` is deliberately not one of them:
a table cell cannot render it, and `--json` carries it instead. -/
@[aw_spec (tier := T2) (ts := "packages/aw/src/commands/engines.ts#engineCommands")]
theorem the_columns_are_scalar_fields :
    columns = ["id", "displayName", "version", "installed"] ∧
      columns.length = 4 ∧ columns.Nodup := by decide

/-! ## The refusal -/

/-- A registry holding a descriptor the published contract cannot describe yields **no** list —
never the publishable subset, which a caller would read as the whole catalogue. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md#d3--what-the-platform-refuses-to-own")
  (ts := "apps/web/server/engines/handlers.ts#listEngines")]
theorem an_undescribable_engine_refuses_the_whole_catalogue (registry : List Descriptor)
    (h : registry.all publishable = false) : list registry = Option.none := by
  unfold list serve
  simp [h]

/-- The refusal travels under the code the contracts publish for it. -/
@[aw_spec (tier := T2) (ts := "packages/contracts/src/engines.ts#ENGINE_PROBLEM_CODES")]
theorem the_refusal_names_the_published_code (registry : List Descriptor)
    (h : registry.all publishable = false) :
    serve registry = Answer.refused "engine_catalogue_invalid" := by
  unfold serve
  simp [h]

/-! ## Witnesses -/

/-- The deployment this release ships projects to itself: every engine it registers is one the
contracts publish. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/engines/registry.ts#registeredEngines")]
theorem the_shipped_registry_projects_to_itself :
    list shippedRegistry = some shippedRegistry ∧
      listRequest = { method := "GET", path := "/api/engines", expect := 200 } := by decide

/-- And a registry with one engine the contracts do not publish answers nothing at all, even
though the other descriptor in it is perfectly describable. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/engines/handlers.ts#listEngines")]
theorem one_undescribable_engine_hides_the_describable_one :
    list (shippedRegistry ++
      [{ id := "acp", displayName := "ACP agent", version := "0.0.1", installed := false }])
      = Option.none := by decide

/-! ## `--engine`, resolved against the catalogue -/

/-- `--engine` names an engine this deployment registers and installs, or it is refused before
anything is created or changed. There is no third answer, and no silent fall-back to the default:
a descriptor the catalogue lists with `installed := false` is refused exactly like an id it does
not list. -/
@[aw_spec (tier := T2) (ts := "packages/aw/src/commands/agents.ts#agentCommands")]
theorem the_engine_flag_is_resolved_or_refused :
    resolveEngineFlag shippedRegistry Option.none = EngineFlag.absent ∧
    resolveEngineFlag shippedRegistry (some "claude-agent-sdk")
      = EngineFlag.resolved "claude-agent-sdk" ∧
    resolveEngineFlag shippedRegistry (some "acp") = EngineFlag.refused "unsupported_engine" ∧
    resolveEngineFlag (shippedRegistry.map fun d => { d with installed := false })
      (some "claude-agent-sdk") = EngineFlag.refused "unsupported_engine" := by
  decide

end AgentWorkspace.Theorems.Invariants.SdkEngines
