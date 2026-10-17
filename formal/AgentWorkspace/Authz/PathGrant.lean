import AgentWorkspace.Prelude.Text

/-!
# Path normalisation and file grants (ENG-04, #303)

A file grant is the platform saying *"this agent may read this path, and may not write it"*. Two
independent mechanisms enforce it — the runner materialises a read-only grant with read-only
filesystem modes, and the engine adapter compiles the grant into its engine's tool-permission
grammar — and both have to agree about **what a grant's path names**. A rule written against
`docs/spec.md` and a `chmod` applied to `docs/../docs/spec.md` protect different files.

This module is the shared decision, modelled as pure functions over an explicit list of segments.
`packages/engine/src/path-grant.ts` is the TypeScript, and `tests/formal/path-grant.test.ts`
replays this family's vectors against it.

## What a symlink is, here

A symlink is **not resolved**: resolving one needs a filesystem, and a filesystem answer is only
true at the instant it is read. What is modelled is the other half — a symlink's recorded
*target*, which arrives as an ordinary string and is exactly the shape an escape is written in.
`normaliseGrantPath` refuses `../../etc/passwd` whether it came from a tenant's grant list or out
of a link the runner read, and the theorems below are about that.
-/

namespace AgentWorkspace.Authz.PathGrant

open AgentWorkspace

/-- Why a path may not be used as a grant. One arm per class of input; there is no catch-all. -/
inductive Refusal where
  /-- The path is empty, or is only separators and `.` segments. -/
  | empty
  /-- The path is absolute — POSIX (`/etc`) or Windows (`C:\`, `\\server`). -/
  | absolute
  /-- Normalising the path leaves the workspace root: `..` climbs above it. -/
  | escapesRoot
  /-- A byte no sandbox path may carry: NUL, or a backslash that is a separator elsewhere. -/
  | illegalCharacter
  /-- The engine's own configuration directory, declared by the adapter rather than guessed. -/
  | protectedDirectory
  deriving DecidableEq, Repr, Inhabited

/-- The verdict: the normalised segments, or the refusal by name. -/
inductive Verdict where
  | ok (segments : List String)
  | refused (reason : Refusal)
  deriving DecidableEq, Repr, Inhabited

namespace Verdict

/-- Did the path normalise? A named predicate, so a table of refusals reads as one. -/
def isOk : Verdict → Bool
  | .ok _ => true
  | .refused _ => false

end Verdict

/-- `[A-Za-z]` — the drive-letter class of a Windows absolute path. -/
def isDriveLetter (c : Char) : Bool := Text.isAsciiLower c || Text.isAsciiUpper c

/-- Is this string absolute under **any** platform a sandbox path travels through?

Deliberately wider than POSIX. A grant composed on a Windows control plane and enforced inside a
Linux container would have `C:\secrets` read as a *relative* path named `C:\secrets` there — one
oddly-named file created inside the sandbox — and the author's intent, which was a location
outside it, would be silently granted as something else. -/
def isAbsolute (s : String) : Bool :=
  match s.toList with
  | [] => false
  | '/' :: _ => true
  | '\\' :: _ => true
  | drive :: ':' :: sep :: _ => isDriveLetter drive && (sep == '/' || sep == '\\')
  | _ => false

/-- Resolve one segment against the accumulated ones, or fail on a `..` at the root.

`..` is **resolved**, never matched as a substring: `a/../..` pops `a` and then has nothing left
to pop, which is the escape, while `a/../b` is `b`. A substring check for `".."` would refuse the
second and a check for a leading `"../"` would accept the first. -/
def step : Option (List String) → String → Option (List String)
  | none, _ => none
  | some acc, seg =>
    if seg == "" || seg == "." then some acc
    else if seg == ".." then
      match acc.reverse with
      | [] => none
      | _ :: rest => some rest.reverse
    else some (acc ++ [seg])

/-- Normalise one workspace-relative path, or say why it cannot be one.

A **positive** assertion (ADR-0015): the result is usable because every segment was classified,
never because no rule objected.

`protectedDirectory` is the adapter's own configuration directory and is compared against the
**normalised** first segment, so `./.claude/x` is refused for the same reason `.claude/x` is;
comparing the raw input would have looked at a leading `.` segment and let the second through.

The split is taken on the character list rather than with `String.splitOn`, which is well-founded
and does not reduce in the kernel; on a one-character separator the two agree. -/
def normaliseGrantPath (protectedDirectory : Option String) (input : String) : Verdict :=
  if input.toList.contains '\x00' then .refused .illegalCharacter
  else if input.toList.contains '\\' then .refused .illegalCharacter
  else if isAbsolute input then .refused .absolute
  else
    match ((input.toList.splitOn '/').map String.ofList).foldl step (some []) with
    | none => .refused .escapesRoot
    | some [] => .refused .empty
    | some (first :: rest) =>
      if protectedDirectory == some first then .refused .protectedDirectory
      else .ok (first :: rest)

/-- One grant, after normalisation. -/
structure Grant where
  /-- `true` when the grant covers a whole directory rather than exactly one file. -/
  directory : Bool
  segments : List String
  /-- `true` when the grant is read-only, which is the only kind that forbids a write. -/
  readOnly : Bool
  deriving DecidableEq, Repr, Inhabited

/-- Does `candidate` name the grant itself, or something under it?

Compared **segment by segment**, never as a string prefix: `docs-private/secret` starts with
`docs` as text and is not inside it as a path. A prefix comparison gets that wrong in both
directions, and one of them allows a write the grant did not cover. -/
def isWithin (candidate grant : List String) : Bool :=
  grant.isPrefixOf candidate

/-- Does this grant cover this normalised candidate? A directory covers its descendants; a file
grant covers exactly itself. -/
def covers (g : Grant) (candidate : List String) : Bool :=
  if g.directory then isWithin candidate g.segments else candidate == g.segments

/-- May the engine be allowed to **write** this path?

The rule the T3 adversarial theorem states: a write is allowed only when the normalised path
lands outside every read-only grant. A path that does not normalise is refused rather than
compared — an input this function could not read is not one it may vouch for. -/
def writeGrantVerdict (protectedDirectory : Option String) (grants : List Grant)
    (candidate : String) : Verdict :=
  match normaliseGrantPath protectedDirectory candidate with
  | .refused r => .refused r
  | .ok segments =>
    if grants.any (fun g => g.readOnly && covers g segments) then .refused .escapesRoot
    else .ok segments

/-- Normalise a whole grant list, refusing the **list** rather than dropping an entry.

Dropping the entry that could not be read would compile a *narrower* protection set than the one
the control plane sent, and the run would start looking exactly as though it had been granted
correctly. -/
def normaliseGrants (protectedDirectory : Option String)
    (grants : List (Bool × String × Bool)) : Option (List Grant) :=
  grants.foldl
    (fun acc g =>
      match acc with
      | none => none
      | some done =>
        match normaliseGrantPath protectedDirectory g.2.1 with
        | .refused _ => none
        | .ok segments => some (done ++ [{ directory := g.1, segments, readOnly := g.2.2 }]))
    (some [])

end AgentWorkspace.Authz.PathGrant
