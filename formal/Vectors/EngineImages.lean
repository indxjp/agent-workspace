import AgentWorkspace.Theorems.Normative.EngineImages
import AgentWorkspace.Theorems.Invariants.EngineImages
import AgentWorkspace.Theorems.Refinement.EngineImages
import Vectors.Common

/-!
The `engine-images` family (ENG-07, #306). Six files, replayed by three suites:

* `tests/formal/engine-images.test.ts`, through `@agent-workspace/runtime`'s exports:
  * `parse.json` — `parseEngineImageMap` over accepted and refused maps, including that a refusal's
    message carries none of the configured values;
  * `env.json` — `readEngineImageMap` over environments, including the legacy `RUNTIME_IMAGE`;
  * `catalogue.json` — `engineImageInstalled` for each registered engine;
  * `dispatch.json` — `resolveEngineImage` and the real Docker driver's `create()`, with a fake
    `docker` command that records whether anything was started, and in which image;
* `apps/web/formal/engine-images.test.ts`, against the control plane:
  * `control-plane.json` — `readConfiguredEngineImages` over environments, production and not: the
    shape is checked and a digest never required;
  * `catalogue.json` again — `registeredEngines()`' `installed`, with the map installed as the
    deployment's configuration;
* `apps/runner/formal/engine-images.test.ts`, against the runner manager:
  * `runner-manager.json` — `engineImagesFor`, which requires digests in production.

Every value here is a distinctive image reference, so "the message names no value" is a substring
check that could fail.
-/

namespace Vectors.EngineImages

open Lean AgentWorkspace.Behaviour.EngineImages

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".EngineImages." ++ name

private def digest (repository : String) (c : Char) : String :=
  repository ++ "@sha256:" ++ String.ofList (List.replicate 64 c)

private def claudeDigest : String :=
  digest "registry.example/agent-workspace/runtime-claude-agent-sdk" 'a'

private def piDigest : String := digest "registry.example/agent-workspace/runtime-pi" 'b'

private def claudeTag : String := "registry.example/secret-project-7/runtime-claude-agent-sdk:v1"

private def piTag : String := "registry.example/secret-project-7/runtime-pi:v1"

private def pairs (entries : EngineImageMap) : Json :=
  Json.arr (entries.map fun (key, value) => Json.arr #[Json.str key, Json.str value]).toArray

private def parsedJson : Parsed → Json
  | .ok images => Json.mkObj [("ok", true), ("images", pairs images)]
  | .error faults =>
    Json.mkObj
      [("ok", false), ("keys", Lean.toJson faults.keys),
       ("unknown", Lean.toJson faults.unknown), ("malformed", Lean.toJson faults.malformed),
       ("unpinned", Lean.toJson faults.unpinned), ("duplicates", Lean.toJson faults.duplicates)]

private def parseWitnesses (parsed : Parsed) : List String :=
  match parsed with
  | .ok _ => [t "Normative" "catalogue_is_the_map"]
  | .error _ =>
    [t "Normative" "malformed_map_fails_parsing", t "Normative" "refusal_names_no_value",
     t "Normative" "refusal_names_only_configured_keys"]

/-! ## parse.json -/

private def parseVector (id : String) (known : List String) (requireDigest : Bool)
    (entries : EngineImageMap) : Vector :=
  let parsed := parse known charShaped requireDigest entries
  { id,
    input :=
      Json.mkObj
        [("knownEngineIds", Lean.toJson known), ("requireDigest", requireDigest),
         ("entries", pairs entries)],
    expected := parsedJson parsed,
    witnesses := parseWitnesses parsed }

private def bothKnown : List String := ["claude-agent-sdk", "pi"]

def parseVectors : List Vector :=
  [parseVector "two-engines" bothKnown false
     [("claude-agent-sdk", claudeTag), ("pi", piTag)],
   parseVector "empty-map" bothKnown false [],
   parseVector "unpublished-key" bothKnown false [("pie", piTag)],
   parseVector "unpublished-casing" bothKnown false [("Claude-Agent-SDK", claudeTag)],
   parseVector "whitespace-value" bothKnown false [("claude-agent-sdk", "two words")],
   parseVector "empty-value" bothKnown false [("pi", "")],
   parseVector "leading-dash" bothKnown false [("pi", "-registry.example/runtime-pi:v1")],
   parseVector "illegal-character" bothKnown false [("pi", "registry.example/run$time-pi:v1")],
   parseVector "digest-required-tag" bothKnown true [("claude-agent-sdk", claudeTag)],
   parseVector "digest-required-digest" bothKnown true
     [("claude-agent-sdk", claudeDigest), ("pi", piDigest)],
   parseVector "duplicate-key" bothKnown false
     [("claude-agent-sdk", claudeTag), ("claude-agent-sdk", claudeDigest)],
   parseVector "every-fault-in-order" bothKnown true
     [("claude-agent-sdk", claudeDigest), ("pie", piDigest), ("pi", piTag),
      ("claude-agent-sdk", digest "registry.example/other/runtime" 'c')]]

/-! ## env.json -/

private def envJson (env : Env) : Json :=
  Json.mkObj (env.map fun (key, value) => (key, Json.str value))

private def envVector (id : String) (known : List String) (requireDigest : Bool) (env : Env) :
    Vector :=
  let parsed := readEnv known charShaped requireDigest env
  { id,
    input :=
      Json.mkObj
        [("knownEngineIds", Lean.toJson known), ("requireDigest", requireDigest),
         ("env", envJson env)],
    expected := parsedJson parsed,
    witnesses := parseWitnesses parsed }

def envVectors : List Vector :=
  [envVector "per-engine-variables" bothKnown false
     [("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", claudeTag),
      ("AGENT_WORKSPACE_RUNTIME_IMAGE_PI", piTag)],
   envVector "legacy-runtime-image-is-claude-only" bothKnown false [("RUNTIME_IMAGE", claudeTag)],
   envVector "own-variable-wins-over-legacy" bothKnown false
     [("RUNTIME_IMAGE", piTag), ("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", claudeTag)],
   envVector "empty-own-variable-is-no-value" bothKnown false
     [("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", ""), ("RUNTIME_IMAGE", claudeTag)],
   envVector "unpublished-variable-is-ignored" bothKnown false
     [("AGENT_WORKSPACE_RUNTIME_IMAGE_FICTION", "nonsense value")],
   envVector "malformed-published-variable" bothKnown false
     [("AGENT_WORKSPACE_RUNTIME_IMAGE_PI", "two words")],
   envVector "production-needs-digests" bothKnown true
     [("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", claudeDigest),
      ("AGENT_WORKSPACE_RUNTIME_IMAGE_PI", piTag)]]

/-! ## control-plane.json -/

private def controlPlaneVector (id : String) (env : Env) : Vector :=
  let parsed := controlPlane ["claude-agent-sdk"] charShaped env
  { id,
    input := Json.mkObj [("env", envJson env)],
    expected := parsedJson parsed,
    witnesses :=
      (match parsed with
       | .ok _ => [t "Normative" "catalogue_is_the_map",
           t "Normative" "control_plane_never_requires_a_digest"]
       | .error _ => [t "Normative" "startup_refusal_names_only_engine_ids",
           t "Normative" "control_plane_never_requires_a_digest"]) }

def controlPlaneVectors : List Vector :=
  [controlPlaneVector "production-digest" [("NODE_ENV", "production"),
     ("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", claudeDigest)],
   controlPlaneVector "production-legacy-digest" [("NODE_ENV", "production"),
     ("RUNTIME_IMAGE", claudeDigest)],
   controlPlaneVector "production-tag-admitted" [("NODE_ENV", "production"),
     ("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", claudeTag)],
   controlPlaneVector "production-compose-default-admitted" [("NODE_ENV", "production"),
     ("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", "agent-workspace/runtime:dev")],
   controlPlaneVector "production-nothing-configured" [("NODE_ENV", "production")],
   controlPlaneVector "development-default" [("NODE_ENV", "development")],
   controlPlaneVector "development-tag" [("NODE_ENV", "development"),
     ("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", claudeTag)],
   controlPlaneVector "development-malformed-refused" [("NODE_ENV", "development"),
     ("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", "two words")]]

/-! ## runner-manager.json -/

private def runnerManagerVector (id : String) (env : Env) : Vector :=
  let parsed := runnerManager ["claude-agent-sdk"] charShaped env
  { id,
    input := Json.mkObj [("env", envJson env)],
    expected := parsedJson parsed,
    witnesses := [t "Normative" "runner_manager_requires_digests_in_production"] }

def runnerManagerVectors : List Vector :=
  [runnerManagerVector "production-digest" [("NODE_ENV", "production"),
     ("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", claudeDigest)],
   runnerManagerVector "production-tag-refused" [("NODE_ENV", "production"),
     ("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", claudeTag)],
   runnerManagerVector "production-compose-default-refused" [("NODE_ENV", "production"),
     ("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", "agent-workspace/runtime:dev")],
   runnerManagerVector "development-tag" [("NODE_ENV", "development"),
     ("AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK", "agent-workspace/runtime:dev")],
   runnerManagerVector "nothing-configured-refused" [("NODE_ENV", "development")]]

/-! ## catalogue.json -/

private def catalogueVector (id : String) (registered : List String) (images : EngineImageMap) :
    Vector :=
  { id,
    input :=
      Json.mkObj [("registered", Lean.toJson registered), ("images", pairs images)],
    expected :=
      Json.mkObj
        [("engines",
           Json.arr ((catalogue (registered.map fun id => { id }) images).map fun row =>
             Json.mkObj [("id", row.id), ("installed", row.installed)]).toArray)],
    witnesses :=
      [t "Normative" "catalogue_is_the_map",
       "AgentWorkspace.Theorems.Refinement.EngineImages.shipped_registry_is_installed_through_the_map"] }

def catalogueVectors : List Vector :=
  [catalogueVector "map-lacks-pi" bothKnown [("claude-agent-sdk", claudeTag)],
   catalogueVector "map-has-both" bothKnown [("claude-agent-sdk", claudeTag), ("pi", piTag)],
   catalogueVector "map-is-empty" bothKnown [],
   catalogueVector "map-has-only-pi" bothKnown [("pi", piTag)]]

/-! ## dispatch.json -/

private def dispatchVector (id : String) (images : EngineImageMap) (engine : String) : Vector :=
  let (result, after) := create .docker images {} "session-1" engine
  { id,
    input :=
      Json.mkObj [("driver", "docker"), ("images", pairs images), ("engine", engine)],
    expected :=
      match result with
      | .created image =>
        Json.mkObj [("outcome", "created"), ("image", image), ("sandboxes", after.created.length)]
      | .refused code =>
        Json.mkObj [("outcome", "refused"), ("code", code), ("sandboxes", after.created.length)],
    witnesses :=
      match result with
      | .created _ =>
        [t "Invariants" "driver_starts_only_in_the_runs_engine_image",
         t "Invariants" "every_sandbox_carries_its_runs_engine"]
      | .refused _ => [t "Invariants" "engine_without_image_creates_no_sandbox"] }

def dispatchVectors : List Vector :=
  [dispatchVector "pi-run-gets-pi-image" [("claude-agent-sdk", claudeTag), ("pi", piTag)] "pi",
   dispatchVector "claude-run-gets-claude-image"
     [("claude-agent-sdk", claudeTag), ("pi", piTag)] "claude-agent-sdk",
   dispatchVector "pi-run-without-pi-image" [("claude-agent-sdk", claudeTag)] "pi",
   dispatchVector "no-image-at-all" [] "claude-agent-sdk"]

def files : List (String × Json) :=
  [("parse.json", file "engine-images"
      "parseEngineImageMap: the whole map or the faulting keys, never a value" parseVectors),
   ("env.json", file "engine-images"
      "readEngineImageMap: per-engine variables, the legacy RUNTIME_IMAGE, and only published ids"
      envVectors),
   ("control-plane.json", file "engine-images"
      "readConfiguredEngineImages: shape only, never a digest; the development default outside production"
      controlPlaneVectors),
   ("runner-manager.json", file "engine-images"
      "engineImagesFor: digests in production, and no image at all refuses start-up"
      runnerManagerVectors),
   ("catalogue.json", file "engine-images"
      "GET /api/engines' installed is the configured map" catalogueVectors),
   ("dispatch.json", file "engine-images"
      "a driver starts a run in its engine's image, or refuses before creating anything"
      dispatchVectors)]

end Vectors.EngineImages
