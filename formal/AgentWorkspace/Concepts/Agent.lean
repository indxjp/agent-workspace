import AgentWorkspace.Concepts.Connector

/-!
# Agent — a configured agent

An **agent** is one row of `agents` (`packages/core/src/db/schema/agents.ts`): spec §17's
create flow as columns — Step 1 `name` and `instructions`, Step 2 the model pair
(`model_connection_id`, `model`), Step 4 `permissions` (and the replaced policy `policy`), Step 5
`runtime_profile_id`. Step 3 (files, skills, connectors) is not on this row: it is the three
assignment tables of `Concepts/Grant.lean`. Who may *run* the agent beyond its owner is the
fourth: `agent_grants`.

The built-in General agent is an ordinary row (§19.5 rule 3); there is no flag that marks it.

**Lifecycle.** Today an agent has one state: it exists until it is deleted, and deleting it
cascades through its assignments, grants, sessions and runs. The documented target adds
`archived` (RF-201, `POST /api/agents/:id/archive|restore`). Both are modelled; transitions are
a Phase-4 unit's.
-/

namespace AgentWorkspace.Concepts.Agent

open AgentWorkspace

/-- Spec §17 Step 4, "What can this agent do?", in the specification's order. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#AgentPermissionsSchema")
  (ts := "packages/core/src/db/schema/agents.ts#AgentPermissions")
  (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
structure Permissions where
  readFiles : Bool
  writeFiles : Bool
  runCommands : Bool
  unrestrictedNetwork : Bool
  deriving DecidableEq, Repr, Inhabited

/-- `AGENT_PERMISSION_KEYS`, in order. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#AGENT_PERMISSION_KEYS")]
def permissionKeys : List String := ["readFiles", "writeFiles", "runCommands", "unrestrictedNetwork"]

/-- The HTTP bounds (`AGENT_NAME_MAX_LENGTH`, `AGENT_INSTRUCTIONS_MAX_LENGTH`,
`AGENT_MODEL_MAX_LENGTH`), in JavaScript string code units. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#AGENT_NAME_MAX_LENGTH")
  (ts := "packages/contracts/src/agents.ts#AGENT_INSTRUCTIONS_MAX_LENGTH")
  (ts := "packages/contracts/src/agents.ts#AGENT_MODEL_MAX_LENGTH")]
def bounds : Nat × Nat × Nat := (200, 100000, 200)

/-! ## The HTTP field parsers (`packages/contracts/src/agents/resource.ts`) -/

/-- A raw JSON value as the field parsers see it: a string, `null`, or another value, carried as
the text `describe()` renders for it (`a number`, `a boolean`, `an array`, `an object`,
`a undefined`). -/
inductive RawField where
  | str (s : String)
  | null
  | nonString (described : String)
  deriving DecidableEq, Repr

/-- `describe(value)` of a value that is not a string. -/
def RawField.describe : RawField → String
  | .str _ => "a string"
  | .null => "null"
  | .nonString d => d

/-- `String.prototype.trim`: drop JavaScript whitespace and line terminators at both ends. -/
def jsTrim (s : String) : String :=
  String.ofList ((s.toList.dropWhile Connector.isJsWhitespace).reverse.dropWhile
    Connector.isJsWhitespace).reverse

/-- `.length` of a JavaScript string: UTF-16 code units, two for a code point above U+FFFF. -/
def utf16Length (s : String) : Nat :=
  s.toList.foldr (fun c n => (if 0x10000 ≤ c.toNat then 2 else 1) + n) 0

/-- `AgentNameRequestSchema`: a string, trimmed, not blank, at most `AGENT_NAME_MAX_LENGTH` code units
after trimming; the trimmed value, or the one error message. -/
@[aw_spec (ts := "packages/contracts/src/agents/resource.ts#AgentNameRequestSchema")
  (ts := "packages/contracts/src/agents.ts#AGENT_NAME_MAX_LENGTH")]
def parseName : RawField → Except String String
  | .str s =>
    let t := jsTrim s
    if t.toList.isEmpty then .error "name must not be blank."
    else if bounds.1 < utf16Length t then
      .error s!"name must be at most {bounds.1} characters; received {utf16Length t}."
    else .ok t
  | r => .error s!"name must be a string; received {r.describe}."

