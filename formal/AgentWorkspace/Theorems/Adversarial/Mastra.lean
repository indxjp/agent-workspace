import AgentWorkspace.Theorems.Adversarial.PathGrant

import AgentWorkspace.Behaviour.Engines.Mastra

/-!
# T3 — the Mastra adapter against a hostile agent (ENG-10, #309)

The properties a model under the agent's control, or a hostile environment, must not be able to
break:

* **path grants** — no write the filesystem wrapper permits lands inside a read-only grant,
  however the path is spelled (relative, through `..`, or absolute under the sandbox root); no
  removal or move it permits takes a read-only grant or the adapter's own directory with it; the
  grants it enforces are exactly the request's, normalised;
* **egress** — every *model* request the compiled configuration can issue targets the gateway's
  base URL, carries the run token as `Authorization: Bearer`, and the configuration names no other
  model endpoint (an HTTP connector reaches its own host, and is not a model request);
* **the model is an explicit provider** — the factory, token option and method `modelFor` acts on
  are the protocol's own, at the gateway, and never a `"provider/model"` string Mastra's router
  would resolve from provider keys in the environment;
* **observability is off** — no telemetry and no exporter for every compiled agent, and whatever
  the runner's process environment held, the one Mastra loads under disables its telemetry and its
  catalogue refresh;
* **no database credential** — no variable of an accepted request's environment is a database
  connection variable, by the `DATABASE_ENV` pattern itself.

What Mastra does with the configuration is a hypothesis (see `Behaviour/Engines/Mastra.lean`)
enforced by the package's boundary suite, which runs real Mastra against a scripted gateway that
receives every request the process makes.
-/

namespace AgentWorkspace.Theorems.Adversarial.Mastra

open AgentWorkspace AgentWorkspace.Authz.PathGrant AgentWorkspace.Behaviour.Engines.Mastra

/-- A write the wrapper allows resolved to a workspace-relative path — neither `~`, nor outside,
nor the root — and that path passed `writeGrantVerdict`. -/
private theorem allowed_write_resolves (c : Compiled) (candidate : String)
    (hw : writeAllowed c candidate = true) :
    ∃ relative segments, resolveWorkspacePath c.cwd candidate = .relative relative ∧
      writeGrantVerdict (some protectedDirectory) c.grants relative = .ok segments := by
  unfold writeAllowed writeVerdict at hw
  cases hr : resolveWorkspacePath c.cwd candidate with
  | tilde => simp [hr, WriteVerdict.isOk] at hw
  | outside => simp [hr, WriteVerdict.isOk] at hw
  | root => simp [hr, WriteVerdict.isOk] at hw
  | relative relative =>
    rw [hr] at hw
    cases hv : writeGrantVerdict (some protectedDirectory) c.grants relative with
    | refused _ => simp [hv, WriteVerdict.isOk] at hw
    | ok segments => exact ⟨relative, segments, rfl, hv⟩

/-- No write the filesystem wrapper permits lands inside a read-only grant of the request, however
the path is spelled: the grants it enforces are the request's own, normalised; the root it
resolves against is the request's `cwd`; an allowed write resolved to a workspace-relative path,
and that path normalises outside every read-only grant. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-mastra.md#path-grants")
  (ts := "packages/engine-mastra/src/workspace.ts#mastraWriteVerdict")
  (ts := "packages/engine-mastra/src/workspace.ts#mastraWorkspacePath")
  (ts := "packages/engine-mastra/src/guard.ts#mastraResolvedWriteVerdict")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
theorem no_permitted_write_lands_in_a_read_only_grant {r : Request} {c : Compiled}
    (h : compile r = .ok c) (candidate : String) (hallow : writeAllowed c candidate = true) :
    normaliseGrants (some protectedDirectory) r.grants = some c.grants ∧
      c.cwd = Behaviour.Engines.OpenAiAgents.stripTrailingSlashes r.cwd ∧
      ∃ relative segments, resolveWorkspacePath c.cwd candidate = .relative relative ∧
        writeGrantVerdict (some protectedDirectory) c.grants relative = .ok segments ∧
        ∀ g ∈ c.grants, g.readOnly = true → covers g segments = false := by
  obtain ⟨grants, _, _, _, _, _, _, hg, _, _, _, _, _, _, rfl⟩ := compile_ok_shape h
  refine ⟨hg, rfl, ?_⟩
  obtain ⟨relative, segments, hr, hv⟩ := allowed_write_resolves _ _ hallow
  exact ⟨relative, segments, hr, hv,
    Adversarial.PathGrant.allowed_write_is_outside_every_read_only_grant _ _ _ _ hv⟩

