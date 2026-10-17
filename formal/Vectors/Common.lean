import Lean.Data.Json

/-!
The vector-file shape shared by every family:
`{ family, description, vectors: [{ id, input, expected, witnesses }] }`.
-/

namespace Vectors

open Lean

/-- One vector: an input, the model's expected output, and the theorems it witnesses. -/
structure Vector where
  id : String
  input : Json
  expected : Json
  witnesses : List String

def Vector.toJson (v : Vector) : Json :=
  Json.mkObj [("id", v.id), ("input", v.input), ("expected", v.expected),
    ("witnesses", Lean.toJson v.witnesses)]

/-- A vector file for a family. -/
def file (family description : String) (vectors : List Vector) : Json :=
  Json.mkObj [("family", family), ("description", description),
    ("vectors", Json.arr (vectors.map Vector.toJson).toArray)]

/-- Write one family's files under `outDir/family/`. A unit uses this from a scratch file
(`def main : IO Unit := Vectors.writeFamily "x" Vectors.X.files "generated/vectors"`, run with
`lake env lean --run`) before the family is registered in `Vectors/Main.lean`. -/
def writeFamily (family : String) (files : List (String × Json)) (outDir : System.FilePath) :
    IO Unit := do
  for (name, json) in files do
    let path := outDir / family / name
    if let some parent := path.parent then IO.FS.createDirAll parent
    IO.FS.writeFile path (json.pretty 120 ++ "\n")

end Vectors
