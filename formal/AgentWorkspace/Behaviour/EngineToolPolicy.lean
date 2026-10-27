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
  /-- The stored arm's `requireApproval` rules (ADR-0145 D3, #1300). Empty for every case before it. -/
  requireApproval : List String := []
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

/-! ## The approval gate (ADR-0145, #1300)

`allowedTools` bypasses `canUseTool`, so `packages/engine-claude-agent-sdk/src/tools.ts`'s
`splitApprovals` moves every auto-approval that could approve a gated tool out of it. Rule matching
is over `List Char` so the kernel can decide it, and globs are read the way
`packages/contracts/src/agents/tool-rules.ts`' `globMatches` reads them: `*` is any run of
characters and `?` any one, anywhere in the head (`mcp__gh__a*b` included). -/

/-- A rule's tool name: the text before `(`, as `toolRuleHead` reads it. -/
def ruleHead (rule : String) : List Char := rule.toList.takeWhile (· != '(')

/-- `TOOL_RULE_GLOB_CHARS`. -/
def isGlobChar (c : Char) : Bool := c == '*' || c == '?'

/-- Every suffix of a list, longest first: where a `*` may stop consuming. -/
def suffixes : List Char → List (List Char)
  | [] => [[]]
  | c :: cs => (c :: cs) :: suffixes cs

/-- `globMatches`: `*` is any run of characters, `?` any one, every other character itself. -/
def globMatch : List Char → List Char → Bool
  | [], t => t.isEmpty
  | p :: ps, t =>
    if p == '*' then (suffixes t).any (globMatch ps)
    else match t with
      | [] => false
      | c :: cs => (p == '?' || p == c) && globMatch ps cs

/-- A glob that matches a tool name starts with its own literal prefix. -/
theorem globMatch_literal_prefix (h t : List Char) (hm : globMatch h t = true) :
    (h.takeWhile (fun c => !isGlobChar c)).isPrefixOf t = true := by
  induction h generalizing t with
  | nil => simp
  | cons p ps ih =>
    by_cases hp : isGlobChar p = true
    · simp [List.takeWhile, hp]
    · have hstar : (p == '*') = false := by
        simp only [isGlobChar, Bool.or_eq_true, beq_iff_eq, not_or] at hp
        simpa using hp.1
      have hq : (p == '?') = false := by
        simp only [isGlobChar, Bool.or_eq_true, beq_iff_eq, not_or] at hp
        simpa using hp.2
      cases t with
      | nil => simp [globMatch, hstar] at hm
      | cons c cs =>
        simp only [globMatch, hstar, hq, Bool.false_or, Bool.and_eq_true, Bool.false_eq_true,
          ↓reduceIte] at hm
        have hpc : p = c := by simpa using hm.1
        subst hpc
        have hp' : isGlobChar p = false := by simpa using hp
        simpa [List.takeWhile, hp'] using ih cs hm.2

/-- Two prefixes of one list are prefixes of one another, one way or the other. -/
theorem prefixes_are_comparable (p q t : List Char) (hp : p.isPrefixOf t = true)
    (hq : q.isPrefixOf t = true) : (p.isPrefixOf q || q.isPrefixOf p) = true := by
  induction p generalizing q t with
  | nil => simp
  | cons a ps ih =>
    cases t with
    | nil => simp [List.isPrefixOf] at hp
    | cons b ts =>
      cases q with
      | nil => simp [List.isPrefixOf]
      | cons c qs =>
        simp only [List.isPrefixOf, Bool.and_eq_true, beq_iff_eq] at hp hq
        obtain ⟨hab, hps⟩ := hp
        obtain ⟨hcb, hqs⟩ := hq
        subst hab hcb
        simpa [List.isPrefixOf] using ih qs ts hps hqs

/-- `ruleCoversTool`: a glob head matches by pattern, any other head by equality. -/
def covers (rule : String) (tool : List Char) : Bool :=
  let h := ruleHead rule
  if h.any isGlobChar then globMatch h tool else h == tool

/-- `globPrefix`: the literal text before a glob head's first `*` or `?`, or `none` for a head that
is not a glob. -/
def globPrefix (rule : String) : Option (List Char) :=
  let h := ruleHead rule
  if h.any isGlobChar then some (h.takeWhile (fun c => !isGlobChar c)) else none

/-- `CLAUDE_EDIT_RULE_TOOLS`: Claude Code checks every built-in file write against `Edit` rules. -/
def editRuleTools : List (List Char) :=
  ["Edit", "Write", "MultiEdit", "NotebookEdit"].map String.toList

/-- What an auto-approval approves when it sits in `allowedTools`: the tools it covers, and every
file-writing tool for an `Edit` / `Edit(path)` rule. -/
def approves (rule : String) (tool : List Char) : Bool :=
  covers rule tool || (ruleHead rule == "Edit".toList && editRuleTools.any (· == tool))

/-- `approvalOverlapsGate`: each rule against the other's tool name, and an `Edit` rule against
every tool it approves. -/
def overlaps (approved gate : String) : Bool :=
  covers approved (ruleHead gate) || covers gate (ruleHead approved) ||
    (ruleHead approved == "Edit".toList && editRuleTools.any (covers gate))

/-- Does an auto-approval overlap a gated rule? `approvalOverlapsGate`, plus prefix-compatible
globs. -/
def overlapsGate (gates : List String) (rule : String) : Bool :=
  gates.any (overlaps rule) ||
    match globPrefix rule with
    | none => false
    | some p => gates.any fun g =>
        match globPrefix g with
        | none => false
        | some q => p.isPrefixOf q || q.isPrefixOf p

/-- `splitApprovals`: `(allowedTools, deferred)`. -/
def splitApprovals (autoApprove gates : List String) : List String × List String :=
  if gates.isEmpty then (autoApprove, [])
  else (autoApprove.filter (fun r => !overlapsGate gates r), autoApprove.filter (overlapsGate gates))

/-- `CLAUDE_APPROVABLE_TOOLS`: the tools the SDK asks `canUseTool` about in `default` mode. -/
def approvableTools : List String :=
  ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]

