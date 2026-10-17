import AgentWorkspace.Er.Core

/-!
# File — a node of a workspace's file tree

A **file** is one row of `files` (`packages/core/src/db/schema/files.ts`): a node of the
workspace's tree, addressed by its workspace-relative `path`, that is either a `file` (bytes in the
object store under `storage_key`) or a `folder` (no bytes). Spec §16: "Files are simply workspace
files accessible by the Claude Agent SDK's file tools", so the row is an index entry, not a
document store.

The wire (`packages/contracts/src/files.ts`, `FileResourceSchema`) addresses a file by `path`
and treats `id` as opaque; it carries no owner and no creator.

This module states the concept's fields as the database knows them, the row invariants the
`files_*` CHECK constraints enforce (as predicates over the typed row), the path grammar
(`files_path_shape`, `files_path_no_dot_segments`), the prefix boundary the catalog repository
uses for subtree moves (`pathUnderPrefix`), and the catalog upsert that never transfers
ownership (`putFile`). Files have no lifecycle states: a row exists or it does not.
-/

namespace AgentWorkspace.Concepts.File

open AgentWorkspace

/-! ## Kind -/

/-- `fileKinds` / `FILE_KINDS`: a node of the tree is one of exactly two things. -/
@[aw_spec (ts := "packages/core/src/db/schema/files.ts#fileKinds")
  (ts := "packages/contracts/src/files.ts#FILE_KINDS")
  (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")]
inductive FileKind where
  | file
  | folder
  deriving DecidableEq, Repr, Inhabited

/-- The wire and database spelling of a kind. -/
def FileKind.toWire : FileKind → String
  | .file => "file"
  | .folder => "folder"

instance : WireEnum FileKind where
  all := [.file, .folder]
  toWire := FileKind.toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by
    intro a b h
    cases a <;> cases b <;> first | rfl | exact absurd h (by decide)

/-! ## The path grammar -/

/-- A control character as PostgreSQL's `[:cntrl:]` class reads it in a UTF-8 database: the C0
controls, `DEL` and the C1 controls (`U+0080`–`U+009F`). -/
def isControl (c : Char) : Bool := c.toNat < 32 || (127 ≤ c.toNat && c.toNat ≤ 159)

/-- Split a character list at every `/`, keeping empty segments (so `"a//b"` has three). -/
def splitSlash : List Char → List (List Char)
  | [] => [[]]
  | c :: cs =>
    match splitSlash cs with
    | [] => [[c]]
    | s :: rest => if c == '/' then [] :: s :: rest else (c :: s) :: rest

/-- The `/`-separated segments of a path. -/
def segments (p : String) : List (List Char) := splitSlash p.toList

/-- `files_path_shape`: `^[^/[:cntrl:]]+(/[^/[:cntrl:]]+)*$` — segments separated by single
slashes, each non-empty and free of control characters, with no leading or trailing slash. -/
@[aw_spec (ts := "packages/core/src/db/schema/files.ts#files")
  (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")]
def pathShape (p : String) : Bool :=
  (segments p).all fun s => !s.isEmpty && s.all fun c => !isControl c

/-- `files_path_no_dot_segments`: `path !~ '(^|/)[.][.]?(/|$)'` — no segment is `.` or `..`, the
two ways a path escapes its own workspace prefix. -/
@[aw_spec (ts := "packages/core/src/db/schema/files.ts#files")
  (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")]
def noDotSegments (p : String) : Bool :=
  (segments p).all fun s => s != ['.'] && s != ['.', '.']

/-- A path the `files` table admits: both path checks. -/
def pathAdmitted (p : String) : Bool := pathShape p && noDotSegments p

/-! ## The concept -/

/-- One `files` row, typed. `sizeBytes` is the `bigint` column (an integer, so its non-negativity
is a check, not a type); `createdBy` is the legacy human attribution (a `memberships.user_id` of
the same workspace, or `NULL` when an API-key principal created the row); `owner` is the exact
owning principal. -/
@[aw_spec (ts := "packages/core/src/db/schema/files.ts#files")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#CatalogFile")
  (doc := "docs/sdk/07-structure-map.md#3-er-diagram--the-tables-the-sdk-surfaces")]
structure File where
  id : FileId
  workspace : WorkspaceId
  path : String
  kind : FileKind
  storageKey : Option String
  sizeBytes : Int
  contentType : Option String
  createdBy : Option UserId
  owner : PrincipalId
  deriving DecidableEq, Repr

/-- `length(btrim(x)) > 0`: PostgreSQL's one-argument `btrim` removes spaces only, so a string is
blank exactly when every character is a space. -/
def notBlank (s : String) : Bool := s.toList.any (· != ' ')

namespace File

variable (f : File)

/-- `files_storage_key_iff_file`: a file has an object key and a folder has none. -/
def storageKeyIffFile : Bool := (f.kind == .file) == f.storageKey.isSome

/-- `files_storage_key_not_blank`. -/
def storageKeyNotBlank : Bool := f.storageKey.all notBlank

/-- `files_size_non_negative`. -/
def sizeNonNegative : Bool := decide (0 ≤ f.sizeBytes)

/-- `files_folder_has_no_content`: a folder occupies no bytes and has no MIME type. -/
def folderHasNoContent : Bool :=
  f.kind != .folder || (f.sizeBytes == 0 && f.contentType.isNone)

/-- Every `files` check holds on the row: the two path checks and the four content checks. The
closed set `files_kind_valid` holds by the type of `kind`. -/
@[aw_spec (ts := "packages/core/src/db/schema/files.ts#files")
  (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")]
def valid : Bool :=
  pathShape f.path && noDotSegments f.path && f.storageKeyIffFile && f.storageKeyNotBlank &&
    f.sizeNonNegative && f.folderHasNoContent

end File

/-! ## The database columns and the wire fields -/

/-- The columns of `files`, in declaration order, as this concept maps them. -/
def dbColumns : List String :=
  ["id", "workspace_id", "path", "kind", "storage_key", "size_bytes", "content_type",
    "created_by", "owner_principal_id", "created_at", "updated_at"]

/-- The keys of `FileResourceSchema`, in declaration order: no owner, no creator, and a
modification time the table does not have (it comes from the object store). -/
@[aw_spec (ts := "packages/contracts/src/files.ts#FileResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#56-files--awfiles")]
def wireFields : List String := ["id", "path", "kind", "sizeBytes", "contentType", "lastModified"]

/-! ## The subtree boundary and the catalog operations -/

/-- `pathUnderPrefix`: `path = prefix` or `path` starts with `prefix` followed by an actual `/`,
never merely the same leading characters. -/
@[aw_spec (ts := "packages/core/src/db/repositories/resource-catalogs.ts#pathUnderPrefix")]
def underPrefix (pre path : String) : Bool :=
  path == pre || (pre.toList ++ ['/']).isPrefixOf path.toList

/-- `newPrefix || substr(x, char_length(oldPrefix) + 1)`: drop as many characters of `x` as
`oldPrefix` has, and put `newPrefix` in front. It does not look at what it drops. -/
def cutAndPrefix (old new x : String) : String :=
  String.ofList (new.toList ++ x.toList.drop old.toList.length)

/-- `renameFilesByPrefix` on one path: replace the leading `oldPrefix` by `newPrefix` when the
path lies under it, and leave every other path alone. -/
@[aw_spec (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
def renamePath (old new path : String) : String :=
  if underPrefix old path then cutAndPrefix old new path else path

/-- `renameFilesByPrefix`: one `UPDATE` of every row whose path is under the prefix (the `WHERE`
is `pathUnderPrefix` on `path`), so each row keeps its id, owner and creator. The `SET` rewrites
`path`, and, for a `file` row, `storage_key` by the same cut: `case when kind = 'file' then
newPrefix || substr(storage_key, char_length(oldPrefix) + 1) else storage_key end`. The key is
cut by the length of the old prefix whatever it holds, so the rewrite is a rename of the key only
when the key starts with the old prefix (the app writes `storage_key = path`). -/
@[aw_spec (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#ResourceCatalogRepository")]
def renameByPrefix (old new : String) (fs : List File) : List File :=
  fs.map fun f =>
    if underPrefix old f.path then
      { f with path := cutAndPrefix old new f.path,
               storageKey := if f.kind == .file then f.storageKey.map (cutAndPrefix old new)
                 else f.storageKey }
    else f

/-- `deleteFilesByPrefix`: delete every row under the prefix, keep every other row. -/
def deleteByPrefix (pre : String) (fs : List File) : List File :=
  fs.filter fun f => !underPrefix pre f.path

/-- What `putFile` is given: the content fields and the would-be owner; the id is minted by the
database. -/
structure PutFile where
  path : String
  kind : FileKind
  storageKey : Option String
  sizeBytes : Int
  contentType : Option String
  createdBy : Option UserId
  owner : PrincipalId
  deriving DecidableEq, Repr

/-- `putFile` on one workspace's catalog: an upsert on `(workspace_id, path)`. An existing row at
that path gets the new kind, key, size and content type, and keeps its id, owner and creator
("an upsert at an existing path never transfers it"); otherwise a new row with the fresh id and
the caller as owner is appended. -/
@[aw_spec (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#CatalogFile")]
def putFile (ws : WorkspaceId) (fresh : FileId) (input : PutFile) (fs : List File) : List File :=
  if fs.any (·.path == input.path) then
    fs.map fun f =>
      if f.path == input.path then
        { f with kind := input.kind, storageKey := input.storageKey, sizeBytes := input.sizeBytes,
                 contentType := input.contentType }
      else f
  else
    fs ++ [{ id := fresh, workspace := ws, path := input.path, kind := input.kind,
             storageKey := input.storageKey, sizeBytes := input.sizeBytes,
             contentType := input.contentType, createdBy := input.createdBy,
             owner := input.owner }]

/-- What `renameFile` is given: the new path and content fields. Ownership and the legacy
creator are not part of it ("a rename changes the row's path and content metadata, never who owns
or originally created it"). -/
@[aw_spec (ts := "packages/core/src/db/repositories/resource-catalogs.ts#ResourceCatalogRepository")]
structure RenameFile where
  path : String
  kind : FileKind
  storageKey : Option String
  sizeBytes : Int
  contentType : Option String
  deriving DecidableEq, Repr

/-- The outcomes of `renameFile`: the updated catalog and the returned row, `null` when no row is
at the old path, or the `files_workspace_path_key` violation PostgreSQL raises when another row
already holds the new path. -/
inductive RenameOutcome where
  | renamed (fs : List File) (row : File)
  | missing
  | conflict
  deriving DecidableEq, Repr

/-- `renameFile(path, input)`: one `UPDATE files SET input WHERE workspace_id = … AND path = …`.
The row keeps its id, workspace, owner and creator. -/
@[aw_spec (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")
  (ts := "packages/core/src/db/repositories/resource-catalogs.ts#ResourceCatalogRepository")]
def renameFile (path : String) (input : RenameFile) (fs : List File) : RenameOutcome :=
  match fs.find? (·.path == path) with
  | none => .missing
  | some f =>
    if input.path != path && fs.any (·.path == input.path) then .conflict
    else
      let f' : File := { f with path := input.path, kind := input.kind,
                                storageKey := input.storageKey, sizeBytes := input.sizeBytes,
                                contentType := input.contentType }
      .renamed (fs.map fun g => if g.path == path then f' else g) f'

/-- `deleteFile(path)`: delete the one row at exactly `path`. Unlike `deleteFilesByPrefix`, the
rows under a folder's path are not touched. -/
@[aw_spec (ts := "packages/core/src/db/repositories/resource-catalogs.ts#createDatabaseResourceCatalogRepositoryProvider")]
def deleteFile (path : String) (fs : List File) : List File := fs.filter (·.path != path)

/-- The equation lemmas of `splitSlash`, generated in this module. -/
private theorem splitSlash_equations (c : Char) (cs : List Char) :
    splitSlash [] = [[]] ∧
      splitSlash (c :: cs) =
        match splitSlash cs with
        | [] => [[c]]
        | s :: rest => if c == '/' then [] :: s :: rest else (c :: s) :: rest := by
  constructor <;> simp only [splitSlash]

end AgentWorkspace.Concepts.File