/-- Witness: a read-only `docs` grant refuses every spelling of a write under it — relative,
through `..`, and absolute under the sandbox root — the adapter's own `.mastra` directory, `~`,
an absolute path outside the root and the root itself are refused, and a sibling path stays
writable relative or absolute. -/
example :
    let c : Compiled :=
      { cwd := "/workspace", tools := [], skillTools := false, networkEgress := false,
        connection := connectionFor .anthropicMessages "http://gw" "tok",
        model := "claude-sonnet-4-5", maxSteps := none, budgetCap := false,
        grants := [{ directory := true, segments := ["docs"], readOnly := true }], skills := [],
        connectors := [], memory := memoryFor "s1" "tenant", observability := observabilityOff }
    writeAllowed c "docs/a.md" = false ∧ writeAllowed c "x/../docs/a.md" = false ∧
      writeAllowed c "/workspace/docs/a.md" = false ∧
      writeAllowed c ".mastra/skills/x/SKILL.md" = false ∧
      writeAllowed c "~/x" = false ∧ writeAllowed c "/etc/passwd" = false ∧
      writeAllowed c "/workspacex/a.md" = false ∧
      writeAllowed c "/workspace" = false ∧ writeAllowed c "." = false ∧
      writeAllowed c "docs-private/a.md" = true ∧
      writeAllowed c "/workspace/docs-private/a.md" = true := by decide

/-- No removal or move the filesystem wrapper permits takes a protected location with it: the path
resolved inside the workspace, may itself be written, and its subtree holds no read-only grant of
the request and not the adapter's own directory. The write rule is about the target; this is the
subtree rule `deleteFile`, `rmdir` and `moveFile`'s source add to it. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-mastra.md#path-grants")
  (ts := "packages/engine-mastra/src/workspace.ts#mastraRemoveVerdict")
  (ts := "packages/engine-mastra/src/workspace.ts#mastraRelativeSubtreeVerdict")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
theorem no_permitted_removal_takes_a_read_only_grant {r : Request} {c : Compiled}
    (h : compile r = .ok c) (candidate : String) (hallow : removeAllowed c candidate = true) :
    normaliseGrants (some protectedDirectory) r.grants = some c.grants ∧
      ∃ relative segments, resolveWorkspacePath c.cwd candidate = .relative relative ∧
        writeGrantVerdict (some protectedDirectory) c.grants relative = .ok segments ∧
        segments.isPrefixOf [protectedDirectory] = false ∧
        ∀ g ∈ c.grants, g.readOnly = true →
          covers g segments = false ∧ segments.isPrefixOf g.segments = false := by
  have hgrants : normaliseGrants (some protectedDirectory) r.grants = some c.grants := by
    obtain ⟨grants, _, _, _, _, _, _, hg, _, _, _, _, _, _, hc⟩ := compile_ok_shape h
    rw [hc]
    exact hg
  refine ⟨hgrants, ?_⟩
  unfold removeAllowed at hallow
  cases hw : writeVerdict c candidate with
  | refused _ => rw [hw] at hallow; simp at hallow
  | ok segments =>
    rw [hw] at hallow
    have hwa : writeAllowed c candidate = true := by
      simp [writeAllowed, hw, WriteVerdict.isOk]
    obtain ⟨relative, segments', hr, hv⟩ := allowed_write_resolves _ _ hwa
    have hseg : segments' = segments := by
      unfold writeVerdict at hw
      simp only [hr, hv] at hw
      simpa using hw
    subst hseg
    simp only [holdsProtected, Bool.not_eq_true', Bool.or_eq_false_iff, List.any_eq_false,
      Bool.and_eq_true, not_and, Bool.not_eq_true] at hallow
    refine ⟨relative, segments', hr, hv, hallow.1, fun g hgm hro => ⟨?_, hallow.2 g hgm hro⟩⟩
    exact Adversarial.PathGrant.allowed_write_is_outside_every_read_only_grant _ _ _ _ hv g hgm hro