/-- Does a list contain `__`? -/
def hasDoubleUnderscore : List Char → Bool
  | '_' :: '_' :: _ => true
  | _ :: cs => hasDoubleUnderscore cs
  | [] => false

/-- `isConnectorGate`: a connector gate Claude Code's own rule matcher can match — an exact
connector tool name (no `*` or `?` after `mcp__`), or exactly `mcp__<server>__*`. -/
def connectorGate (r : String) : Bool :=
  let l := r.toList
  let rest := l.drop "mcp__".length
  let server := rest.take (rest.length - 3)
  "mcp__".toList.isPrefixOf l &&
    (!rest.any isGlobChar ||
      ("__*".toList.reverse.isPrefixOf rest.reverse && !server.any isGlobChar &&
        !hasDoubleUnderscore server))

/-- `unapprovableRules`: the gates the compile refuses — a tool `canUseTool` would never be asked
about, or a connector glob Claude Code's rules cannot match. An allowlist, so a tool a later SDK
adds is refused rather than silently ungated. -/
def unapprovable (gates : List String) : List String :=
  gates.filter fun r => !(connectorGate r || approvableTools.contains r)

/-- The compile refuses this case's gate (`engine_policy_invalid`). -/
def refused (c : Case) : Bool := !(unapprovable c.requireApproval).isEmpty

/-- The `allowedTools` the adapter emits for this case. -/
def allowed (c : Case) : List String := (splitApprovals (target c).autoApprove c.requireApproval).1

/-- The auto-approvals moved out of `allowedTools` and left to `canUseTool`. -/
def deferred (c : Case) : List String := (splitApprovals (target c).autoApprove c.requireApproval).2

private def allOn : Permissions :=
  { readFiles := true, writeFiles := true, runCommands := true, unrestrictedNetwork := true }

private def allOff : Permissions :=
  { readFiles := false, writeFiles := false, runCommands := false, unrestrictedNetwork := false }

/-- A stored arm that narrows: an explicit tool allow-list, one approval, one denial, `dontAsk`. -/
private def storedNarrowing : ToolPolicy :=
  { base := some ["Read", "Grep"], autoApprove := ["Read"], deny := ["WebFetch"],
    permissionMode := "dontAsk", allowDangerouslySkipPermissions := false }

private def sandbox : String := "/workspace/tenant-a/session-1"

/-- A stored arm that pre-approves one connector tool, in `default` mode so a gate can ask. -/
private def storedConnectorSearch : ToolPolicy :=
  { storedNarrowing with autoApprove := ["Read", "mcp__jira__search"], permissionMode := "default" }

/-- A stored arm that pre-approves built-in tools, one of them scoped. -/
private def storedBuiltins : ToolPolicy :=
  { base := none, autoApprove := ["Bash(git status)", "Read", "WebFetch"], deny := [],
    permissionMode := "default", allowDangerouslySkipPermissions := false }

/-- A stored arm that pre-approves edits under the workspace and an inner-glob connector rule. -/
private def storedEdits : ToolPolicy :=
  { base := none,
    autoApprove := ["Edit(//workspace/tenant-a/session-1/**)", "mcp__github__list*s", "Read"],
    deny := [], permissionMode := "default", allowDangerouslySkipPermissions := false }

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
     readOnly := [("notes/plan.md", false), ("docs", true)], guarded := true },
   { id := "gate-a-connector-tool", permissions := allOn, stored := none,
     mcpServers := ["github", "jira"], cwd := sandbox, readOnly := [], guarded := false,
     requireApproval := ["mcp__github__create_issue"] },
   { id := "gate-a-whole-connector", permissions := allOn,
     stored := some storedConnectorSearch,
     mcpServers := ["github", "jira"], cwd := sandbox, readOnly := [], guarded := false,
     requireApproval := ["mcp__jira__*"] },
   { id := "gate-a-builtin", permissions := allOn,
     stored := some storedBuiltins,
     mcpServers := [], cwd := sandbox, readOnly := [], guarded := false,
     requireApproval := ["Bash", "Write"] },
   { id := "gate-read-is-refused", permissions := allOn, stored := none, mcpServers := [],
     cwd := sandbox, readOnly := [], guarded := false, requireApproval := ["Read"] },
   { id := "gate-glob-is-refused", permissions := allOn, stored := none, mcpServers := ["github"],
     cwd := sandbox, readOnly := [], guarded := false,
     requireApproval := ["mcp__github__*", "Glob"] },
   { id := "gate-write-moves-the-edit-rule", permissions := allOn,
     stored := some storedEdits,
     mcpServers := ["github"], cwd := sandbox, readOnly := [], guarded := false,
     requireApproval := ["Write", "mcp__github__create_issue"] },
   { id := "gate-partial-connector-glob-is-refused", permissions := allOn, stored := none,
     mcpServers := ["github"], cwd := sandbox, readOnly := [], guarded := false,
     requireApproval := ["mcp__github__*_issue"] }]

end AgentWorkspace.Behaviour.EngineToolPolicy