/-- `AgentInstructionsRequestSchema`: any string, empty included and not trimmed, of at most
`AGENT_INSTRUCTIONS_MAX_LENGTH` code units. -/
@[aw_spec (ts := "packages/contracts/src/agents/resource.ts#AgentInstructionsRequestSchema")
  (ts := "packages/contracts/src/agents.ts#AGENT_INSTRUCTIONS_MAX_LENGTH")]
def parseInstructions : RawField → Except String String
  | .str s =>
    if bounds.2.1 < utf16Length s then
      .error s!"instructions must be at most {bounds.2.1} characters; received {utf16Length s}."
    else .ok s
  | r => .error s!"instructions must be a string; received {r.describe}."

/-- `AgentModelRequestSchema`: `null` (the workspace default model), or a string, trimmed, not blank, at
most `AGENT_MODEL_MAX_LENGTH` code units after trimming. -/
@[aw_spec (ts := "packages/contracts/src/agents/resource.ts#AgentModelRequestSchema")
  (ts := "packages/contracts/src/agents.ts#AGENT_MODEL_MAX_LENGTH")]
def parseModel : RawField → Except String (Option String)
  | .null => .ok none
  | .str s =>
    let t := jsTrim s
    if t.toList.isEmpty then
      .error "model must not be blank; use null to mean \"the workspace default model\"."
    else if bounds.2.2 < utf16Length t then
      .error s!"model must be at most {bounds.2.2} characters; received {utf16Length t}."
    else .ok (some t)
  | r => .error s!"model must be a string or null; received {r.describe}."

/-- One `agents` row, typed. `policyStored` says whether `policy` is non-`NULL` (a `PUT` has
replaced the policy); the policy's content is a Phase-2/3 concern. -/
@[aw_spec (ts := "packages/core/src/db/schema/agents.ts#agents")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
structure Agent where
  id : AgentId
  workspace : WorkspaceId
  name : String
  instructions : String
  modelConnection : Option ModelConnectionId
  model : Option String
  runtimeProfile : Option RuntimeProfileId
  permissions : Permissions
  policyStored : Bool
  createdBy : Option UserId
  owner : PrincipalId
  deriving DecidableEq, Repr

namespace Agent

/-- The only `agents` check that is not a key: `agents_name_not_blank`. Empty instructions are
valid ("no extra instructions"). -/
@[aw_spec (ts := "packages/core/src/db/schema/agents.ts#agents")]
def valid (a : Agent) : Bool := File.notBlank a.name

end Agent

/-- Today's lifecycle: an agent row exists (and is deleted outright). -/
@[aw_spec (ts := "packages/core/src/db/schema/agents.ts#agents")
  (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
inductive StateCurrent where
  | active
  deriving DecidableEq, Repr, Inhabited

/-- The documented target lifecycle: an agent can also be archived instead of deleted (RF-201). -/
@[aw_spec (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
inductive StateTarget where
  | active
  | archived
  deriving DecidableEq, Repr, Inhabited

/-- Today's single state is the target's `active`. -/
def StateCurrent.toTarget : StateCurrent → StateTarget
  | .active => .active

/-- The columns of `agents`, in declaration order. -/
def dbColumns : List String :=
  ["id", "workspace_id", "name", "instructions", "model_connection_id", "model",
    "runtime_profile_id", "permissions", "policy", "created_by", "owner_principal_id",
    "builtin_key", "setup_configured_at", "materialised_version_id", "created_by_agent_id",
    "created_by_agent_version", "created_by_run_id", "archived_at", "created_at", "updated_at"]

/-- The keys of `AgentResourceSchema`, in declaration order. The policy and the assignments are
separate resources (`/policy`, `/resources`), and so are the grants (`/grants`). -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#AgentResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#59-agents--awagents")]
def wireFields : List String :=
  ["id", "workspaceId", "name", "instructions", "modelConnectionId", "model", "runtimeProfileId",
    "permissions", "createdBy", "ownerPrincipalId", "builtin", "createdByAgent", "archivedAt",
    "createdAt", "updatedAt"]

/-- `AGENT_MUTABLE_FIELDS`: what `PATCH` accepts and `POST` requires. -/
@[aw_spec (ts := "packages/contracts/src/agents.ts#AGENT_MUTABLE_FIELDS")]
def mutableFields : List String :=
  ["name", "instructions", "modelConnectionId", "model", "runtimeProfileId", "permissions"]

end AgentWorkspace.Concepts.Agent
