import AgentWorkspace.Theorems.Adversarial.PathGrant

import AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-!
# T3 — the OpenAI Agents adapter against a hostile agent (ENG-09, #308)

Three properties a model under the agent's control must not be able to break:

* **path grants** — no write the compiled Editor permits lands inside a read-only grant, however
  the path is spelled; the grants it enforces are exactly the request's, normalised;
* **egress** — every model request the compiled configuration can issue targets the gateway's base
  URL, carries the run token as `Authorization: Bearer`, and the configuration names no other
  model endpoint;
* **tracing** — every compiled run has tracing disabled.

What the SDK does with the configuration is a hypothesis (see `Behaviour/Engines/OpenAiAgents.lean`)
enforced by the package's boundary suite, which records every outbound request of a real run.
-/

namespace AgentWorkspace.Theorems.Adversarial.OpenAiAgents

open AgentWorkspace AgentWorkspace.Authz.PathGrant AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-- No write the compiled Editor permits lands inside a read-only grant of the request: the grants
it enforces are the request's own, normalised, and an allowed write is outside every read-only one. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-openai-agents.md#path-grants")
  (ts := "packages/engine-openai-agents/src/workspace.ts#workspaceWriteVerdict")
  (ts := "packages/engine-openai-agents/src/executors.ts#applyPatch")]
theorem no_permitted_write_lands_in_a_read_only_grant {r : Request} {c : Compiled}
    (h : compile r = .ok c) (candidate : String) (segments : List String)
    (hw : writeGrantVerdict (some protectedDirectory) c.grants candidate = .ok segments) :
    normaliseGrants (some protectedDirectory) r.grants = some c.grants ∧
      ∀ g ∈ c.grants, g.readOnly = true → covers g segments = false := by
  obtain ⟨grants, _, _, _, _, hg, _, _, _, hgrants, _⟩ := compile_ok_shape h
  refine ⟨hgrants ▸ hg, ?_⟩
  exact Adversarial.PathGrant.allowed_write_is_outside_every_read_only_grant _ _ _ _ hw

/-- Witness: a read-only `docs` grant refuses every spelling of a write under it, the adapter's own
directory is refused, and a sibling path stays writable. -/
example :
    let c : Compiled :=
      { tools := [.applyPatch], networkEgress := false,
        connection := connectionFor .openaiResponses "http://gw" "tok", connectors := [],
        maxTurns := none, budgetCap := false,
        grants := [{ directory := true, segments := ["docs"], readOnly := true }],
        tracingDisabled := true }
    writeAllowed c "docs/a.md" = false ∧ writeAllowed c "x/../docs/a.md" = false ∧
      writeAllowed c ".openai-agents/settings.json" = false ∧
      writeAllowed c "docs-private/a.md" = true := by decide

/-- Every model request an accepted configuration can issue targets the gateway's base URL plus
`/v1`, carries the run token as `Authorization: Bearer`, and there is exactly one such endpoint. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-openai-agents.md#egress")
  (ts := "packages/engine-openai-agents/src/compile.ts#openAiAgentsModelConnection")
  (ts := "packages/engine-openai-agents/src/boundary.ts#startOpenAiAgentsRun")]
theorem every_model_request_goes_to_the_gateway_with_the_run_token {r : Request} {c : Compiled}
    (h : compile r = .ok c) :
    ∃ b t w, r.gateway = some (b, t, w) ∧ (modelRequests c.connection).length = 1 ∧
      ∀ req ∈ modelRequests c.connection,
        req.1 = stripTrailingSlashes b ++ "/v1" ++ c.connection.protocol.path ∧
        req.2 = "Bearer " ++ t := by
  obtain ⟨_, b, t, w, p, _, hgw, _, _, _, _, hconn, _⟩ := compile_ok_shape h
  refine ⟨b, t, w, hgw, rfl, ?_⟩
  intro req hreq
  simp only [modelRequests, List.mem_singleton] at hreq
  subst hreq
  rw [hconn]
  exact ⟨rfl, rfl⟩

/-- Witness: a base URL with a trailing slash still yields one `/v1` request under it. -/
example :
    modelRequests (connectionFor .anthropicMessages "http://gateway:8080/" "run-token") =
      [("http://gateway:8080/v1/messages", "Bearer run-token")] := by decide

/-- Every compiled run has tracing disabled. The SDK's side — `setTracingDisabled(true)` before
`run`, and no trace export after it — is the declared hypothesis the boundary suite enforces. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-openai-agents.md#tracing")
  (ts := "packages/engine-openai-agents/src/compile.ts#compileOpenAiAgentsRun")
  (ts := "packages/engine-openai-agents/src/boundary.ts#startOpenAiAgentsRun")]
theorem tracing_is_disabled_for_every_compiled_run {r : Request} {c : Compiled}
    (h : compile r = .ok c) : c.tracingDisabled = true := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, htr, _⟩ := compile_ok_shape h
  exact htr

end AgentWorkspace.Theorems.Adversarial.OpenAiAgents
