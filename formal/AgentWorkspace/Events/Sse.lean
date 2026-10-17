import AgentWorkspace.Events.RunLog

/-! Server event-name validation, SSE framing and terminal control-frame order. -/

namespace AgentWorkspace.Events.Sse

open AgentWorkspace AgentWorkspace.Contracts.RunEvents

@[aw_spec (ts := "apps/web/server/runs/sse.ts#CONTROL_FRAME_NAMES")]
def serverControlNames : List String := ["done", "run-failed", "stream-reset", "error"]

/-- Runner outcome details are untrusted and remain in server diagnostics. Public terminal
records and frames use a stable message chosen by the outcome kind. -/
@[aw_spec (ts := "apps/web/server/runs/launcher.ts#publicRelayFailure")]
def publicRuntimeOutcomeReason (cancelled : Bool) (_privateReason : String) : String :=
  if cancelled then "The run was interrupted." else "The runtime reported a run failure."

def reservedNames : List String := serverControlNames ++ [runStatusEvent]

inductive NameVerdict where
  | ok (name : String)
  | reserved (name : String)
  | rejected
  deriving DecidableEq, Repr

@[aw_spec (ts := "apps/web/server/runs/sse.ts#classifyEventName")]
def classifyEventName (name : String) : NameVerdict :=
  if !eventNamePattern name then .rejected
  else if reservedNames.contains name then .reserved name
  else .ok name

@[aw_spec (ts := "apps/web/server/runs/sse.ts#classifyPlatformEventName")]
def classifyPlatformEventName (name : String) : NameVerdict :=
  if name == runStatusEvent then .ok name else .rejected

@[aw_spec (ts := "apps/web/server/runs/sse.ts#classifyStoredEventName")]
def classifyStoredEventName (name : String) : NameVerdict :=
  if !eventNamePattern name then .rejected
  else if serverControlNames.contains name then .rejected
  else .ok name

@[aw_spec (ts := "apps/web/server/runs/sse.ts#DEFAULT_RETRY_MS")]
def defaultRetryMs : Nat := 3000

@[aw_spec (ts := "apps/web/server/runs/sse.ts#DEFAULT_KEEPALIVE_MS")]
def defaultKeepaliveMs : Nat := 15000

@[aw_spec (ts := "apps/web/server/runs/sse.ts#SSE_HEADERS")]
def headers : List (String × String) :=
  [("Content-Type", "text/event-stream; charset=utf-8"),
   ("Cache-Control", "no-cache, no-transform"), ("X-Accel-Buffering", "no")]

/- Preserve object insertion order as `JSON.stringify` does. JSON values are serialisable by
construction; JavaScript-only values without JSON representations are outside this type. -/
private def jsonEscapeChar (c : Char) : String :=
  if c == '"' then "\\\""
  else if c == '\\' then "\\\\"
  else if c == '\x08' then "\\b"
  else if c == '\x0c' then "\\f"
  else if c == '\n' then "\\n"
  else if c == '\r' then "\\r"
  else if c == '\t' then "\\t"
  else if c.toNat < 0x20 then
    "\\u00" ++ String.singleton (Nat.digitChar (c.toNat / 16)) ++
      String.singleton (Nat.digitChar (c.toNat % 16))
  else String.singleton c

private def jsonQuote (value : String) : String :=
  "\"" ++ (value.toList.map jsonEscapeChar).foldl (· ++ ·) "" ++ "\""

mutual
def dataText : JValue → String
  | .null => "null"
  | .bool true => "true"
  | .bool false => "false"
  | .num mantissa exponent => (Lean.Json.num ⟨mantissa, exponent⟩).compress
  | .str value => jsonQuote value
  | .arr values => "[" ++ dataTextList values ++ "]"
  | .obj fields => "{" ++ dataTextFields fields ++ "}"

def dataTextList : List JValue → String
  | [] => ""
  | [value] => dataText value
  | value :: rest => dataText value ++ "," ++ dataTextList rest

def dataTextFields : List (String × JValue) → String
  | [] => ""
  | [(key, value)] => jsonQuote key ++ ":" ++ dataText value
  | (key, value) :: rest =>
    jsonQuote key ++ ":" ++ dataText value ++ "," ++ dataTextFields rest
end

@[aw_spec (ts := "apps/web/server/runs/sse.ts#sseFrame")]
def durableFrame (event : RunLog.Event) : Option String :=
  match classifyStoredEventName event.name with
  | .ok name => some s!"event: {name}\nid: {event.id}\ndata: {dataText event.data}\n\n"
  | _ => none

@[aw_spec (ts := "apps/web/server/runs/sse.ts#sseControlFrame")]
def controlFrame (name : String) (data : JValue) : String :=
  s!"event: {name}\ndata: {dataText data}\n\n"

@[aw_spec (ts := "apps/web/server/runs/sse.ts#sseRetryFrame")]
def retryFrame (ms : Nat) : String := s!"retry: {if ms = 0 then defaultRetryMs else ms}\n\n"

def collapseNewlines (chars : List Char) : List Char :=
  (chars.foldl (fun (acc : List Char × Bool) c =>
    if c == '\r' || c == '\n' then
      if acc.2 then acc else (acc.1 ++ [' '], true)
    else (acc.1 ++ [c], false)) ([], false)).1

@[aw_spec (ts := "apps/web/server/runs/sse.ts#sseComment")]
def comment (s : String) : String :=
  ": " ++ String.ofList (collapseNewlines s.toList) ++ "\n\n"

