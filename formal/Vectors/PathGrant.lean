import AgentWorkspace.Theorems.Adversarial.PathGrant
import Vectors.Common

/-!
The `path-grant` family: path normalisation and the write decision, replayed against
`packages/engine/src/path-grant.ts` by `tests/formal/path-grant.test.ts`.

The inputs are the spellings an escape is actually written in, not the canonical forms — the
property under test is that the redundant spellings of one path all reach one answer, and a
vector file of canonical paths would prove nothing about that.
-/

namespace Vectors.PathGrant

open Lean AgentWorkspace.Authz.PathGrant

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".PathGrant." ++ name

/-- The refusal, or the normalised path, as the replay compares them. -/
private def verdictJson : Verdict → Json
  | .ok segments => Json.mkObj [("ok", true), ("path", String.intercalate "/" segments)]
  | .refused r =>
    Json.mkObj
      [("ok", false),
       ("refusal",
         match r with
         | .empty => "empty"
         | .absolute => "absolute"
         | .escapesRoot => "escapes_root"
         | .illegalCharacter => "illegal_character"
         | .protectedDirectory => "protected_directory")]

private def normaliseVector (id : String) (protectedDirectory : Option String) (input : String) :
    Vector :=
  { id,
    input :=
      Json.mkObj
        [("path", input),
         ("protectedDirectory",
           match protectedDirectory with
           | none => Json.null
           | some d => Json.str d)],
    expected := verdictJson (normaliseGrantPath protectedDirectory input),
    witnesses :=
      [t "Adversarial" "climbing_above_the_root_is_refused",
       t "Adversarial" "absolute_paths_are_refused"] }

def normaliseVectors : List Vector :=
  [normaliseVector "plain" none "docs/spec.md",
   normaliseVector "leading-dot" none "./docs/spec.md",
   normaliseVector "double-separator" none "docs//spec.md",
   normaliseVector "inner-dot" none "docs/./spec.md",
   normaliseVector "resolved-parent" none "docs/nested/../spec.md",
   normaliseVector "escape-parent" none "../etc/passwd",
   normaliseVector "escape-through" none "docs/../../etc/passwd",
   normaliseVector "escape-bare" none "..",
   normaliseVector "escape-pop-twice" none "a/../..",
   normaliseVector "absolute-posix" none "/etc/passwd",
   normaliseVector "absolute-windows-drive" none "C:/Windows",
   normaliseVector "backslash" none "docs\\spec.md",
   normaliseVector "empty" none "",
   normaliseVector "only-dot" none ".",
   normaliseVector "protected-plain" (some ".claude") ".claude/settings.json",
   normaliseVector "protected-dotted" (some ".claude") "./.claude/settings.json",
   normaliseVector "protected-through-parent" (some ".claude") "x/../.claude/settings.json",
   normaliseVector "protected-other-engine" (some ".scripted-engine") ".claude/settings.json"]

private def readOnlyDocs : List Grant :=
  [{ directory := true, segments := ["docs"], readOnly := true },
   { directory := false, segments := ["config", "app.yaml"], readOnly := true },
   { directory := true, segments := ["scratch"], readOnly := false }]

private def grantJson (g : Grant) : Json :=
  Json.mkObj
    [("kind", if g.directory then "directory" else "file"),
     ("path", String.intercalate "/" g.segments),
     ("access", if g.readOnly then "read" else "read-write")]

private def writeVector (id : String) (candidate : String) : Vector :=
  { id,
    input :=
      Json.mkObj
        [("candidate", candidate),
         ("grants", Json.arr (readOnlyDocs.map grantJson).toArray)],
    expected := verdictJson (writeGrantVerdict none readOnlyDocs candidate),
    witnesses :=
      [t "Adversarial" "allowed_write_is_outside_every_read_only_grant",
       t "Adversarial" "every_spelling_of_a_covered_path_is_refused",
       t "Adversarial" "a_name_that_starts_with_a_grant_is_not_inside_it"] }

def writeVectors : List Vector :=
  [writeVector "covered-file" "docs/spec.md",
   writeVector "covered-dotted" "docs/./spec.md",
   writeVector "covered-through-parent" "notes/../docs/spec.md",
   writeVector "covered-nested-parent" "docs/nested/../spec.md",
   writeVector "covered-directory-itself" "docs",
   writeVector "covered-file-grant" "config/app.yaml",
   writeVector "sibling-of-file-grant" "config/other.yaml",
   writeVector "prefix-not-inside" "docs-private/secret.md",
   writeVector "read-write-grant" "scratch/output.md",
   writeVector "outside-every-grant" "notes.md",
   writeVector "does-not-normalise" "../../etc/passwd"]

def files : List (String × Json) :=
  [("normalise.json",
     file "path-grant" "Path normalisation: the spellings an escape is written in" normaliseVectors),
   ("write.json",
     file "path-grant" "The write decision against a read-only grant list" writeVectors)]

end Vectors.PathGrant
