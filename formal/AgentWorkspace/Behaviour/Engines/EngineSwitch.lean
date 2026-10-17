import AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-!
# An engine switch carries the narrowing across (ADR-0074 D12, PR #339)

`packages/contracts/src/agents.ts#translatePolicyForEngineSwitch` is the pure function the policy
route enforces when a `PUT` changes an agent's `engine`, and `aw agents update --engine` prints
before it applies it. This module models its `claude-agent-sdk → openai-agents` half, which is the
half that could widen: the Claude arm narrows with `tools.deny`, a `base` list and a
`permissionMode`, and the `openai-agents` arm narrows only by withholding permission switches.

* A rule is its text. Its **head** is everything before `(`; a rule is **untranslatable** when its
  head names an MCP tool (`mcp__…`) or carries a glob (`*`, `?`). Those are refused by name.
* A switch `k` is **allowed** by the Claude arm when every Claude tool `k` governs
  (`CLAUDE_PERMISSION_TOOL_DENIALS`) is denied by no rule, exposed by the `base` list (or the
  preset), not taken away by `plan` (writes and commands), and — under `dontAsk` — named in
  `autoApprove`. Every governed switch that is not allowed is withheld.
* The reverse half writes each withheld switch's Claude tools into `tools.deny`.

The theorems in `Theorems/Invariants/EngineSwitch.lean` state that the result never lets the
OpenAI Agents adapter's tool plan offer a tool the Claude arm did not allow.
-/

namespace AgentWorkspace.Behaviour.Engines.EngineSwitch

open AgentWorkspace.Behaviour.Engines.OpenAiAgents

/-- §17 Step 4's four switches, in `AGENT_PERMISSION_KEYS` order. -/
inductive Key where
  | readFiles
  | writeFiles
  | runCommands
  | unrestrictedNetwork
  deriving DecidableEq, Repr, Inhabited

namespace Key

def all : List Key := [readFiles, writeFiles, runCommands, unrestrictedNetwork]

/-- The key as the wire spells it. -/
def wire : Key → String
  | readFiles => "readFiles"
  | writeFiles => "writeFiles"
  | runCommands => "runCommands"
  | unrestrictedNetwork => "unrestrictedNetwork"

end Key

/-- The Claude tools each switch governs. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#CLAUDE_PERMISSION_TOOL_DENIALS")]
def claudeTools : Key → List String
  | .readFiles => ["Read", "Glob", "Grep"]
  | .writeFiles => ["Write", "Edit", "NotebookEdit"]
  | .runCommands => ["Bash", "BashOutput", "KillShell"]
  | .unrestrictedNetwork => ["WebFetch", "WebSearch"]

/-- The switch that grants each OpenAI Agents tool. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#OPENAI_AGENTS_TOOL_PERMISSION")]
def toolKey : Tool → Key
  | .readFile | .listFiles | .searchFiles => .readFiles
  | .applyPatch => .writeFiles
  | .shell => .runCommands

/-- The switches some OpenAI Agents tool governs, in key order. -/
def governedKeys : List Key := [.readFiles, .writeFiles, .runCommands]

/-- The SDK's permission modes. -/
inductive Mode where
  | default
  | acceptEdits
  | bypassPermissions
  | plan
  | dontAsk
  | auto
  deriving DecidableEq, Repr, Inhabited

/-- The Claude arm's `tools`, as far as the translation reads it. `base = none` is the preset. -/
structure ClaudeArm where
  base : Option (List String)
  autoApprove : List String
  deny : List String
  mode : Mode
  deriving DecidableEq, Repr, Inhabited

/-- A rule's tool name: everything before its `(specifier)`. -/
def headOf (rule : String) : String := (rule.splitOn "(").headD rule

/-- A denial the `openai-agents` arm has no way to say: an MCP tool or a glob. -/
def untranslatableRule (rule : String) : Bool :=
  (headOf rule).startsWith "mcp__" || (headOf rule).any (fun c => c == '*' || c == '?')

/-- Does the Claude arm let every tool of switch `k` through? -/
def keyAllowed (a : ClaudeArm) (k : Key) : Bool :=
  (claudeTools k).all fun n =>
    !(a.deny.any fun r => headOf r == n) &&
    (match a.base with
     | none => true
     | some b => b.contains n) &&
    !(a.mode == .plan && (k == .writeFiles || k == .runCommands)) &&
    !(a.mode == .dontAsk && !a.autoApprove.contains n)

/-- The switches the old arm withholds. -/
def withheldBy (a : ClaudeArm) : List Key := governedKeys.filter fun k => !keyAllowed a k

/-- The denials refused by name. -/
def untranslatable (a : ClaudeArm) : List String := a.deny.filter untranslatableRule

/-- `translatePolicyForEngineSwitch` from `claude-agent-sdk` to `openai-agents`: the withheld
switches of the new arm (those it already named, plus those the old arm withholds, in key order),
or the untranslatable denials. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#translatePolicyForEngineSwitch")]
def translate (a : ClaudeArm) (existing : List Key) : Except (List String) (List Key) :=
  if (untranslatable a).isEmpty then
    .ok (Key.all.filter fun k => existing.contains k || (withheldBy a).contains k)
  else .error (untranslatable a)

/-- The permissions a run composes under a withheld list: `policyNarrowedPermissions`. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#policyNarrowedPermissions")]
def narrow (p : Permissions) (w : List Key) : Permissions :=
  { readFiles := p.readFiles && !w.contains .readFiles,
    writeFiles := p.writeFiles && !w.contains .writeFiles,
    runCommands := p.runCommands && !w.contains .runCommands,
    unrestrictedNetwork := p.unrestrictedNetwork && !w.contains .unrestrictedNetwork }

/-- What the Claude arm allowed of an OpenAI Agents tool's capability: its switch is on and the
arm lets every Claude tool of that switch through. -/
def claudeAllowsTool (p : Permissions) (a : ClaudeArm) (t : Tool) : Bool :=
  t.permitted p && keyAllowed a (toolKey t)

/-- The reverse half: every withheld switch's Claude tools appended to `tools.deny`. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#translatePolicyForEngineSwitch")]
def reverseDeny (withheld : List Key) (deny : List String) : List String :=
  (Key.all.filter withheld.contains).foldl
    (fun acc k => acc ++ (claudeTools k).filter fun n => !acc.contains n) deny

end AgentWorkspace.Behaviour.Engines.EngineSwitch