inductive Outcome where
  | succeeded
  | failed (status message : String)
  | indeterminate (reason : String)
  deriving DecidableEq, Repr

@[aw_spec (ts := "apps/web/server/runs/api.ts#classifyRunOutcome")]
def classifyRunOutcome (runId : String) (status : Option Contracts.RunStatus)
    (error : Option String) : Outcome :=
  match status with
  | none => .indeterminate s!"run {runId} is no longer readable; its outcome is unknown to this connection"
  | some .completed => .succeeded
  | some .failed => .failed "failed"
      (error.getD s!"run {runId} failed and recorded no message")
  | some .cancelled => .failed "cancelled" (error.getD s!"run {runId} was cancelled")
  | some .queued => .indeterminate s!"the stream for run {runId} ended while the run was still queued; its outcome is unknown to this connection"
  | some .running => .indeterminate s!"the stream for run {runId} ended while the run was still running; its outcome is unknown to this connection"

private def failure (status message : String) : JValue :=
  .obj [("status", .str status), ("message", .str message)]

/-- `done` follows a known failure and an indeterminate outcome alike. A producer exception is a
different path, with no `done`, so the client may reconnect. -/
@[aw_spec (ts := "apps/web/server/runs/sse.ts#sseStreamResponse")]
def outcomeFrames : Outcome → List String
  | .succeeded => [controlFrame "done" (.obj [])]
  | .failed status message =>
    [controlFrame "run-failed" (failure status message), controlFrame "done" (.obj [])]
  | .indeterminate reason =>
    [controlFrame "run-failed" (failure "unknown" reason), controlFrame "done" (.obj [])]

def producerThrowFrames (publicMessage : String) : List String :=
  [controlFrame "run-failed" (failure "unknown" publicMessage)]

/-- A deterministic stream without timed keep-alives: retry, reset prelude, durable events,
terminal frames. -/
def streamFrames (prelude : List (String × JValue)) (events : List RunLog.Event)
    (outcome : Outcome) : Option (List String) := do
  let durable ← events.mapM durableFrame
  pure ([retryFrame defaultRetryMs] ++ prelude.map (fun (n, d) => controlFrame n d) ++
    durable ++ outcomeFrames outcome)

/-- HTML line endings, including a CRLF split across chunks, normalised before relay parsing. -/
def normalizeNewlines : List Char → List Char
  | [] => []
  | '\r' :: '\n' :: rest => '\n' :: normalizeNewlines rest
  | '\r' :: rest => '\n' :: normalizeNewlines rest
  | c :: rest => c :: normalizeNewlines rest

structure LineState where
  buffer : String := ""
  skipLeadingLf : Bool := false
  deriving DecidableEq, Repr

private def scanLines : String → List Char → List String → LineState × List String
  | buffer, [], lines => (⟨buffer, false⟩, lines.reverse)
  | buffer, '\r' :: '\n' :: rest, lines => scanLines "" rest (buffer :: lines)
  | buffer, '\r' :: rest, lines =>
    if rest.isEmpty then (⟨"", true⟩, (buffer :: lines).reverse)
    else scanLines "" rest (buffer :: lines)
  | buffer, '\n' :: rest, lines => scanLines "" rest (buffer :: lines)
  | buffer, c :: rest, lines => scanLines (buffer.push c) rest lines

/-- CR, LF and CRLF terminate relay lines, including a CRLF split across chunk boundaries. -/
@[aw_spec (ts := "apps/web/server/runs/relay.ts#SseLineSplitter")]
def pushLines (state : LineState) (chunk : String) : LineState × List String :=
  let cs := if state.skipLeadingLf && chunk.toList.head? == some '\n'
    then chunk.toList.drop 1 else chunk.toList
  scanLines state.buffer cs []

structure RelayMessage where
  event : Option String
  data : String
  lastEventId : String
  deriving DecidableEq, Repr

structure Assembler where
  event : Option String := none
  data : Option String := none
  lastEventId : String := ""
  deriving DecidableEq, Repr

private def lineField (line : String) : String × String :=
  let (field, rest) := line.toList.span (· != ':')
  let value := match rest with
    | [] => []
    | _ :: ' ' :: cs => cs
    | _ :: cs => cs
  (String.ofList field, String.ofList value)

/-- A blank line dispatches only if at least one `data:` field arrived. An empty `id:` clears
the cursor; an id containing NUL is ignored. -/
@[aw_spec (ts := "apps/web/server/runs/relay.ts#SseMessageAssembler")]
def assembleLine (a : Assembler) (line : String) : Assembler × Option RelayMessage :=
  if line == "" then
    let message := a.data.map fun data =>
      ⟨if a.event == some "" then none else a.event, data, a.lastEventId⟩
    (⟨none, none, a.lastEventId⟩, message)
  else if line.toList.head? == some ':' then (a, none)
  else
    let (field, value) := lineField line
    match field with
    | "event" => ({ a with event := some value }, none)
    | "data" =>
      let nextData := match a.data with
        | none => value
        | some previous => previous ++ "\n" ++ value
      ({ a with data := some nextData }, none)
    | "id" =>
      if value.toList.contains (Char.ofNat 0) then (a, none)
      else ({ a with lastEventId := value }, none)
    | _ => (a, none)

end AgentWorkspace.Events.Sse
