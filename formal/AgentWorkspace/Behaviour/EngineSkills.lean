import AgentWorkspace.Authz.PathGrant

/-!
# Skill materialisation, split between the runner and the adapter (ENG-04b, #325)

The second of ENG-04's deferred targets (#324's Deviation 8). Spec §7 gives a tenant a set of
`SKILL.md` skills and a run the ones its agent is assigned; two questions follow and they belong to
different places:

* **where** a skill goes is the engine's — the Claude Agent SDK reads
  `${CLAUDE_CONFIG_DIR}/skills/<name>/` and the next engine will not. `AgentEngine.placeSkills`
  answers it.
* **writing bytes into a sandbox safely** is engine-neutral, and `apps/runner/src/resources.ts`
  already does it: a symlink anywhere on the path is refused rather than followed, files land
  `0o444` under `0o555` directories, and a manifest removes what an assignment revoked.

Between the two there is a check, and this module is it. The runner is handed paths by code it does
not own, and a placement that escaped the engine's own configuration directory would put
tenant-supplied content where the platform never agreed to: the sandbox root beside the agent's own
working files, another skill's directory, or — through `..` — outside the workspace altogether.

`skillPlacementVerdict` is written against `Authz/PathGrant.lean`'s normalisation, because "is this
path inside that directory" is the same question a file grant asks and a second answer to it is a
second chance to get `..` wrong.
-/

namespace AgentWorkspace.Behaviour.EngineSkills

open AgentWorkspace AgentWorkspace.Authz.PathGrant

/-- Why a placement may not be written. Each arm is one mistake an adapter can make. -/
inductive Refusal where
  /-- The path does not normalise to a location inside the workspace. -/
  | unusablePath
  /-- The path normalises outside the engine's own declared configuration directory. -/
  | outsideConfigDirectory
  /-- The placement names a skill the request did not grant. -/
  | unknownSkill
  /-- Two placements normalise to one path, so one would silently overwrite the other. -/
  | duplicatePath
  /-- A granted skill has files and the adapter placed none of them. -/
  | skillDropped
  deriving DecidableEq, Repr, Inhabited

namespace Refusal

/-- The name each refusal is reported under, matching `packages/engine/src/skills.ts`. -/
def code : Refusal → String
  | unusablePath => "unusable_path"
  | outsideConfigDirectory => "outside_config_directory"
  | unknownSkill => "unknown_skill"
  | duplicatePath => "duplicate_path"
  | skillDropped => "skill_dropped"

end Refusal

/-- One file of one skill, at the path the adapter chose for it. -/
structure Placement where
  skill : String
  path : String
  deriving DecidableEq, Repr, Inhabited

/-- One skill as the request grants it: a name and how many files it carries. -/
structure Grant where
  name : String
  files : Nat
  deriving DecidableEq, Repr, Inhabited

/-- What the check answers: how many files will be written, or why none will be. -/
inductive Verdict where
  | accepted (files : Nat)
  | refused (reason : Refusal)
  deriving DecidableEq, Repr, Inhabited

/-- Is `candidate` a **proper descendant** of `root`, compared segment by segment?

Segment by segment, never as a string prefix: `.claude-backup/x` starts with `.claude` as text and
is a different directory as a path. Proper, not reflexive: the configuration directory itself is a
directory, and a file written *at* it is not a file inside it. -/
def insideDirectory (candidate root : List String) : Bool :=
  root.length < candidate.length && root.isPrefixOf candidate

/-- The normalised path of one placement, or `none` when it names nothing inside the workspace. -/
def normalisedPath (placement : Placement) : Option (List String) :=
  match normaliseGrantPath none placement.path with
  | .ok segments => some segments
  | .refused _ => none

/-- Check an adapter's placement against the grants it came from and the directory it declared.

A **positive** assertion (ADR-0015): `accepted` is reached because every placement was classified
*and* every granted skill was accounted for, never because no rule objected. The two halves matter
separately — an adapter that placed a file for a skill nobody granted and an adapter that dropped
one it was given are different bugs, and an adapter that returned `[]` must not pass a check about
where its skills land. -/
def skillPlacementVerdict (placements : List Placement) (grants : List Grant)
    (protectedConfigDirectory : String) : Verdict :=
  match normaliseGrantPath none protectedConfigDirectory with
  | .refused _ => .refused .outsideConfigDirectory
  | .ok root =>
    let step : Verdict → Placement → Verdict := fun acc placement =>
      match acc with
      | .refused r => .refused r
      | .accepted seen =>
        match normalisedPath placement with
        | none => .refused .unusablePath
        | some segments =>
          if !insideDirectory segments root then .refused .outsideConfigDirectory
          else if !(grants.map Grant.name).contains placement.skill then .refused .unknownSkill
          else if
              ((placements.take seen).filterMap normalisedPath).contains segments then
            .refused .duplicatePath
          else .accepted (seen + 1)
    match placements.foldl step (.accepted 0) with
    | .refused r => .refused r
    | .accepted written =>
      if grants.any (fun grant =>
            0 < grant.files && !(placements.map Placement.skill).contains grant.name) then
        .refused .skillDropped
      else .accepted written

/-- The layout every engine researched for #299 that has skills at all uses:
`<config>/skills/<name>/<file>`. `packages/engine/src/skills.ts` offers it as a helper; what makes
it *one* engine's answer is the directory it is rooted at. -/
def skillsUnderConfigDirectory (protectedConfigDirectory : String)
    (grants : List (String × List String)) : List Placement :=
  grants.flatMap fun (name, files) =>
    files.map fun file =>
      { skill := name,
        path := protectedConfigDirectory ++ "/skills/" ++ name ++ "/" ++ file }

/-- The Claude Agent SDK's configuration directory, as its adapter declares it. -/
def claudeProtectedConfigDirectory : String := ".claude"

/-- The scripted double's, so a theorem below can be about two *different* engines rather than
about one engine's constant. -/
def scriptedProtectedConfigDirectory : String := ".scripted-engine"

end AgentWorkspace.Behaviour.EngineSkills
