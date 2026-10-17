import AgentWorkspace.Behaviour.RunCompose

/-!
# The Claude tool policy, before and after the move (ENG-04b, #325)

ENG-04 (#324) left two Claude-shaped decisions in applications that are not allowed to know an
engine exists, and recorded them as its Deviations 7 and 8. This module models the first of them:
the **tool policy** — which of the Claude Agent SDK's own tool names a run ends up with, derived
from §17 Step 4's four permission switches, the agent's stored policy arm, its assigned connectors
and its read-only file grants.

Until this unit that derivation was `apps/web/server/compose/run-request.ts`'s `toolPolicyFor` /
`agentConfigFor` / `applyFileGrantPolicy`; now it is
`packages/engine-claude-agent-sdk/src/tools.ts`'s `compileClaudeToolPolicy`. **Nothing about what
it computes changed**, and that is the claim `Theorems/Refinement/EngineToolPolicy.lean` states.

## Why both versions are modelled, and why the equality is over arrays

`docs/formal/README.md` asks that where today's code and the target differ, both are modelled and
related. They differ in *where the derivation runs* and in *what crosses the private `/run`
contract*, and not at all in the answer — so {@link composeCurrent} is the pre-ENG-04b computation
and {@link adapterTarget} is the adapter's, and the refinement is an equality.

The equality is over **lists, in order**, not over sets. `allowedTools` and `disallowedTools` reach
the SDK as JSON arrays; two arrays with the same members in a different order are the same policy
to the SDK and a different byte stream on the wire, and this unit's acceptance criterion is *"the
compiled SDK options are byte-identical to main for every existing vector"*. An order-insensitive
theorem would not have been able to see a reordering.

## The one thing the model takes as given

`mcpApprovals` maps a list of connector record keys to `mcp__<key>__*` in the order it is handed
them. The TypeScript sorts the keys first (`Object.keys(...).toSorted()`), because a JavaScript
object's key order is an accident of how the record was built and `allowedTools` is compared byte
for byte. That sort is a property of the *record*, not of the mapping, so it is asserted by
`packages/engine-claude-agent-sdk/src/tools.test.ts` and the vectors here carry keys already in
sorted order.
-/

namespace AgentWorkspace.Behaviour.EngineToolPolicy

open AgentWorkspace AgentWorkspace.Behaviour.RunCompose

/-- The Claude tool policy, as both the old compose path and the new adapter produce one.

`base` is the SDK's `tools`: `none` is the `claude_code` preset (the platform's own default) and
`some names` is an explicit allow-list a stored policy chose. -/
structure ToolPolicy where
  base : Option (List String)
  autoApprove : List String
  deny : List String
  permissionMode : String
  allowDangerouslySkipPermissions : Bool
  deriving DecidableEq, Repr, Inhabited

/-- The policy an agent with **no** stored one starts from: the preset, no approval, no denial.

Exactly `packages/engine-claude-agent-sdk/src/tools.ts`'s `CLAUDE_TOOL_POLICY_FLOOR`, and exactly
what `packages/contracts/src/agents.ts`' `claudeBaseToolPolicyFor` answers before the permission
denials are folded in. `permissionMode` is `default` because every other mode is a decision a
screen has to offer first. -/
def floor : ToolPolicy :=
  { base := none, autoApprove := [], deny := [], permissionMode := "default",
    allowDangerouslySkipPermissions := false }

/-- `mcp__<server>__*` for every connector assigned to this run. See the header's last section. -/
def mcpApprovals (servers : List String) : List String :=
  servers.map fun name => "mcp__" ++ name ++ "__*"

/-- The Claude denials one run's read-only file grants produce, as a list on its own.

`RunCompose.fileGrantDeny` is the same rules folded *into* an existing list, which is the shape the
old compose path needed (it edited an agent configuration in place). The adapter needs them as a
value it can append, so they are stated once here and both versions below use them. -/
def grantDenials (cwd : String) (readOnlyPaths : List (String × Bool)) : List String :=
  if readOnlyPaths.isEmpty then []
  else
    (readOnlyPaths.flatMap fun (path, isDirectory) =>
        let full := cwd ++ "/" ++ path ++ (if isDirectory then "/**" else "")
        ["Edit(/" ++ full ++ ")"]) ++
      ["Bash", "BashOutput", "KillShell"]

/-- **Current**: the policy `apps/web/server/compose/run-request.ts` produced before ENG-04b.

`agentConfigFor` computed the floor, branched on whether the agent had a stored policy, unioned the
two `deny` lists with the stored one first, appended the connector approvals, and then
`applyFileGrantPolicy` folded the read-only grants in on top. This is that, in order. -/
def composeCurrent (permissions : Permissions) (stored : Option ToolPolicy)
    (mcpServers : List String) (cwd : String) (readOnlyPaths : List (String × Bool)) : ToolPolicy :=
  let approvals := mcpApprovals mcpServers
  let withFloor : ToolPolicy :=
    match stored with
    | none =>
      { base := none, autoApprove := approvals, deny := toolDeny permissions,
        permissionMode := "default", allowDangerouslySkipPermissions := false }
    | some p =>
      { base := p.base, autoApprove := (p.autoApprove ++ approvals).eraseDups,
        deny := agentDeny permissions p.deny, permissionMode := p.permissionMode,
        allowDangerouslySkipPermissions := p.allowDangerouslySkipPermissions }
  { withFloor with deny := fileGrantDeny withFloor.deny cwd readOnlyPaths }

/-- **Target**: the policy `compileClaudeToolPolicy` compiles, inside the Claude adapter.

