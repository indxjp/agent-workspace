import AgentWorkspace.Events.Sse

/-! The SDK's named-frame parser and frame splitter. A trailing CR remains pending until the next
chunk or normal end of input resolves whether it is a lone CR or part of CRLF. -/

namespace AgentWorkspace.Events.SdkSse

open AgentWorkspace

structure Frame where
  event : String
  id : Option String
  dataRaw : Option String
  deriving DecidableEq, Repr

private structure Acc where
  event : Option String := none
  id : Option String := none
  data : List String := []

private def fieldValue (line : String) : String × String :=
  let (field, rest) := line.toList.span (· != ':')
  let value := match rest with
    | [] => []
    | _ :: ' ' :: cs => cs
    | _ :: cs => cs
  (String.ofList field, String.ofList value)

private def addLine (a : Acc) (line : String) : Acc :=
  if line == "" || line.toList.head? == some ':' then a
  else
    let (field, value) := fieldValue line
    match field with
    | "event" => { a with event := some value }
    | "id" => { a with id := some value }
    | "data" => { a with data := a.data ++ [value] }
    | _ => a

/-- An empty `id:` remains `some ""`; an unnamed frame is discarded. Later fields override
earlier `event` and `id`, while data lines concatenate. -/
@[aw_spec (ts := "packages/sdk/src/events/sse.ts#parseSseFrame")]
def parseSseFrame (raw : String) : Option Frame :=
  let acc := ((raw.toList.splitOn '\n').map String.ofList).foldl addLine {}
  acc.event.map fun event =>
    ⟨event, acc.id, if acc.data.isEmpty then none else some (String.intercalate "\n" acc.data)⟩

/-- The SDK normalises complete CR, LF, and CRLF line endings, splits on blank lines, and retains
a trailing CR in the partial remainder until another chunk or normal EOF resolves it. -/
@[aw_spec (ts := "packages/sdk/src/events/sse.ts#splitSseFrames")]
private def splitOnBlankLine : List Char → List Char → List String → List String × String
  | [], current, complete => (complete.reverse, String.ofList current.reverse)
  | '\n' :: '\n' :: rest, current, complete =>
    splitOnBlankLine rest [] (String.ofList current.reverse :: complete)
  | c :: rest, current, complete => splitOnBlankLine rest (c :: current) complete

def splitSseFrames (buffer : String) : List String × String :=
  let chars := buffer.toList
  let trailingCr := chars.reverse.head? == some '\r'
  let stable := if trailingCr then (chars.reverse.drop 1).reverse else chars
  let (frames, rest) := splitOnBlankLine (Sse.normalizeNewlines stable) [] []
  (frames, rest ++ if trailingCr then "\r" else "")

inductive Kind where
  | done
  | runFailed
  | streamReset
  | runStatus
  | runWarning
  | runtime (name : String)
  deriving DecidableEq, Repr

@[aw_spec (ts := "packages/sdk/src/events/run-events.ts#classifyRunEventFrame")]
def classifyName (name : String) : Kind :=
  if name == "done" then .done
  else if name == "run-failed" then .runFailed
  else if name == "stream-reset" then .streamReset
  else if name == "run.status" then .runStatus
  else if name == "run.warning" then .runWarning
  else .runtime name

end AgentWorkspace.Events.SdkSse
