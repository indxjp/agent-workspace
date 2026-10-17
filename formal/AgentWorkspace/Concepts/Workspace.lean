import AgentWorkspace.Er.Core

/-!
# The workspace concept

A **workspace** is the tenant: "Every resource below belongs to exactly one"
(`docs/sdk/04-api-specification.md` §1.1). The database knows it as a row of `workspaces`
(`packages/core/src/db/schema/workspaces.ts`), the one table whose tenant column is its own `id`;
the wire knows it as `WorkspaceResourceSchema` (`packages/contracts/src/workspaces.ts`).

**Fields.** `slug` is the URL-safe natural key a session token carries (`claims.ws`); `name` is
display text; `publicSharingEnabled` is the sharing policy; the workspace-wide model default is a
connection *and* a model id, written and cleared as one pair, so the model keeps it as one
`Option` of a pair and the `workspaces_default_model_pair` check holds by construction;
`archivedAt` is the archive stamp (`NULL` while active).

**States.** `active` and `archived`, derived from `archivedAt` (transitions are Phase 4).

**Shared vocabulary.** Timestamps are `Instant`s (milliseconds since the Unix epoch), rendered in a
`Row` as their decimal numeral, so the ordering checks of the identity tables compare numbers. The
two text predicates every identity table's checks use, `notBlank` (`length(btrim(x)) > 0`) and
`slugFormat` (`workspaces_slug_format`), live here with the root concept.
-/

namespace AgentWorkspace.Concepts.Workspace

open AgentWorkspace AgentWorkspace.Er.Core

/-- A point in time: milliseconds since the Unix epoch. The model has no clock, so every "now"
is an input. -/
abbrev Instant := Nat

/-- An instant as a `Row` cell: its decimal numeral. -/
def instantText (t : Instant) : String := Nat.repr t

/-- A decimal numeral read as an instant: a non-empty string of ASCII digits, and nothing else.
(Written over `String.toList` so that the kernel can evaluate it on sample rows.) -/
def parseInstant? (s : String) : Option Instant :=
  let cs := s.toList
  if !cs.isEmpty && cs.all Char.isDigit then some (Nat.ofDigitChars 10 cs 0) else none

/-- A timestamp cell read back as an instant; `none` for `NULL` or a cell that is not a numeral. -/
def instantOf? (v : Option String) : Option Instant := v.bind parseInstant?

/-- Reading back an instant's cell gives the instant. -/
theorem parseInstant?_instantText (t : Instant) : parseInstant? (instantText t) = some t := by
  have hne : Nat.toDigits 10 t ≠ [] := Nat.toDigits_ne_nil
  have hd : (Nat.toDigits 10 t).all Char.isDigit = true :=
    List.all_eq_true.mpr fun _ h => Nat.isDigit_of_mem_toDigits (by decide) (by decide) h
  simp [parseInstant?, instantText, Nat.toList_repr, hne, hd]

/-- `length(btrim(s)) > 0`. PostgreSQL's one-argument `btrim` strips only the space character
U+0020, so a string of tabs is *not* blank to the database. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspaces.ts#workspaces_name_not_blank")
  (ts := "packages/core/src/db/schema/api-keys.ts#api_keys_name_not_blank")]
def notBlank (s : String) : Bool := s.toList.any (· != ' ')

/-- A character `[a-z0-9-]`. -/
def isSlugChar (c : Char) : Bool := ('a' ≤ c && c ≤ 'z') || ('0' ≤ c && c ≤ '9') || c == '-'

/-- A character `[a-z0-9]`: what a slug starts and ends with. -/
def isSlugEnd (c : Char) : Bool := isSlugChar c && c != '-'

/-- `workspaces_slug_format`: `slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'` — one to 63
characters of `[a-z0-9-]`, starting and ending with a letter or digit. Unlike the `oneOf` value
gate, a slug may start with a digit and may contain `--`. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspaces.ts#workspaces_slug_format")
  (ts := "apps/web/server/auth/session.ts#SLUG_SHAPE")]
def slugFormat (s : String) : Bool :=
  let cs := s.toList
  1 ≤ cs.length && cs.length ≤ 63 && cs.all isSlugChar && cs.head?.all isSlugEnd &&
    cs.getLast?.all isSlugEnd

/-- `WORKSPACE_SLUG_MAX_LENGTH`: the bound `POST /api/workspaces` applies to `slug` before the
database sees it. -/
@[aw_spec (ts := "packages/contracts/src/workspaces.ts#WORKSPACE_SLUG_MAX_LENGTH")]
def slugMaxLengthContract : Nat := 64

/-- `WORKSPACE_NAME_MAX_LENGTH`. -/
@[aw_spec (ts := "packages/contracts/src/workspaces.ts#WORKSPACE_NAME_MAX_LENGTH")]
def nameMaxLengthContract : Nat := 200

/-- The workspace-wide model default: a connection of this workspace and a provider model id. -/
structure DefaultModel where
  connection : ModelConnectionId
  model : String
  deriving DecidableEq, Repr

/-- A workspace, with every column of `workspaces` that carries meaning. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")
  (ts := "packages/contracts/src/workspaces.ts#WorkspaceResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
structure Workspace where
  id : WorkspaceId
  slug : String
  name : String
  publicSharingEnabled : Bool
  defaultModel : Option DefaultModel
  archivedAt : Option Instant
  createdAt : Instant
  updatedAt : Instant
  deriving DecidableEq, Repr

/-- The two states a workspace moves between after creation. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspaces.ts#archivedAt")
  (doc := "docs/formal/inventory.md#2-state-machines")]
inductive WorkspaceState where
  | active
  | archived
  deriving DecidableEq, Repr

/-- `NULL` `archived_at` is active; any stamp is archived. -/
def Workspace.state (w : Workspace) : WorkspaceState :=
  if w.archivedAt.isSome then .archived else .active

/-- The row invariants the database enforces on a workspace (its checks), as a predicate on the
concept: a well-formed slug and a non-blank name. The default-model pair holds by construction. -/
@[aw_spec (ts := "packages/core/src/db/schema/workspaces.ts#workspaces")]
def Workspace.valid (w : Workspace) : Bool := slugFormat w.slug && notBlank w.name

/-- An optional cell: `NULL` is the absence of the column. -/
def cell? (c : String) : Option String → List (String × String)
  | some v => [(c, v)]
  | none => []

/-- A boolean cell as PostgreSQL renders it. -/
def boolText (b : Bool) : String := if b then "true" else "false"

/-- The `workspaces` row of a workspace. -/
def Workspace.toRow (w : Workspace) : Row :=
  ⟨[("id", w.id.val), ("slug", w.slug), ("name", w.name),
     ("public_sharing_enabled", boolText w.publicSharingEnabled)] ++
    cell? "default_model_connection_id" (w.defaultModel.map (·.connection.val)) ++
    cell? "default_model" (w.defaultModel.map (·.model)) ++
    cell? "archived_at" (w.archivedAt.map instantText) ++
    [("created_at", instantText w.createdAt), ("updated_at", instantText w.updatedAt)]⟩

end AgentWorkspace.Concepts.Workspace
