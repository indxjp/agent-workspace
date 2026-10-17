import AgentWorkspace.Events.RunLog
import AgentWorkspace.Prelude.Text

/-! `Last-Event-ID` and `?after=` selection, including the invalid-present distinction. -/

namespace AgentWorkspace.Events.Resume

open AgentWorkspace

@[aw_spec (ts := "apps/web/server/runs/sse.ts#MAX_EVENT_ID")]
def maxEventId : Nat := 9223372036854775807

inductive Source where
  | header
  | query
  deriving DecidableEq, Repr

inductive Cursor where
  | absent
  /-- `subIndex` is the position **within** row `id` the client last saw, or `none` when the id named
  a whole row. Since ENG-03 (#302) a pre-ENG-03 row is upgraded on read into one or more neutral
  frames, which share the row's sequence and are told apart by that position
  (`Events/AgentFrames.lean`'s `wireEventId`). -/
  | after (id : Nat) (subIndex : Option Nat) (source : Source)
  | invalid (source : Source)
  deriving DecidableEq, Repr

def asciiDigit (c : Char) : Bool := '0' ≤ c && c ≤ '9'

/-- The sequence part of an id, over characters that are already trimmed: 1–19 ASCII digits whose
value fits `maxEventId`. Kept on `List Char` so every cursor decision reduces by `decide`. -/
def parseIdChars (cs : List Char) : Option Nat :=
  if cs.isEmpty || cs.length > 19 || !cs.all asciiDigit then none
  else
    let n := Text.digitsValue cs
    if n ≤ maxEventId then some n else none

/-- The sequence part of an id: at most 19 digits, because `maxEventId` has 19, and inside the range
the column that has to store it can hold. -/
@[aw_spec (ts := "apps/web/server/runs/cursor.ts#readResumeCursor")]
def parseId (raw : String) : Option Nat :=
  parseIdChars (Text.jsTrimList raw.toList)

/-- The sub-index part: at most 3 digits, bounded for the same reason the sequence is — it is
client-supplied and every part of it must have a known range before anything compares it. -/
def parseSubIndex (cs : List Char) : Option Nat :=
  if cs.isEmpty || cs.length > 3 || !cs.all asciiDigit then none
  else some (Text.digitsValue cs)

/-- The characters before the first `.`, and those after it when there is one. Structural, so that
`decide` can evaluate a cursor (`String.splitOn` is well-founded and does not reduce in the kernel).
A second `.` stays in the sub-index part, which `parseSubIndex` then rejects — exactly the anchored
`^(\d{1,19})(?:\.(\d{1,3}))?$` of `cursor.ts`. -/
def splitAtDot : List Char → List Char × Option (List Char)
  | [] => ([], none)
  | c :: rest =>
    if c = '.' then ([], some rest)
    else match splitAtDot rest with
      | (before, after) => (c :: before, after)

/-- `<sequence>[.<sub-index>]`, the whole grammar `sse.ts`'s `WIRE_EVENT_ID_PATTERN` documents. -/
@[aw_spec (ts := "apps/web/server/runs/cursor.ts#readResumeCursor")]
def parseFrameId (raw : String) : Option (Nat × Option Nat) :=
  match splitAtDot (Text.jsTrimList raw.toList) with
  | (sequence, none) => (parseIdChars sequence).map fun n => (n, none)
  | (sequence, some sub) =>
    (parseIdChars sequence).bind fun n => (parseSubIndex sub).map fun i => (n, some i)

/-- The header wins even if invalid; only a missing header allows a query cursor. -/
@[aw_spec (ts := "apps/web/server/runs/cursor.ts#readResumeCursor")]
def readResumeCursor (header query : Option String) : Cursor :=
  match header with
  | some h => match parseFrameId h with
    | some (n, sub) => .after n sub .header
    | none => .invalid .header
  | none => match query with
    | some q => match parseFrameId q with
      | some (n, sub) => .after n sub .query
      | none => .invalid .query
    | none => .absent

/-- What a first connection or a parsed cursor asks the log for; invalid input stops before a
database query.

A cursor that named a frame inside a row asks for `id - 1`, because the store seeks by row and the
frames of that row are then filtered by `AgentFrames.resumeWithinRow`. -/
def toAfter : Cursor → Option (Option Nat)
  | .absent => some none
  | .after n none _ => some (some n)
  | .after n (some _) _ => some (some (n - 1))
  | .invalid _ => none

end AgentWorkspace.Events.Resume
