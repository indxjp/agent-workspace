import AgentWorkspace.Theorems.Adversarial.PathGrant

import AgentWorkspace.Behaviour.Engines.Pi

/-!
# T3 — the pi adapter against a hostile agent (ENG-08, #307)

Three properties a model under the agent's control, or a hostile file on the host, must not be able
to break:

* **path grants** — no write the guard permits lands inside a read-only grant, however the path is
  spelled (relative, through `..`, or absolute under the sandbox root, which the guard resolves
  first); the grants it enforces are exactly the request's, normalised;
* **egress** — every model request the compiled configuration can issue targets the gateway's base
  URL, carries the run token as `Authorization: Bearer`, and the configuration names no other
  model endpoint; the key pi insists on is the public placeholder;
* **the pinned loader** — pi is handed only the skills and instructions the platform materialised
  (a set built from the compiled configuration, not from what the host presents), and never
  anything under `~/.pi`, under `~/.agents` or from project discovery.

What pi does with the configuration is a hypothesis (see `Behaviour/Engines/Pi.lean`) enforced by
the package's boundary suite, which runs real pi against a fake gateway and a hostile home.
-/

namespace AgentWorkspace.Theorems.Adversarial.Pi

open AgentWorkspace AgentWorkspace.Authz.PathGrant AgentWorkspace.Behaviour.Engines.Pi

/-- A `write` or `edit` the guard lets through is one `workspaceWriteVerdict` allows. -/
private theorem guard_write_is_the_grant_check (c : Compiled) (name p : String)
    (hn : name = "write" ∨ name = "edit") (hg : guard c name (some p) = true) :
    writeAllowed c p = true := by
  unfold Behaviour.Engines.Pi.guard at hg
  split at hg
  · cases hg
  · rename_i heq
    have := List.find?_some heq
    rcases hn with rfl | rfl <;> simp [Tool.name] at this
  · rename_i heq
    have := List.find?_some heq
    rcases hn with rfl | rfl <;> simp [Tool.name] at this
  · exact hg

/-- A write `workspaceWriteVerdict` allows resolved to a workspace-relative path — neither a
rewritten spelling nor the root — and that path passed `writeGrantVerdict`. -/
private theorem allowed_write_resolves (c : Compiled) (candidate : String)
    (hw : writeAllowed c candidate = true) :
    ∃ relative segments, resolveWorkspacePath c.cwd candidate = .relative relative ∧
      writeGrantVerdict (some protectedDirectory) c.grants relative = .ok segments := by
  unfold writeAllowed workspaceWriteVerdict at hw
  cases hr : resolveWorkspacePath c.cwd candidate with
  | rewritten => simp [hr, WriteVerdict.isOk] at hw
  | root => simp [hr, WriteVerdict.isOk] at hw
  | relative relative =>
    rw [hr] at hw
    cases hv : writeGrantVerdict (some protectedDirectory) c.grants relative with
    | refused _ => simp [hv, WriteVerdict.isOk] at hw
    | ok segments => exact ⟨relative, segments, rfl, hv⟩

/-- No write the guard permits lands inside a read-only grant of the request, however the path is
spelled — relative, or absolute under the sandbox root: the grants it enforces are the request's
own, normalised; the root it resolves against is the request's `cwd`; an allowed `write` or `edit`
resolved to a workspace-relative path, and that path normalises outside every read-only grant. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-pi.md#path-grants")
  (ts := "packages/engine-pi/src/workspace.ts#piToolCallVerdict")
  (ts := "packages/engine-pi/src/workspace.ts#resolveWorkspacePath")
  (ts := "packages/engine-pi/src/guard.ts#resolvedPathVerdict")]
theorem no_permitted_write_lands_in_a_read_only_grant {r : Request} {c : Compiled}
    (h : compile r = .ok c) (name candidate : String) (hn : name = "write" ∨ name = "edit")
    (hallow : guard c name (some candidate) = true) :
    normaliseGrants (some protectedDirectory) r.grants = some c.grants ∧
      c.cwd = Behaviour.Engines.OpenAiAgents.stripTrailingSlashes r.cwd ∧
      ∃ relative segments, resolveWorkspacePath c.cwd candidate = .relative relative ∧
        writeGrantVerdict (some protectedDirectory) c.grants relative = .ok segments ∧
        ∀ g ∈ c.grants, g.readOnly = true → covers g segments = false := by
  obtain ⟨grants, b, t, hg, _, _, rfl⟩ := compile_ok_shape h
  refine ⟨hg, rfl, ?_⟩
  obtain ⟨relative, segments, hr, hv⟩ :=
    allowed_write_resolves _ _ (guard_write_is_the_grant_check _ _ _ hn hallow)
  exact ⟨relative, segments, hr, hv,
    Adversarial.PathGrant.allowed_write_is_outside_every_read_only_grant _ _ _ _ hv⟩

