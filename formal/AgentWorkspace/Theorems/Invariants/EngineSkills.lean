import AgentWorkspace.Behaviour.EngineSkills

/-!
# T2 — a skill lands inside the engine's own configuration directory, or not at all (ENG-04b, #325)

ENG-04 (#324) left the runner writing skills to `${scope.configDir}/skills/<name>/` — one engine's
directory layout, in an application that may not import an engine adapter — and recorded it as its
Deviation 8. ENG-04b moves the *decision* behind the port and keeps the *writing* in the runner, so
the runner is now handed paths by code it does not own.

The invariant is what makes that safe, and it is an invariant rather than a convention: nothing is
written unless every placement normalises **inside** the directory the adapter itself declared, and
every granted skill is accounted for. A tenant's `SKILL.md` at the sandbox root would sit beside the
agent's own working files, reachable by tools the platform never scoped to it; one at `..` would be
outside the workspace altogether.

Both engines this repository ships are checked, with *different* directories, so the theorems are
about the rule rather than about `.claude`.
-/

namespace AgentWorkspace.Theorems.Invariants.EngineSkills

open AgentWorkspace.Behaviour.EngineSkills

/-- Two granted skills, three files between them — enough for a placement to collide or be dropped. -/
private def grants : List Grant :=
  [{ name := "invoice-review", files := 2 }, { name := "document-writer", files := 1 }]

private def granted : List (String × List String) :=
  [("invoice-review", ["SKILL.md", "reference/rates.md"]),
   ("document-writer", ["SKILL.md"])]

/-- The Claude adapter's own placement is accepted, and every file is written. -/
@[aw_spec (tier := T2) (doc := "docs/sdk/site/building/extending-the-platform.mdx#skills")
  (ts := "packages/engine-claude-agent-sdk/src/engine.ts#placeSkills")
  (ts := "packages/engine/src/skills.ts#skillPlacementVerdict")]
theorem claude_places_every_skill_inside_its_own_directory :
    skillPlacementVerdict
      (skillsUnderConfigDirectory claudeProtectedConfigDirectory granted) grants
      claudeProtectedConfigDirectory = .accepted 3 := by decide +kernel

/-- The same rule, with a **different** engine's directory: the invariant is about the declaration,
not about `.claude`. -/
@[aw_spec (tier := T2) (ts := "packages/engine/src/skills.ts#skillsUnderConfigDirectory")]
theorem a_second_engines_directory_is_accepted_the_same_way :
    skillPlacementVerdict
      (skillsUnderConfigDirectory scriptedProtectedConfigDirectory granted) grants
      scriptedProtectedConfigDirectory = .accepted 3 ∧
    skillPlacementVerdict
      (skillsUnderConfigDirectory scriptedProtectedConfigDirectory granted) grants
      claudeProtectedConfigDirectory = .refused .outsideConfigDirectory := by decide +kernel

/-- A placement at the sandbox root is refused: tenant content beside the agent's working files. -/
@[aw_spec (tier := T2) (ts := "packages/engine/src/skills.ts#skillPlacementVerdict")]
theorem a_placement_outside_the_declared_directory_is_refused :
    skillPlacementVerdict
      [{ skill := "document-writer", path := "skills/document-writer/SKILL.md" }]
      [{ name := "document-writer", files := 1 }] claudeProtectedConfigDirectory =
      .refused .outsideConfigDirectory := by decide +kernel

/-- A sibling directory whose name merely *starts with* the declared one is refused, because the
comparison is by segment and not by string prefix. -/
@[aw_spec (tier := T2) (ts := "packages/engine/src/skills.ts#skillPlacementVerdict")]
theorem a_sibling_directory_is_not_inside_it :
    skillPlacementVerdict
      [{ skill := "document-writer", path := ".claude-backup/SKILL.md" }]
      [{ name := "document-writer", files := 1 }] claudeProtectedConfigDirectory =
      .refused .outsideConfigDirectory := by decide +kernel

/-- The declared directory itself is not inside itself: a file written *at* it is not a skill. -/
@[aw_spec (tier := T2) (ts := "packages/engine/src/skills.ts#skillPlacementVerdict")]
theorem the_directory_itself_is_refused :
    skillPlacementVerdict [{ skill := "document-writer", path := ".claude" }]
      [{ name := "document-writer", files := 1 }] claudeProtectedConfigDirectory =
      .refused .outsideConfigDirectory := by decide +kernel

/-- A path that climbs out of the workspace is refused as unusable, before anything about the
configuration directory is asked. -/
@[aw_spec (tier := T2) (ts := "packages/engine/src/path-grant.ts#normaliseGrantPath")]
theorem a_placement_that_climbs_out_is_refused :
    skillPlacementVerdict
      [{ skill := "document-writer", path := ".claude/../../etc/SKILL.md" }]
      [{ name := "document-writer", files := 1 }] claudeProtectedConfigDirectory =
      .refused .unusablePath := by decide +kernel

/-- A placement for a skill nobody granted is refused: those bytes came from somewhere else. -/
@[aw_spec (tier := T2) (ts := "packages/engine/src/skills.ts#skillPlacementVerdict")]
theorem a_placement_for_an_ungranted_skill_is_refused :
    skillPlacementVerdict
      [{ skill := "not-assigned", path := ".claude/skills/not-assigned/SKILL.md" }]
      [{ name := "document-writer", files := 1 }] claudeProtectedConfigDirectory =
      .refused .unknownSkill := by decide +kernel

/-- Two placements on one path are refused: the second write wins silently, and the run would then
use a skill whose contents nobody chose. -/
@[aw_spec (tier := T2) (ts := "packages/engine/src/skills.ts#skillPlacementVerdict")]
theorem two_placements_on_one_path_are_refused :
    skillPlacementVerdict
      [{ skill := "document-writer", path := ".claude/skills/w/SKILL.md" },
       { skill := "document-writer", path := ".claude/skills/w/./SKILL.md" }]
      [{ name := "document-writer", files := 1 }] claudeProtectedConfigDirectory =
      .refused .duplicatePath := by decide +kernel

/-- The vacuity control. An adapter that places nothing must not pass a check about where its
skills land — so a granted skill with no placement is a refusal, and a request that grants nothing
is accepted with zero files. -/
@[aw_spec (tier := T2) (ts := "packages/engine/src/skills.ts#skillPlacementVerdict")]
theorem a_dropped_skill_is_refused_and_an_empty_request_is_not :
    skillPlacementVerdict [] grants claudeProtectedConfigDirectory = .refused .skillDropped ∧
    skillPlacementVerdict [] [] claudeProtectedConfigDirectory = .accepted 0 := by decide +kernel

end AgentWorkspace.Theorems.Invariants.EngineSkills