/-- Witness: with a read-only file grant on `contracts/signed.pdf`, the directory `contracts` may
be written into but not removed or moved, however it is spelled; a sibling may be removed. -/
example :
    let c : Compiled :=
      { cwd := "/workspace", tools := [], skillTools := false, networkEgress := false,
        connection := connectionFor .anthropicMessages "http://gw" "tok",
        model := "claude-sonnet-4-5", maxSteps := none, budgetCap := false,
        grants := [{ directory := false, segments := ["contracts", "signed.pdf"],
                     readOnly := true }], skills := [],
        connectors := [], memory := memoryFor "s1" "tenant", observability := observabilityOff }
    writeAllowed c "contracts" = true ∧ removeAllowed c "contracts" = false ∧
      removeAllowed c "x/../contracts/" = false ∧ removeAllowed c "/workspace/contracts" = false ∧
      removeAllowed c "contracts/signed.pdf" = false ∧ removeAllowed c ".mastra" = false ∧
      removeAllowed c "contracts-old" = true ∧ removeAllowed c "contracts/other.pdf" = true := by
  decide

/-- Every model request an accepted configuration can issue targets the gateway's base URL plus
`/v1` and the connection's own protocol path, carries the run token as `Authorization: Bearer`,
and there is exactly one such endpoint. Model requests only: an HTTP connector reaches its own
host, and is not one. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-mastra.md#egress")
  (ts := "packages/engine-mastra/src/compile.ts#mastraModelConnection")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
theorem every_model_request_goes_to_the_gateway_with_the_run_token {r : Request} {c : Compiled}
    (h : compile r = .ok c) :
    ∃ b t w p, r.gateway = some (b, t, w) ∧
      Behaviour.Engines.OpenAiAgents.Protocol.ofWire? w = some p ∧
      modelRequests c.connection =
        [(Behaviour.Engines.OpenAiAgents.stripTrailingSlashes b ++ "/v1" ++ p.path,
          "Bearer " ++ t)] := by
  obtain ⟨grants, b, t, w, p, names, tid, _, hgw, hp, _, _, _, _, rfl⟩ := compile_ok_shape h
  refine ⟨b, t, w, p, hgw, hp, ?_⟩
  cases p <;> rfl

/-- Witness: a base URL with a trailing slash still yields one request per protocol under it. -/
example :
    modelRequests (connectionFor .anthropicMessages "http://gateway:8787/" "run-token") =
        [("http://gateway:8787/v1/messages", "Bearer run-token")] ∧
      modelRequests (connectionFor .openaiResponses "http://gateway:8787" "run-token") =
        [("http://gateway:8787/v1/responses", "Bearer run-token")] ∧
      modelRequests (connectionFor .openaiChatCompletions "http://gateway:8787" "run-token") =
        [("http://gateway:8787/v1/chat/completions", "Bearer run-token")] := by decide

/-- The model of every accepted agent is the explicit provider `mastraProviderSpec` decides, at
the gateway's `/v1`: built with `createAnthropic` and the token as its `authToken` exactly for the
Messages protocol, with `createOpenAI` and the token as its `apiKey` otherwise, through
`.responses()` exactly for the Responses protocol; and never a `"provider/model"` string. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-mastra.md#egress")
  (ts := "packages/engine-mastra/src/compile.ts#mastraProviderSpec")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
theorem the_model_is_an_explicit_provider_at_the_gateway {r : Request} {c : Compiled}
    (h : compile r = .ok c) :
    (∃ b t w p, r.gateway = some (b, t, w) ∧
      Behaviour.Engines.OpenAiAgents.Protocol.ofWire? w = some p ∧
      modelSpecOf c.connection = .provider (providerSpec c.connection) ∧
      (providerSpec c.connection).baseURL =
        Behaviour.Engines.OpenAiAgents.stripTrailingSlashes b ++ "/v1" ∧
      ((providerSpec c.connection).factory = .createAnthropic ↔ p = .anthropicMessages) ∧
      ((providerSpec c.connection).option = .authToken ↔ p = .anthropicMessages) ∧
      ((providerSpec c.connection).method = .responses ↔ p = .openaiResponses)) ∧
      ∀ id, modelSpecOf c.connection ≠ .routedString id := by
  obtain ⟨grants, b, t, w, p, names, tid, _, hgw, hp, _, _, _, _, rfl⟩ := compile_ok_shape h
  refine ⟨⟨b, t, w, p, hgw, hp, rfl, ?_⟩, fun id => ?_⟩
  · cases p <;> simp [compileWith, connectionFor, providerSpec, apiFor]
  · simp [modelSpecOf]

