import AgentWorkspace.Theorems.Adversarial.AuthzRunToken

namespace AgentWorkspace.Theorems.Refinement.AuthzRunToken

open AgentWorkspace.Authz.RunToken

private def terminalRunToken : BrowserResolutionInput :=
  { scope := .run, tokenFound := true, workspaceFound := true, targetFound := true, runTerminal := true, sessionArchived := false, minterFound := true }

/-- Today's token resolution is a subset of read access to the documented scoped run. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")]
theorem current_refines_read_target (input : BrowserResolutionInput) :
    browserCurrent input = true → browserReadTarget input = true := by
  cases input with
  | mk scope tokenFound workspaceFound targetFound runTerminal sessionArchived minterFound =>
    cases scope <;> simp_all [browserCurrent, browserReadTarget, Bool.and_eq_true]

/-- The terminal run witness for SPEC §3.1.1's read/follow promise and `waitForOutcome`'s final
read. The current resolver rejects it before route-level scope checks run. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/04-api-specification.md#311-browser-tokens-issue-236-sdk-04-s-1")
  (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")]
theorem terminal_run_read_diverges :
    browserCurrent terminalRunToken = false ∧ browserReadTarget terminalRunToken = true := by decide

/-- Both current and target rules refuse an archived session token. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/composition/session-rbac.ts#resolveBrowserTokenActor")]
theorem archived_session_agrees :
    browserCurrent { scope := .session, tokenFound := true, workspaceFound := true, targetFound := true, runTerminal := false, sessionArchived := true, minterFound := true } = false ∧
    browserReadTarget { scope := .session, tokenFound := true, workspaceFound := true, targetFound := true, runTerminal := false, sessionArchived := true, minterFound := true } = false := by decide

end AgentWorkspace.Theorems.Refinement.AuthzRunToken
