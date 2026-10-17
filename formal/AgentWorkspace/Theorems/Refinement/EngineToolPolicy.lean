import AgentWorkspace.Behaviour.EngineToolPolicy

/-!
# T4 — the tool mapping moved without changing what it compiles (ENG-04b, #325)

This unit's defining constraint is *"the compiled SDK options and the `agent.*` frames must stay
byte-identical to main for every existing vector"*, and the issue asks for it as a theorem: *"the
adapter's compiled tool policy equals the policy compose produced before the move, for every
portable input in the vectors."*

`Behaviour/EngineToolPolicy.lean` models both computations — `composeCurrent` as
`apps/web/server/compose/run-request.ts` performed it, `adapterTarget` as
`packages/engine-claude-agent-sdk/src/tools.ts` performs it — and the refinement below is an
**equality of the whole policy record**, over every input `cases` enumerates. Not a containment and
not a set equality: `allowedTools` and `disallowedTools` reach the SDK as JSON arrays, so a
reordering is a different byte stream even though it is the same permission set, and an
order-insensitive theorem could not have seen one.

Three further statements sit beside it, and each is a claim the equality alone does not make:

* the permission floor survives *every* stored policy, which is ADR
  `SDK-02-AGENT-POLICY-234-stored-policy-is-a-narrowing-jsonb-column`'s rule and the reason the
  adapter unions rather than defaults;
* the compose-side legacy guard (`applyFileGrantPolicy`) changes nothing — which is what makes it
  removable, and what `docs/adr/0072-the-claude-tool-mapping-and-skills-live-in-the-claude-adapter.md`
  records the condition for;
* a run with no stored policy and no grant compiles the bare permission floor, which is the vacuity
  control: a model in which everything denied everything would satisfy the three above.
-/

namespace AgentWorkspace.Theorems.Refinement.EngineToolPolicy

open AgentWorkspace.Behaviour.EngineToolPolicy AgentWorkspace.Behaviour.RunCompose

/-- **The refinement.** For every input the platform can compose, the Claude adapter's compiled
tool policy is the policy compose produced before ENG-04b — the same lists, in the same order. -/
@[aw_spec (tier := T4) (doc := "docs/formal/units/run-compose.md#theorems-and-vectors")
  (ts := "packages/engine-claude-agent-sdk/src/tools.ts#compileClaudeToolPolicy")
  (ts := "apps/web/server/compose/run-request.ts#portableAgentConfigFor")]
theorem adapter_matches_compose_on_every_case :
    cases.all (fun c => target c == current c) = true := by decide

/-- A worked witness, written out rather than quantified: the stored arm first, then the permission
floor, then the read-only grant's denials. The order is the compatibility surface. -/
@[aw_spec (tier := T4)
  (ts := "packages/engine-claude-agent-sdk/src/tools.ts#compileClaudeToolPolicy")]
theorem a_stored_policy_with_a_grant_compiles_in_the_documented_order :
    let c : Case :=
      { id := "witness"
        permissions :=
          { readFiles := true, writeFiles := false, runCommands := true,
            unrestrictedNetwork := true }
        stored := some
          { base := none, autoApprove := [], deny := ["WebFetch"], permissionMode := "default",
            allowDangerouslySkipPermissions := false }
        mcpServers := ["github"], cwd := "/w", readOnly := [("docs", true)], guarded := true }
    (target c).deny =
      ["WebFetch", "Write", "Edit", "NotebookEdit", "Edit(//w/docs/**)", "Bash", "BashOutput",
       "KillShell"] ∧
    (target c).autoApprove = ["mcp__github__*"] ∧
    target c = current c := by decide

/-- A stored policy narrows and never widens: every tool the permission switches deny is still
denied, whatever the stored arm says. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/SDK-02-AGENT-POLICY-234-stored-policy-is-a-narrowing-jsonb-column.md")
  (ts := "packages/engine-claude-agent-sdk/src/tools.ts#compileClaudeToolPolicy")]
theorem the_permission_floor_survives_every_stored_policy :
    cases.all (fun c => (toolDeny c.permissions).all (target c).deny.contains) = true := by decide

/-- The compose-side legacy guard changes nothing: a request carrying `applyFileGrantPolicy`'s
denials and the same request without them compile to the same options.

That is what makes the guard removable rather than load-bearing, and it is the half of ENG-04b's
"byte-identical" claim that covers a control plane and a runner deployed at different versions. -/
@[aw_spec (tier := T4)
  (ts := "apps/web/server/compose/run-request.ts#applyFileGrantPolicy")
  (ts := "packages/engine-claude-agent-sdk/src/tools.ts#claudeFileGrantDenials")]
theorem the_compose_side_guard_changes_nothing :
    cases.all (fun c => target { c with guarded := true } == target { c with guarded := false }) =
      true := by decide

/-- The vacuity control: an unrestricted agent with no stored policy and no grant compiles to the
empty narrowing, so the theorems above are not satisfied by a model that denies everything. -/
@[aw_spec (tier := T4)
  (ts := "packages/engine-claude-agent-sdk/src/tools.ts#compileClaudeToolPolicy")]
theorem an_unrestricted_agent_compiles_the_empty_narrowing :
    let c : Case :=
      { id := "unrestricted"
        permissions :=
          { readFiles := true, writeFiles := true, runCommands := true,
            unrestrictedNetwork := true }
        stored := none, mcpServers := [], cwd := "/w", readOnly := [], guarded := false }
    target c = floor ∧ current c = floor := by decide

/-- Every ceiling's permission caps: all sixteen subsets of `AGENT_PERMISSION_KEYS`. -/
private def masks : List (List String) :=
  AgentWorkspace.Concepts.Agent.permissionKeys.foldr (fun k acc => acc ++ acc.map (k :: ·)) [[]]

/-- `k` with its permissions met against a ceiling that caps exactly `caps` (S2-04c). -/
private def metCase (k : Case) (caps : List String) : Case :=
  let e : AgentWorkspace.Concepts.PolicyCeiling.Config :=
    { permissions := k.permissions.toAgent, maxTurns := none, maxBudget := none, engine := "",
      model := none, tools := [] }
  let c : AgentWorkspace.Concepts.PolicyCeiling.Ceiling :=
    { caps, maxTurns := none, maxBudget := none, engines := none, models := none, tools := none,
      minEvalScore := none }
  { k with permissions := Permissions.ofAgent (AgentWorkspace.Concepts.PolicyCeiling.meet e (some c)).permissions }

/-- The ceiling's meet keeps the deny list's byte order (S2-04c). For every case and every one of
the sixteen permission caps, the met run still compiles in the adapter exactly as compose did, its
deny list still starts with the stored arm's own denials, and every tool the unmet permissions
denied is still denied: the meet only turns switches off. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md#slice-2-acceptance")
  (ts := "packages/engine-claude-agent-sdk/src/tools.ts#compileClaudeToolPolicy")
  (ts := "apps/web/server/compose/run-request.ts#meetRunCeiling")]
theorem the_meet_keeps_the_deny_byte_order :
    cases.all (fun k => masks.all (fun m =>
      target (metCase k m) == current (metCase k m) &&
      (k.stored.getD floor).deny.eraseDups.isPrefixOf (target (metCase k m)).deny &&
      (toolDeny k.permissions).all (target (metCase k m)).deny.contains)) = true := by decide

end AgentWorkspace.Theorems.Refinement.EngineToolPolicy
