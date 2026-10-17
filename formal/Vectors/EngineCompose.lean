import AgentWorkspace.Theorems.Normative.EnginePort
import AgentWorkspace.Theorems.Invariants.EnginePort
import AgentWorkspace.Theorems.Invariants.EngineSkills
import AgentWorkspace.Theorems.Adversarial.EngineSandboxEnv
import AgentWorkspace.Theorems.Refinement.EnginePortCompile
import AgentWorkspace.Theorems.Refinement.EngineToolPolicy
import Vectors.Common

/-!
The `engine-compose` family: the three decisions ENG-04 (#303) adds, replayed against the real
TypeScript by two suites —

* `apps/web/formal/engine-compose.test.ts` against the compose-side protocol check;
* `apps/runner/formal/engine-registry.test.ts` against the registry and the sandbox-environment
  gate;
* `tests/formal/engine-tool-policy.test.ts` against the Claude adapter's tool mapping and skill
  placement, which ENG-04b (#325) moved in from `apps/web` and `apps/runner`.

The suites read different files of this one family because they replay different halves of one
unit's decision, and splitting the family would have made the shared model two models.
-/

namespace Vectors.EngineCompose

open Lean AgentWorkspace.Behaviour.EnginePort AgentWorkspace.Behaviour.SandboxEnv
open AgentWorkspace.Behaviour.EngineToolPolicy AgentWorkspace.Behaviour.EngineSkills
open AgentWorkspace.Behaviour.RunCompose (Permissions)

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".EnginePort." ++ name

private def ts (tier ns name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ "." ++ ns ++ "." ++ name

/-! ## The protocol check -/

private def protocolVector (id : String) (engineProtocols : List String) (provider : String) :
    Vector :=
  { id,
    input :=
      Json.mkObj
        [("engineProtocols", Lean.toJson engineProtocols), ("provider", provider)],
    expected :=
      Json.mkObj
        [("served", Lean.toJson (gatewayProtocolsFor provider)),
         ("protocol",
           match resolveWireProtocol engineProtocols provider with
           | none => Json.null
           | some p => Json.str p)],
    witnesses :=
      [t "Normative" "compose_accepts_iff_overlap",
       t "Normative" "resolved_protocol_is_the_engines",
       t "Normative" "resolved_protocol_is_served"] }

def protocolVectors : List Vector :=
  [protocolVector "claude-anthropic" ["anthropic-messages"] "anthropic",
   protocolVector "claude-anthropic-compatible" ["anthropic-messages"] "anthropic-compatible",
   protocolVector "claude-openai" ["anthropic-messages"] "openai",
   protocolVector "claude-azure-openai" ["anthropic-messages"] "azure-openai",
   protocolVector "claude-openai-compatible" ["anthropic-messages"] "openai-compatible",
   protocolVector "responses-only-anthropic" ["openai-responses"] "anthropic",
   protocolVector "responses-only-openai" ["openai-responses"] "openai",
   protocolVector "engine-order-wins" ["openai-responses", "anthropic-messages"] "openai",
   protocolVector "engine-order-falls-back" ["openai-responses", "anthropic-messages"] "anthropic",
   protocolVector "engine-speaks-nothing" [] "openai"]

/-! ## The registry -/

private def claudeRow (loads : Bool) : InstalledAdapter :=
  { id := "claude-agent-sdk", version := "0.3.278", protectedConfigDirectory := ".claude", loads }

private def registryVector (id : String) (table : List InstalledAdapter) (requested : String) :
    Vector :=
  { id,
    input :=
      Json.mkObj
        [("table",
           Json.arr
             (table.map fun row =>
                 Json.mkObj
                   [("id", row.id), ("version", row.version), ("loads", Lean.toJson row.loads)]).toArray),
         ("engine", requested)],
    expected :=
      Json.mkObj
        [("code",
           match loadEngine table requested with
           | .found _ => Json.null
           | .refused r => Json.str r.code),
         ("installed",
           Json.arr
             (installedEngines table |>.map fun (engineId, version) =>
                 Json.mkObj [("id", engineId), ("version", version)]).toArray)],
    witnesses :=
      [t "Invariants" "unregistered_engine_emits_no_frame",
       t "Invariants" "absent_and_unloadable_are_the_same_refusal",
       t "Invariants" "healthz_reports_only_what_loaded"] }

def registryVectors : List Vector :=
  [registryVector "installed" [claudeRow true] "claude-agent-sdk",
   registryVector "package-absent" [claudeRow false] "claude-agent-sdk",
   registryVector "no-row" [claudeRow true] "openai-agents-sdk",
   registryVector "empty-image" [] "claude-agent-sdk"]

/-! ## The sandbox environment gate -/

private def envVector (id : String) (runToken : String) (env : List (String × String)) : Vector :=
  { id,
    input :=
      Json.mkObj
        [("runToken", runToken),
         ("env", Json.mkObj (env.map fun kv => (kv.1, Json.str kv.2)))],
    expected :=
      Json.mkObj
        [("accepted", Lean.toJson (accepts runToken env)),
         ("variable",
           match verdict runToken env with
           | .ok _ => Json.null
           | .refused v => Json.str v),
         ("checked",
           match verdict runToken env with
           | .ok n => Lean.toJson n
           | .refused _ => Json.null)],
    witnesses :=
      [ts "Adversarial" "EngineSandboxEnv" "accepted_environment_has_no_master_key",
       ts "Adversarial" "EngineSandboxEnv" "accepted_credential_variables_hold_the_run_token"] }

def sandboxEnvVectors : List Vector :=
  [envVector "todays-composed-run" "run-token"
     [("PATH", "/usr/bin"), ("ANTHROPIC_BASE_URL", "https://gateway.internal"),
      ("ANTHROPIC_AUTH_TOKEN", "run-token"), ("AW_SESSION_MIRROR_TOKEN", "run-token"),
      ("NODE_USE_ENV_PROXY", "1")],
   envVector "master-key" "run-token" [("ANTHROPIC_API_KEY", "provider-master-key")],
   envVector "master-key-mixed-case" "run-token" [("Anthropic_Api_Key", "provider-master-key")],
   envVector "unheard-of-provider-key" "run-token"
     [("PATH", "/usr/bin"), ("SOME_FUTURE_API_KEY", "sk-live-real")],
   envVector "resembling-token" "run-token" [("X_AUTH_TOKEN", "run-token-other")],
   envVector "not-credential-shaped" "run-token" [("DATABASE_URL", "postgres://u:p@h/db")],
   envVector "empty" "run-token" []]

/-! ## The Claude tool mapping (ENG-04b, #325)

One vector per input `Behaviour/EngineToolPolicy.lean`'s `cases` enumerates, carrying **both**
answers: what compose produced before the move and what the adapter compiles now. The replay
asserts the adapter's against `expected.target` *and* asserts that the two are equal, so the
vector file states the refinement rather than only one side of it.
-/

private def toolPolicyJson (p : ToolPolicy) : Json :=
  Json.mkObj
    [("base",
       match p.base with
       | none => Json.null
       | some names => Lean.toJson names),
     ("autoApprove", Lean.toJson p.autoApprove),
     ("deny", Lean.toJson p.deny),
     ("permissionMode", Json.str p.permissionMode),
     ("allowDangerouslySkipPermissions", Lean.toJson p.allowDangerouslySkipPermissions)]

private def permissionsJson (p : Permissions) : Json :=
  Json.mkObj
    [("readFiles", Lean.toJson p.readFiles), ("writeFiles", Lean.toJson p.writeFiles),
     ("runCommands", Lean.toJson p.runCommands),
     ("unrestrictedNetwork", Lean.toJson p.unrestrictedNetwork)]

private def toolPolicyVector (c : Case) : Vector :=
  { id := c.id,
    input :=
      Json.mkObj
        [("permissions", permissionsJson c.permissions),
         ("stored",
           match c.stored with
           | none => Json.null
           | some p => toolPolicyJson p),
         ("mcpServers", Lean.toJson c.mcpServers),
         ("cwd", Json.str c.cwd),
         ("readOnly",
           Json.arr
             (c.readOnly.map fun (path, directory) =>
                 Json.mkObj [("path", Json.str path),
                   ("directory", Lean.toJson directory)]).toArray),
         ("guarded", Lean.toJson c.guarded)],
    expected :=
      Json.mkObj
        [("wireFileGrantDeny", Lean.toJson (wireFileGrantDeny c)),
         ("target", toolPolicyJson (target c)),
         ("current", toolPolicyJson (current c))],
    witnesses :=
      [ts "Refinement" "EngineToolPolicy" "adapter_matches_compose_on_every_case",
       ts "Refinement" "EngineToolPolicy" "the_permission_floor_survives_every_stored_policy",
       ts "Refinement" "EngineToolPolicy" "the_compose_side_guard_changes_nothing"] }

def toolPolicyVectors : List Vector := cases.map toolPolicyVector

/-! ## Skill placement (ENG-04b, #325) -/

private def skillVector (id : String) (configDirectory : String) (placements : List Placement)
    (grants : List Grant) : Vector :=
  { id,
    input :=
      Json.mkObj
        [("configDirectory", Json.str configDirectory),
         ("placements",
           Json.arr
             (placements.map fun placement =>
                 Json.mkObj [("skill", Json.str placement.skill),
                   ("path", Json.str placement.path)]).toArray),
         ("grants",
           Json.arr
             (grants.map fun grant =>
                 Json.mkObj [("name", Json.str grant.name),
                   ("files", Lean.toJson grant.files)]).toArray)],
    expected :=
      Json.mkObj
        [("files",
           match skillPlacementVerdict placements grants configDirectory with
           | .accepted n => Lean.toJson n
           | .refused _ => Json.null),
         ("refusal",
           match skillPlacementVerdict placements grants configDirectory with
           | .accepted _ => Json.null
           | .refused r => Json.str r.code)],
    witnesses :=
      [ts "Invariants" "EngineSkills" "claude_places_every_skill_inside_its_own_directory",
       ts "Invariants" "EngineSkills" "a_placement_outside_the_declared_directory_is_refused",
       ts "Invariants" "EngineSkills" "a_dropped_skill_is_refused_and_an_empty_request_is_not"] }

private def twoSkills : List (String × List String) :=
  [("invoice-review", ["SKILL.md", "reference/rates.md"]),
   ("document-writer", ["SKILL.md"])]

private def twoGrants : List Grant :=
  [{ name := "invoice-review", files := 2 }, { name := "document-writer", files := 1 }]

private def oneGrant : List Grant := [{ name := "document-writer", files := 1 }]

def skillVectors : List Vector :=
  [skillVector "claude-layout" claudeProtectedConfigDirectory
     (skillsUnderConfigDirectory claudeProtectedConfigDirectory twoSkills) twoGrants,
   skillVector "second-engine-layout" scriptedProtectedConfigDirectory
     (skillsUnderConfigDirectory scriptedProtectedConfigDirectory twoSkills) twoGrants,
   skillVector "wrong-engines-directory" claudeProtectedConfigDirectory
     (skillsUnderConfigDirectory scriptedProtectedConfigDirectory twoSkills) twoGrants,
   skillVector "sandbox-root" claudeProtectedConfigDirectory
     [{ skill := "document-writer", path := "skills/document-writer/SKILL.md" }] oneGrant,
   skillVector "sibling-directory" claudeProtectedConfigDirectory
     [{ skill := "document-writer", path := ".claude-backup/SKILL.md" }] oneGrant,
   skillVector "the-directory-itself" claudeProtectedConfigDirectory
     [{ skill := "document-writer", path := ".claude" }] oneGrant,
   skillVector "climbs-out" claudeProtectedConfigDirectory
     [{ skill := "document-writer", path := ".claude/../../etc/SKILL.md" }] oneGrant,
   skillVector "ungranted-skill" claudeProtectedConfigDirectory
     [{ skill := "not-assigned", path := ".claude/skills/not-assigned/SKILL.md" }] oneGrant,
   skillVector "duplicate-path" claudeProtectedConfigDirectory
     [{ skill := "document-writer", path := ".claude/skills/w/SKILL.md" },
      { skill := "document-writer", path := ".claude/skills/w/./SKILL.md" }] oneGrant,
   skillVector "dropped-skill" claudeProtectedConfigDirectory [] twoGrants,
   skillVector "nothing-granted" claudeProtectedConfigDirectory [] []]

def files : List (String × Json) :=
  [("protocol.json",
     file "engine-compose" "The compose-time protocol check" protocolVectors),
   ("registry.json",
     file "engine-compose" "The runner's engine registry and what /healthz reports"
       registryVectors),
   ("sandbox-env.json",
     file "engine-compose" "Spec A.11 as a property of the compiled environment"
       sandboxEnvVectors),
   ("tool-policy.json",
     file "engine-compose"
       "The Claude tool policy, as compose produced it and as the adapter compiles it"
       toolPolicyVectors),
   ("skills.json",
     file "engine-compose" "Where an adapter may place a skill, and what the runner refuses"
       skillVectors)]

end Vectors.EngineCompose
