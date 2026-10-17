import AgentWorkspace.Concepts.File

/-!
# Skill — one Claude Agent SDK skill in a workspace's catalog

A **skill** is one row of `skills` (`packages/core/src/db/schema/skills.ts`): the skill's identity
(`name`, the `.claude/skills/<name>/` directory name, unique in the workspace) and its `SKILL.md`
verbatim (`skill_md`), plus the platform switch `enabled`. Supporting files are objects in the
object store, not rows (spec §7: "Do not invent a proprietary skill format").

A skill is addressed by `name` on the wire (`packages/contracts/src/skills.ts`); the catalog
row's `id` rides along as an opaque value, and there is no owner on the wire. Skills have no
lifecycle states beyond the `enabled` flag; `DELETE /api/skills/:name` deletes one through the
repository's `deleteSkill`, refused while an agent has it assigned (S-12).
-/

namespace AgentWorkspace.Concepts.Skill

open AgentWorkspace

/-- A character `SKILL_NAME_PATTERN` admits anywhere: a lower-case letter, a digit or `-`. -/
def isNameChar (c : Char) : Bool := ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9') || c == '-'

/-- A character the pattern admits at either end: a lower-case letter or a digit. -/
def isNameEdge (c : Char) : Bool := ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9')

/-- `SKILL_NAME_MAX_LENGTH`. -/
@[aw_spec (ts := "packages/contracts/src/skills.ts#SKILL_NAME_MAX_LENGTH")
  (doc := "docs/sdk/04-api-specification.md#57-skills--awskills")]
def maxNameLength : Nat := 64

/-- `SKILL_NAME_PATTERN` = `skills_name_shape` = `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`: one
to 64 characters of lower-case letters, digits and hyphens, starting and ending with a letter or
digit. Unlike the `oneOf` value gate, it admits a leading digit and a doubled hyphen. -/
@[aw_spec (ts := "packages/contracts/src/skills.ts#SKILL_NAME_PATTERN")
  (ts := "packages/core/src/db/schema/skills.ts#skills")
  (doc := "docs/sdk/04-api-specification.md#57-skills--awskills")]
def nameShape (n : String) : Bool :=
  match n.toList with
  | [] => false
  | c :: rest =>
    isNameEdge c && rest.all isNameChar && ((c :: rest).getLast?.all isNameEdge) &&
      n.toList.length ≤ maxNameLength

/-- One `skills` row, typed. -/
@[aw_spec (ts := "packages/core/src/db/schema/skills.ts#skills")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#CatalogSkill")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
structure Skill where
  id : SkillId
  workspace : WorkspaceId
  name : String
  skillMd : String
  enabled : Bool
  createdBy : Option UserId
  owner : PrincipalId
  deriving DecidableEq, Repr

namespace Skill

/-- Both `skills` checks hold on the row: `skills_name_shape` and `skills_skill_md_not_blank`. -/
@[aw_spec (ts := "packages/core/src/db/schema/skills.ts#skills")
  (doc := "docs/sdk/04-api-specification.md#57-skills--awskills")]
def valid (s : Skill) : Bool := nameShape s.name && File.notBlank s.skillMd

end Skill

/-- The columns of `skills`, in declaration order. -/
def dbColumns : List String :=
  ["id", "workspace_id", "name", "skill_md", "enabled", "created_by", "owner_principal_id",
    "created_at", "updated_at"]

/-- The keys of `SkillDetailSchema` (every skill body the routes render): no owner, no creator;
`SKILL.md` is `source`, parsed into `description`, `instructions` and `allowedTools`. -/
@[aw_spec (ts := "packages/contracts/src/skills.ts#SkillDetailSchema")
  (doc := "docs/sdk/04-api-specification.md#57-skills--awskills")]
def wireFields : List String :=
  ["id", "name", "enabled", "description", "fileCount", "createdAt", "updatedAt", "source",
    "instructions", "allowedTools", "files"]

/-- What `putSkill` is given. -/
structure PutSkill where
  name : String
  skillMd : String
  enabled : Bool
  createdBy : Option UserId
  owner : PrincipalId
  deriving DecidableEq, Repr

/-- `putSkill` on one workspace's catalog: an upsert on `(workspace_id, name)` that updates
`skill_md` and `enabled` of an existing row and never its id, owner or creator. -/
@[aw_spec (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#CatalogSkill")]
def putSkill (ws : WorkspaceId) (fresh : SkillId) (input : PutSkill) (ss : List Skill) :
    List Skill :=
  if ss.any (·.name == input.name) then
    ss.map fun s =>
      if s.name == input.name then { s with skillMd := input.skillMd, enabled := input.enabled }
      else s
  else
    ss ++ [{ id := fresh, workspace := ws, name := input.name, skillMd := input.skillMd,
             enabled := input.enabled, createdBy := input.createdBy, owner := input.owner }]

/-- `deleteSkill(name)`: delete the one row with this name in the workspace. -/
@[aw_spec (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
def deleteSkill (name : String) (ss : List Skill) : List Skill := ss.filter (·.name != name)

end AgentWorkspace.Concepts.Skill