/-- Observability and telemetry exporters are off for every compiled agent, and — whatever the
runner's process environment held, the switches included with other values — the environment
Mastra loads under says `MASTRA_TELEMETRY_DISABLED=1` and `MASTRA_OFFLINE=1`, and keeps every other
variable but an empty provider base URL. That no `Mastra` instance is constructed is the module
header's hypothesis, enforced by the boundary suite. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-mastra.md#observability")
  (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")
  (ts := "packages/engine-mastra/src/boundary.ts#mastraInstalledEnvironment")
  (ts := "packages/engine-mastra/src/boundary.ts#startMastraRun")]
theorem observability_is_off_for_every_compiled_agent {r : Request} {c : Compiled}
    (h : compile r = .ok c) :
    c.observability.telemetry = false ∧ c.observability.exporters = [] ∧
      ∀ env : List (String × String),
        (installedEnvironment env).lookup "MASTRA_TELEMETRY_DISABLED" = some "1" ∧
        (installedEnvironment env).lookup "MASTRA_OFFLINE" = some "1" ∧
        ∀ e ∈ env, keptVariable e = true → e ∈ installedEnvironment env := by
  obtain ⟨grants, b, t, w, p, names, tid, _, _, _, _, _, _, _, rfl⟩ := compile_ok_shape h
  refine ⟨rfl, rfl, fun env => ⟨?_, ?_, fun e he hk => ?_⟩⟩
  · rfl
  · rfl
  · exact List.mem_append_right _ (List.mem_filter.mpr ⟨he, hk⟩)

/-- Witness: a runner environment that turned telemetry on, and an empty provider base URL, are
overridden and removed; an unrelated variable is kept. -/
example :
    installedEnvironment
        [("MASTRA_TELEMETRY_DISABLED", "0"), ("ANTHROPIC_BASE_URL", ""), ("HOME", "/root")] =
      [("MASTRA_TELEMETRY_DISABLED", "1"), ("MASTRA_OFFLINE", "1"), ("HOME", "/root")] := by
  decide

/-- An accepted request's **platform** environment (`request.env`) carries no provider credential,
and no variable of it is a database connection variable by the `DATABASE_ENV` pattern
(`DATABASE_URL` or `*_DATABASE_URL`, libpq's `PG*`, `LIBSQL_*`/`TURSO_*`, in any case): memory goes
through the platform's store, so the platform's own environment holds no database to reach. This
covers only the platform's own environment: a tenant's stdio connector may still carry its own
database secret in its own `env`, merged in after this check, so a tenant's database-backed MCP
server keeps working (ADR-0084 D2; Owner decision on #309). -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-mastra.md#memory")
  (ts := "packages/engine-mastra/src/compile.ts#databaseEnvName")
  (ts := "packages/engine-mastra/src/compile.ts#compileMastraRun")]
theorem no_accepted_run_carries_a_database_credential {r : Request} {c : Compiled}
    (h : compile r = .ok c) :
    r.environmentClean = true ∧ ∀ name ∈ r.envNames, isDatabaseEnvName name = false := by
  obtain ⟨_, _, _, _, _, _, _, _, _, _, he, hd, _, _, _⟩ := compile_ok_shape h
  refine ⟨he, fun name hn => ?_⟩
  simp only [databaseEnvClean, Bool.not_eq_true', List.any_eq_false] at hd
  simpa using hd name hn

/-- Witness: the pattern names the variables a database driver reads, in any case, and not their
look-alikes. -/
example :
    isDatabaseEnvName "DATABASE_URL" = true ∧ isDatabaseEnvName "database_url" = true ∧
      isDatabaseEnvName "X_DATABASE_URL" = true ∧ isDatabaseEnvName "PGPASSWORD" = true ∧
      isDatabaseEnvName "TURSO_AUTH_TOKEN" = true ∧ isDatabaseEnvName "LIBSQL_URL" = true ∧
      isDatabaseEnvName "_DATABASE_URL" = false ∧ isDatabaseEnvName "DATABASE_URLS" = false ∧
      isDatabaseEnvName "PGDATA" = false ∧ isDatabaseEnvName "TURSO_" = false ∧
      isDatabaseEnvName "X-DATABASE_URL" = false := by
  decide

end AgentWorkspace.Theorems.Adversarial.Mastra