/-- Witness: a read-only `docs` grant refuses every spelling of a write under it — relative,
through `..`, and absolute under the sandbox root — the adapter's own `.pi` directory is refused,
a rewritten spelling (`~`, `@`, a Unicode space) and the root itself are refused, an absolute path
outside the root is refused, and a sibling path stays writable relative or absolute; `read` opens
the root. -/
example :
    let c : Compiled :=
      { cwd := "/workspace", tools := [.read, .write, .edit], networkEgress := false,
        connection := connectionFor "http://gw" "tok", model := "claude-sonnet-4-5",
        maxTurns := none, budgetCap := false,
        grants := [{ directory := true, segments := ["docs"], readOnly := true }], skills := [] }
    guard c "write" (some "docs/a.md") = false ∧ guard c "edit" (some "x/../docs/a.md") = false ∧
      guard c "write" (some "/workspace/docs/a.md") = false ∧
      guard c "write" (some ".pi/skills/x/SKILL.md") = false ∧
      guard c "write" (some "~/x") = false ∧ guard c "write" (some "@docs-private/a.md") = false ∧
      guard c "write" (some "docs-private/a\u00A0b.md") = false ∧
      guard c "write" (some "/workspace") = false ∧ guard c "write" (some ".") = false ∧
      guard c "write" (some "/workspacex/a.md") = false ∧
      guard c "write" (some "docs-private/a.md") = true ∧
      guard c "write" (some "/workspace/docs-private/a.md") = true ∧
      guard c "read" (some ".") = true ∧ guard c "read" (some "/workspace/") = true ∧
      guard c "read" (some "/etc/passwd") = false := by decide +kernel

/-- A write to the workspace root itself is refused with its own reason, not as a grant refusal. -/
example :
    let c : Compiled :=
      { cwd := "/workspace", tools := [.write], networkEgress := false,
        connection := connectionFor "http://gw" "tok", model := "claude-sonnet-4-5",
        maxTurns := none, budgetCap := false, grants := [], skills := [] }
    workspaceWriteVerdict c "/workspace/" = .refused .workspaceRoot ∧
      workspaceWriteVerdict c "~/x" = .refused .rewrittenSpelling := by decide +kernel

/-- Every model request an accepted configuration can issue targets the gateway's base URL plus
`/v1/messages`, carries the run token as `Authorization: Bearer`, and there is exactly one such
endpoint; the key the provider is given is the public placeholder, never the token. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-pi.md#egress")
  (ts := "packages/engine-pi/src/compile.ts#piModelConnection")
  (ts := "packages/engine-pi/src/boundary.ts#startPiRun")]
theorem every_model_request_goes_to_the_gateway_with_the_run_token {r : Request} {c : Compiled}
    (h : compile r = .ok c) :
    ∃ b t, r.gateway = some (b, t, "anthropic-messages") ∧
      (modelRequests c.connection).length = 1 ∧
      (∀ req ∈ modelRequests c.connection,
        req.1 = Behaviour.Engines.OpenAiAgents.stripTrailingSlashes b ++ "/v1/messages" ∧
        req.2 = "Bearer " ++ t) ∧
      c.connection.apiKey = apiKeyPlaceholder := by
  obtain ⟨grants, b, t, _, hgw, _, rfl⟩ := compile_ok_shape h
  refine ⟨b, t, hgw, rfl, ?_, rfl⟩
  intro req hreq
  simp only [compileWith, connectionFor, modelRequests, List.mem_singleton] at hreq
  subst hreq
  exact ⟨rfl, rfl⟩

/-- Witness: a base URL with a trailing slash still yields one `/v1/messages` request under it. -/
example :
    modelRequests (connectionFor "http://gateway:8787/" "run-token") =
      [("http://gateway:8787/v1/messages", "Bearer run-token")] := by decide +kernel

/-- The pinned resource loader admits only what the platform materialised for this run — built
from the compiled configuration alone: a placed skill the run grants, or the agent's instructions —
and never anything under `~/.pi`, under `~/.agents` or from project discovery, whatever is present
on the host. -/
@[aw_spec (tier := T3) (doc := "docs/formal/units/engine-pi.md#loader")
  (ts := "packages/engine-pi/src/boundary.ts#startPiRun")]
theorem the_pinned_loader_admits_only_platform_resources (c : Compiled)
    (present : List Resource) :
    (∀ res ∈ pinnedLoad c present, res ∈ materialised c) ∧
      ∀ res ∈ pinnedLoad c present,
        res.source ≠ .piHome ∧ res.source ≠ .agentsHome ∧ res.source ≠ .project := by
  have hsub : ∀ res ∈ pinnedLoad c present, res ∈ materialised c := by
    intro res hres
    simp only [pinnedLoad, List.mem_append, List.mem_filter, List.mem_singleton,
      Bool.and_eq_true, beq_iff_eq] at hres
    simp only [materialised, List.mem_append, List.mem_map, List.mem_singleton]
    rcases hres with ⟨_, hsrc, hname⟩ | hinst
    · left
      refine ⟨res.name, by simpa using hname, ?_⟩
      cases res
      simp_all
    · exact Or.inr hinst
  refine ⟨hsub, fun res hres => ?_⟩
  have hm := hsub res hres
  simp only [materialised, instructions, List.mem_append, List.mem_map, List.mem_singleton] at hm
  rcases hm with ⟨_, _, rfl⟩ | rfl <;> simp

/-- Witness: of a host carrying a hostile extension in `~/.pi`, a skill in `~/.agents`, a project
skill, a planted instructions file and the platform's own skills, the loader returns only the
granted skill and the platform's instructions. -/
example :
    let c : Compiled :=
      { cwd := "/workspace", tools := [], networkEgress := false,
        connection := connectionFor "http://gw" "tok", model := "claude-sonnet-4-5",
        maxTurns := none, budgetCap := false, grants := [], skills := ["writer"] }
    pinnedLoad c
        [⟨.piHome, "evil-extension"⟩, ⟨.agentsHome, "evil-skill"⟩, ⟨.project, "project-skill"⟩,
         ⟨.platformSkill, "writer"⟩, ⟨.platformSkill, "not-granted"⟩,
         ⟨.platformInstructions, "planted"⟩] =
      [⟨.platformSkill, "writer"⟩, instructions] := by decide +kernel

end AgentWorkspace.Theorems.Adversarial.Pi
