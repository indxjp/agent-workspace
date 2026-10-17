import AgentWorkspace.Behaviour.EngineImages
import AgentWorkspace.Sdk.Engines

/-!
# T4 — ENG-02's shipped `installed` is the map's answer (ENG-07, #306)

Before ENG-07 a registered descriptor stated its own `installed`, and `Sdk/Engines.lean` models the
registry this release ships with `installed := true` for `claude-agent-sdk`. Since ENG-07 no
descriptor states it: `registeredEngines` derives it from the configured `engine → image` map. The
theorem below is the refinement between the two: for every map that configures the Claude image —
the development default among them — the derived catalogue reports exactly the `installed` the
shipped registry states, so the ENG-02 theorems about `shippedRegistry` keep describing a real
deployment.
-/

namespace AgentWorkspace.Theorems.Refinement.EngineImages

open AgentWorkspace AgentWorkspace.Behaviour.EngineImages

/-- Under any map that configures `claude-agent-sdk` and — as the development default does —
none of `openai-agents`, `pi` and `mastra`, the catalogue derived from the map agrees with the
shipped registry's ids and `installed` flags.

ENG-09 (#308) added `openai-agents`, ENG-08 (#307) `pi` and ENG-10 (#309) `mastra` to the shipped
registry as not installed, because the development default map configures no image for any of
them; the last three hypotheses are those facts, and the theorem below it keeps the pre-ENG-09
statement about the Claude row under the original single hypothesis. -/
@[aw_spec (tier := T4) (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d2--the-catalogue-is-the-map")
  (ts := "apps/web/server/engines/registry.ts#registeredEngines")]
theorem shipped_registry_is_installed_through_the_map (images : EngineImageMap)
    (h : installed images "claude-agent-sdk" = true)
    (hOpenAi : installed images "openai-agents" = false)
    (hPi : installed images "pi" = false)
    (hMastra : installed images "mastra" = false) :
    (catalogue (Sdk.Engines.shippedRegistry.map fun d => { id := d.id }) images).map
        (fun row => (row.id, row.installed)) =
      Sdk.Engines.shippedRegistry.map fun d => (d.id, d.installed) := by
  have hid : Contracts.Engines.EngineId.toWire .claudeAgentSdk = "claude-agent-sdk" := by decide
  have hid' : Contracts.Engines.EngineId.toWire .openaiAgents = "openai-agents" := by decide
  have hid'' : Contracts.Engines.EngineId.toWire .pi = "pi" := by decide
  have hid''' : Contracts.Engines.EngineId.toWire .mastra = "mastra" := by decide
  simp [catalogue, Sdk.Engines.shippedRegistry, hid, hid', hid'', hid''', h, hOpenAi, hPi, hMastra]

/-- Under any map that configures `claude-agent-sdk`, the derived catalogue's Claude row agrees with
the shipped registry's: the pre-ENG-09 statement, for the engine it was about, unchanged in
strength. -/
@[aw_spec (tier := T4) (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d2--the-catalogue-is-the-map")
  (ts := "apps/web/server/engines/registry.ts#registeredEngines")]
theorem shipped_claude_row_is_installed_through_the_map (images : EngineImageMap)
    (h : installed images "claude-agent-sdk" = true) :
    ((catalogue (Sdk.Engines.shippedRegistry.map fun d => { id := d.id }) images).map
        (fun row => (row.id, row.installed))).find? (·.1 = "claude-agent-sdk") =
      (Sdk.Engines.shippedRegistry.map fun d => (d.id, d.installed)).find?
        (·.1 = "claude-agent-sdk") := by
  have hid : Contracts.Engines.EngineId.toWire .claudeAgentSdk = "claude-agent-sdk" := by decide
  simp [catalogue, Sdk.Engines.shippedRegistry, hid, h]

/-- Under **every** map — the development default, and a production map that also configures
`AGENT_WORKSPACE_RUNTIME_IMAGE_OPENAI_AGENTS` — each shipped engine's catalogue row reports exactly
whether the map configures that engine's image, in registry order. This is the map-generic form of
the two theorems above: it covers the `openai-agents`, `pi` and `mastra` rows in both
configurations, which the development-map hypotheses above leave unstated. -/
@[aw_spec (tier := T4) (doc := "docs/adr/0073-one-runtime-image-per-engine.md#d2--the-catalogue-is-the-map")
  (ts := "apps/web/server/engines/registry.ts#registeredEngines")]
theorem every_shipped_row_is_installed_exactly_when_the_map_configures_it
    (images : EngineImageMap) :
    (catalogue (Sdk.Engines.shippedRegistry.map fun d => { id := d.id }) images).map
        (fun row => (row.id, row.installed)) =
      Sdk.Engines.shippedRegistry.map fun d => (d.id, installed images d.id) := by
  simp [catalogue]

/-- Witness: a production map that configures every image installs every row. -/
example :
    (catalogue (Sdk.Engines.shippedRegistry.map fun d => { id := d.id })
        [("claude-agent-sdk", "r@sha256:a"), ("openai-agents", "r@sha256:b"),
         ("pi", "r@sha256:c"), ("mastra", "r@sha256:d")]).map
        (·.installed) = [true, true, true, true] := by decide

/-- Witness: the development default does not configure `mastra`. -/
example : installed developmentImages "mastra" = false := by decide

/-- Witness: the development default does not configure `pi`. -/
example : installed developmentImages "pi" = false := by decide

/-- Witness: the development default configures `claude-agent-sdk` and not `openai-agents`. -/
example : installed developmentImages "openai-agents" = false := by decide

/-- Witness: the development default configures `claude-agent-sdk`. -/
example : installed developmentImages "claude-agent-sdk" = true := by decide

end AgentWorkspace.Theorems.Refinement.EngineImages