One expression rather than a branch: the absent stored arm is {@link floor}, which is the empty
narrowing, so "no stored policy" and "a stored policy that narrows nothing" are the same input. The
order of the four sources is the compatibility surface — stored, then the permission floor, then
whatever the compose-side guard put on the wire, then this adapter's own grant denials — and
de-duplication keeps the first occurrence of each rule. -/
def adapterTarget (permissions : Permissions) (stored : Option ToolPolicy)
    (mcpServers : List String) (wireFileGrantDeny : List String) (cwd : String)
    (readOnlyPaths : List (String × Bool)) : ToolPolicy :=
  let p := stored.getD floor
  { base := p.base,
    autoApprove := (p.autoApprove ++ mcpApprovals mcpServers).eraseDups,
    deny :=
      (p.deny ++ toolDeny permissions ++ wireFileGrantDeny ++ grantDenials cwd readOnlyPaths).eraseDups,
    permissionMode := p.permissionMode,
    allowDangerouslySkipPermissions := p.allowDangerouslySkipPermissions }

/-! ## The inputs the refinement is decided over

A refinement theorem stated only in general would be the weaker claim here: the two computations
are *written* differently (a branch against a `getD`, a fold against a concatenation), and what has
to hold is that they agree on every input the platform can compose. So the inputs are enumerated —
one case per shape a real request can have — and the theorem is decided over all of them, which is
also what makes them replayable vectors against the real TypeScript.
-/

/-- One input to both computations, plus whether the compose-side guard sent its denials. -/
structure Case where
  id : String
  permissions : Permissions
  stored : Option ToolPolicy
  /-- Connector record keys, already sorted. See the header. -/
  mcpServers : List String
  cwd : String
  /-- Read-only grants, as `(workspace-relative path, is a directory)`. -/
  readOnly : List (String × Bool)
  /-- `true` models a body carrying `applyFileGrantPolicy`'s denials; `false` a body without them. -/
  guarded : Bool
  deriving DecidableEq, Repr

/-- What the compose-side guard put on the wire for this case. -/
def wireFileGrantDeny (c : Case) : List String :=
  if c.guarded then grantDenials c.cwd c.readOnly else []

/-- The adapter's answer for one case. -/
def target (c : Case) : ToolPolicy :=
  adapterTarget c.permissions c.stored c.mcpServers (wireFileGrantDeny c) c.cwd c.readOnly

/-- What compose answered for the same case, before ENG-04b. -/
def current (c : Case) : ToolPolicy :=
  composeCurrent c.permissions c.stored c.mcpServers c.cwd c.readOnly

private def allOn : Permissions :=
  { readFiles := true, writeFiles := true, runCommands := true, unrestrictedNetwork := true }

private def allOff : Permissions :=
  { readFiles := false, writeFiles := false, runCommands := false, unrestrictedNetwork := false }

/-- A stored arm that narrows: an explicit tool allow-list, one approval, one denial, `dontAsk`. -/
private def storedNarrowing : ToolPolicy :=
  { base := some ["Read", "Grep"], autoApprove := ["Read"], deny := ["WebFetch"],
    permissionMode := "dontAsk", allowDangerouslySkipPermissions := false }

private def sandbox : String := "/workspace/tenant-a/session-1"

/-- Every shape a composed request can have, in the order a reader should meet them. -/
def cases : List Case :=
  [{ id := "unrestricted", permissions := allOn, stored := none, mcpServers := [],
     cwd := sandbox, readOnly := [], guarded := false },
   { id := "every-permission-off", permissions := allOff, stored := none, mcpServers := [],
     cwd := sandbox, readOnly := [], guarded := false },
   { id := "no-shell", permissions := { allOn with runCommands := false }, stored := none,
     mcpServers := [], cwd := sandbox, readOnly := [], guarded := false },
   { id := "connectors", permissions := allOn, stored := none,
     mcpServers := ["asana", "github", "zulip"], cwd := sandbox, readOnly := [],
     guarded := false },
   { id := "stored-policy", permissions := { allOn with runCommands := false },
     stored := some storedNarrowing, mcpServers := [], cwd := sandbox, readOnly := [],
     guarded := false },
   { id := "stored-policy-and-connectors", permissions := { allOn with runCommands := false },
     stored := some storedNarrowing, mcpServers := ["github"], cwd := sandbox, readOnly := [],
     guarded := false },
   { id := "stored-denial-already-in-the-floor",
     permissions := { allOn with runCommands := false },
     stored := some { storedNarrowing with deny := ["Bash", "WebFetch"] }, mcpServers := [],
     cwd := sandbox, readOnly := [], guarded := false },
   { id := "read-only-file-guarded", permissions := allOn, stored := none, mcpServers := [],
     cwd := sandbox, readOnly := [("notes/plan.md", false)], guarded := true },
   { id := "read-only-file-unguarded", permissions := allOn, stored := none, mcpServers := [],
     cwd := sandbox, readOnly := [("notes/plan.md", false)], guarded := false },
   { id := "read-only-directory-guarded", permissions := allOn, stored := none, mcpServers := [],
     cwd := sandbox, readOnly := [("docs", true)], guarded := true },
   { id := "two-grants-guarded", permissions := { allOn with runCommands := false },
     stored := none, mcpServers := [], cwd := sandbox,
     readOnly := [("notes/plan.md", false), ("docs", true)], guarded := true },
   { id := "stored-policy-with-grants", permissions := { allOn with writeFiles := false },
     stored := some storedNarrowing, mcpServers := ["github"], cwd := sandbox,
     readOnly := [("docs", true)], guarded := true },
   { id := "everything-off-with-grants", permissions := allOff,
     stored := some storedNarrowing, mcpServers := ["github", "zulip"], cwd := sandbox,
     readOnly := [("notes/plan.md", false), ("docs", true)], guarded := true }]

end AgentWorkspace.Behaviour.EngineToolPolicy
