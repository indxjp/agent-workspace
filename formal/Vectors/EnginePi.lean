import AgentWorkspace.Theorems.Normative.Pi
import AgentWorkspace.Theorems.Adversarial.Pi
import AgentWorkspace.Theorems.Invariants.Pi
import Vectors.Common

/-!
The `engine-pi` family (ENG-08, #307), replayed by `tests/formal/engine-pi.test.ts` against
`@agent-workspace/engine-pi`:

* `compile.json` — `compilePiRun` over accepted requests and one refusal per capability;
* `tool-plan.json` — `piToolPlan` over all sixteen permission sets, with and without a read-only
  grant;
* `connection.json` — `piModelConnection`, and the one model request it can issue;
* `guard.json` — `piToolCallVerdict` over tools, grants and path spellings;
* `events.json` — `createPiFrameMapper` over event streams (neutral fields compared; the
  engine-native `raw`, `payload` and `input` are not modelled);
* `session.json` — `PiSessionMirror.persist` and `readPiStream` over a list store.
-/

namespace Vectors.EnginePi

open Lean AgentWorkspace AgentWorkspace.Events.AgentFrames AgentWorkspace.Authz.PathGrant
open AgentWorkspace.Behaviour.Engines.Pi

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".Pi." ++ name

private def optStrJson : Option String → Json
  | some s => Json.str s
  | none => Json.null

private def optNatJson : Option Nat → Json
  | some n => Json.num n
  | none => Json.null

private def permissionsJson (p : Behaviour.Engines.OpenAiAgents.Permissions) : Json :=
  Json.mkObj
    [("readFiles", p.readFiles), ("writeFiles", p.writeFiles), ("runCommands", p.runCommands),
     ("unrestrictedNetwork", p.unrestrictedNetwork)]

/-! ## compile.json -/

private def sessionWire : SessionMode → String
  | .fresh => "fresh"
  | .resume => "resume"
  | .fork => "fork"

private def grantsJson (grants : List (Bool × String × Bool)) : Json :=
  Json.arr (grants.map fun (d, p, ro) =>
    Json.mkObj [("directory", d), ("path", p), ("readOnly", ro)]).toArray

private def requestJson (r : Request) : Json :=
  Json.mkObj
    [("cwd", r.cwd), ("policyReadable", r.policyReadable),
     ("permissions", permissionsJson r.permissions),
     ("model", optStrJson r.model), ("skills", Lean.toJson r.skills),
     ("session", sessionWire r.session), ("forksIntoItself", r.forksIntoItself),
     ("maxTurns", optNatJson r.maxTurns), ("budgetCap", r.budgetCap),
     ("gateway",
       match r.gateway with
       | some (b, tok, w) => Json.mkObj [("baseUrl", b), ("token", tok), ("protocol", w)]
       | none => Json.null),
     ("environmentClean", r.environmentClean), ("grants", grantsJson r.grants),
     ("connectors", Lean.toJson r.connectors)]

private def connectionJson (c : Connection) : Json :=
  Json.mkObj
    [("protocol", "anthropic-messages"), ("provider", "anthropic"), ("baseUrl", c.baseUrl),
     ("headers", Json.mkObj [("authorization", c.authorization)]), ("apiKey", c.apiKey)]

private def grantJson (g : Grant) : Json :=
  Json.mkObj
    [("directory", g.directory), ("path", String.intercalate "/" g.segments),
     ("readOnly", g.readOnly)]

private def outcomeJson : Outcome → Json
  | .ok c =>
    Json.mkObj
      [("ok", true), ("cwd", c.cwd), ("tools", Lean.toJson (c.tools.map Tool.name)),
       ("networkEgress", c.networkEgress), ("connection", connectionJson c.connection),
       ("model", c.model), ("maxTurns", optNatJson c.maxTurns), ("budgetCap", c.budgetCap),
       ("grants", Json.arr (c.grants.map grantJson).toArray), ("skills", Lean.toJson c.skills)]
  | .refused r => Json.mkObj [("ok", false), ("code", r.code), ("names", r.names)]

private def refusalWitness (r : Behaviour.Engines.OpenAiAgents.Refusal) : List String :=
  match r.names with
  | "mcp" => [t "Normative" "a_connector_is_refused_by_name"]
  | "maxBudget" => [t "Normative" "an_unpriced_budget_cap_is_refused_by_name"]
  | "wireProtocols" => [t "Normative" "an_unspoken_protocol_is_refused_by_name"]
  | _ => []

private def compileVector (id : String) (r : Request) : Vector :=
  let outcome := compile r
  { id, input := requestJson r, expected := outcomeJson outcome,
    witnesses :=
      match outcome with
      | .ok _ =>
        [t "Normative" "accepted_agent_offers_exactly_the_permitted_tools",
         t "Normative" "no_accepted_agent_has_a_connector",
         t "Adversarial" "every_model_request_goes_to_the_gateway_with_the_run_token"]
      | .refused refusal => refusalWitness refusal }

private def everything : Behaviour.Engines.OpenAiAgents.Permissions :=
  { readFiles := true, writeFiles := true, runCommands := true, unrestrictedNetwork := true }

private def base : Request :=
  { cwd := "/workspace", policyReadable := true, permissions := everything,
    model := some "claude-sonnet-4-5",
    skills := ["writer"], session := .fresh, forksIntoItself := false, maxTurns := none,
    budgetCap := false,
    gateway := some ("http://gateway.invalid", "run-token", "anthropic-messages"),
    environmentClean := true, grants := [], connectors := [] }

def compileVectors : List Vector :=
  [compileVector "everything" base,
   compileVector "default-model-trailing-slash"
     { base with model := none, skills := [],
                 gateway := some ("http://gateway.invalid/", "run-token", "anthropic-messages") },
   compileVector "read-only-grant-withholds-bash"
     { base with maxTurns := some 3,
                 grants := [(true, "docs", true), (false, "notes/plan.md", false)] },
   compileVector "read-and-commands-only"
     { base with permissions := { everything with writeFiles := false,
                                                   unrestrictedNetwork := false } },
   compileVector "no-commands"
     { base with permissions := { everything with runCommands := false } },
   compileVector "priced-cap" { base with budgetCap := true },
   compileVector "skills-deduplicated-and-sorted" { base with skills := ["b", "a", "a"] },
   compileVector "cwd-trailing-slash" { base with cwd := "/workspace/" },
   compileVector "resume" { base with session := .resume },
   compileVector "fork" { base with session := .fork },
   compileVector "unreadable-policy" { base with policyReadable := false },
   compileVector "grant-into-protected-directory"
     { base with grants := [(false, ".pi/settings.json", false)] },
   compileVector "grant-escaping-root" { base with grants := [(false, "../etc/passwd", true)] },
   compileVector "connector" { base with connectors := ["docs"] },
   compileVector "unpriced-cap" { base with budgetCap := true, model := some "claude-unlisted" },
   compileVector "unpriced-default-model-cap" { base with budgetCap := true, model := none },
   compileVector "no-gateway" { base with gateway := none },
   compileVector "openai-dialect"
     { base with gateway := some ("http://gateway.invalid", "run-token", "openai-responses") },
   compileVector "dirty-environment" { base with environmentClean := false },
   compileVector "fork-into-itself" { base with session := .fork, forksIntoItself := true }]

/-! ## tool-plan.json -/

private def allPermissions : List Behaviour.Engines.OpenAiAgents.Permissions :=
  [false, true].flatMap fun a => [false, true].flatMap fun b => [false, true].flatMap fun c =>
    [false, true].map fun d =>
      { readFiles := a, writeFiles := b, runCommands := c, unrestrictedNetwork := d }

def toolPlanVectors : List Vector :=
  (allPermissions.flatMap fun p => [false, true].map fun ro => (p, ro)).zipIdx.map
    fun ((p, ro), i) =>
      { id := s!"plan-{i}",
        input := Json.mkObj [("permissions", permissionsJson p), ("hasReadOnlyGrant", ro)],
        expected := Json.mkObj [("tools", Lean.toJson ((toolPlan p ro).map Tool.name)),
                                ("networkEgress", p.unrestrictedNetwork)],
        witnesses := [t "Normative" "accepted_agent_offers_exactly_the_permitted_tools"] }

/-! ## connection.json -/

private def connectionVector (id baseUrl token : String) : Vector :=
  let c := connectionFor baseUrl token
  { id,
    input := Json.mkObj [("baseUrl", baseUrl), ("token", token)],
    expected := Json.mkObj
      [("connection", connectionJson c),
       ("requests", Json.arr ((modelRequests c).map fun (url, auth) =>
          Json.mkObj [("url", url), ("authorization", auth)]).toArray)],
    witnesses := [t "Adversarial" "every_model_request_goes_to_the_gateway_with_the_run_token"] }

def connectionVectors : List Vector :=
  [connectionVector "plain" "http://gateway:8787" "run-token-1",
   connectionVector "trailing-slash" "https://gw.example/" "run-token-2",
   connectionVector "trailing-slashes" "https://gw.example//" "run-token-3"]

/-! ## guard.json -/

private def guardGrants : List (Bool × String × Bool) :=
  [(true, "docs", true), (false, "notes/plan.md", true), (true, "src", false)]

/-- The sandbox root the guard vectors resolve against. -/
private def guardCwd : String := "/workspace"

private def guardVector (id : String) (tools : List Tool) (toolName : String)
    (path : Option String) : Vector :=
  match normaliseGrants (some protectedDirectory) guardGrants with
  | none => { id, input := Json.null, expected := Json.null, witnesses := [] }
  | some grants =>
    let c : Compiled :=
      { cwd := guardCwd, tools, networkEgress := false,
        connection := connectionFor "http://gw" "tok",
        model := "claude-sonnet-4-5", maxTurns := none, budgetCap := false, grants,
        skills := [] }
    { id,
      input := Json.mkObj
        [("cwd", guardCwd), ("grants", grantsJson guardGrants),
         ("tools", Lean.toJson (tools.map Tool.name)),
         ("toolName", toolName), ("path", optStrJson path)],
      expected := Json.mkObj [("allow", guard c toolName path)],
      witnesses :=
        if toolName == "bash" then [t "Normative" "the_guard_blocks_bash_when_run_commands_is_off"]
        else [t "Adversarial" "no_permitted_write_lands_in_a_read_only_grant"] }

private def writers : List Tool := [.read, .write, .edit]

def guardVectors : List Vector :=
  (["docs", "docs/spec.md", "docs/./spec.md", "notes/../docs/spec.md", "docs/deep/er.md",
    "notes/plan.md", "notes/other.md", "docs-private/draft.md", "src/main.ts", "scratch/out.md",
    ".pi/settings.json", ".pi/skills/x/SKILL.md", "x/../.pi/extensions/evil.ts",
    "../escape.md", "/etc/passwd", "/workspace/docs/spec.md", "/workspace/notes/plan.md",
    "/workspace/scratch/out.md", "/workspace/.pi/settings.json", "/workspace/../etc/passwd",
    "/workspace", "/workspace/", ".", "./", "/workspacex/out.md", "~/x", "~", "@docs/spec.md",
    "@scratch/out.md", "scratch/a\u00A0b.md", "scratch/a\u3000b.md"].flatMap fun p =>
      [guardVector ("write:" ++ p) writers "write" (some p),
       guardVector ("edit:" ++ p) writers "edit" (some p)]) ++
  [guardVector "read:docs/spec.md" writers "read" (some "docs/spec.md"),
   guardVector "read:../escape.md" writers "read" (some "../escape.md"),
   guardVector "read:no-path" writers "read" none,
   guardVector "read:." writers "read" (some "."),
   guardVector "read:./" writers "read" (some "./"),
   guardVector "read:/workspace" writers "read" (some "/workspace"),
   guardVector "read:/workspace/docs/spec.md" writers "read" (some "/workspace/docs/spec.md"),
   guardVector "read:/workspacex/a.md" writers "read" (some "/workspacex/a.md"),
   guardVector "read:/etc/passwd" writers "read" (some "/etc/passwd"),
   guardVector "read:~/x" writers "read" (some "~/x"),
   guardVector "read:@docs/spec.md" writers "read" (some "@docs/spec.md"),
   guardVector "bash:not-offered" writers "bash" none,
   guardVector "bash:offered" (writers ++ [.bash]) "bash" none,
   guardVector "invented-tool" writers "grep" (some "docs")]

/-! ## events.json -/

private def usageJson (u : Usage) : Json :=
  Json.mkObj
    [("inputTokens", Json.num u.inputTokens), ("outputTokens", Json.num u.outputTokens),
     ("cacheReadInputTokens", optNatJson u.cacheReadInputTokens),
     ("cacheCreationInputTokens", optNatJson u.cacheCreationInputTokens)]

private def blockJson : Block → Json
  | .text v => Json.mkObj [("type", "text"), ("text", v)]
  | .reasoning v => Json.mkObj [("type", "thinking"), ("thinking", v)]

private def eventJson : Event → Json
  | .textDelta d => Json.mkObj [("kind", "textDelta"), ("delta", d)]
  | .thinkingDelta d => Json.mkObj [("kind", "thinkingDelta"), ("delta", d)]
  | .updateOther type => Json.mkObj [("kind", "updateOther"), ("type", type)]
  | .updateUnreadable => Json.mkObj [("kind", "updateUnreadable")]
  | .assistantEnd id blocks =>
    Json.mkObj [("kind", "assistantEnd"), ("responseId", optStrJson id),
      ("blocks", match blocks with
        | some bs => Json.arr (bs.map blockJson).toArray
        | none => Json.null)]
  | .messageEndOther role => Json.mkObj [("kind", "messageEndOther"), ("role", role)]
  | .messageEndUnreadable => Json.mkObj [("kind", "messageEndUnreadable")]
  | .toolStart callId name =>
    Json.mkObj [("kind", "toolStart"), ("callId", optStrJson callId), ("name", optStrJson name)]
  | .toolEnd callId output isError =>
    Json.mkObj [("kind", "toolEnd"), ("callId", optStrJson callId),
      ("output", optStrJson output), ("isError", isError)]
  | .lifecycle type => Json.mkObj [("kind", "lifecycle"), ("type", type)]
  | .untyped => Json.mkObj [("kind", "untyped")]
  | .completed stop turns usage =>
    Json.mkObj [("kind", "completed"), ("stopReason", stop.toWire), ("turns", Json.num turns),
      ("usage", match usage with | some u => usageJson u | none => Json.null)]

private def frameJson (f : Frame) : Json := (encode "pi" .null f).toJson

private def eventsVector (id : String) (events : List Event) : Vector :=
  { id,
    input := Json.mkObj [("events", Json.arr (events.map eventJson).toArray)],
    expected := Json.mkObj [("frames", Json.arr ((mapAll events).map frameJson).toArray)],
    witnesses := [t "Invariants" "the_mapping_never_drops_an_event",
                  t "Invariants" "tool_pairing_holds"] }

private def usage : Usage :=
  { inputTokens := 22, outputTokens := 8, cacheReadInputTokens := some 4,
    cacheCreationInputTokens := some 0, reasoningTokens := none }

def eventVectors : List Vector :=
  [eventsVector "read-write-and-reply"
     [.lifecycle "agent_start", .lifecycle "turn_start", .messageEndOther "user",
      .updateOther "toolcall_start",
      .assistantEnd (some "msg_1") (some []),
      .toolStart (some "toolu_1") (some "read"), .toolEnd (some "toolu_1") (some "the doc") false,
      .messageEndOther "toolResult", .lifecycle "turn_end",
      .toolStart (some "toolu_2") (some "write"), .toolEnd (some "toolu_2") (some "ok") false,
      .textDelta "Done.", .assistantEnd (some "msg_2") (some [.text "Done."]),
      .lifecycle "agent_end", .lifecycle "agent_settled",
      .completed .endTurn 2 (some usage)],
   eventsVector "thinking"
     [.thinkingDelta "plan", .assistantEnd none (some [.reasoning "plan", .text "answer"]),
      .completed .endTurn 1 none],
   eventsVector "blocked-write"
     [.toolStart (some "t1") (some "edit"), .toolEnd (some "t1") (some "read-only grant") true,
      .toolStart (some "t2") (some "bash"), .toolEnd (some "t2") (some "not offered") true],
   eventsVector "unannounced-and-unreadable"
     [.toolEnd (some "orphan") (some "x") false, .toolEnd none (some "x") false,
      .toolStart none (some "read"), .toolStart (some "t") none,
      .toolStart (some "t3") (some "read"), .toolEnd (some "t3") none false],
   eventsVector "malformed-and-native"
     [.untyped, .updateUnreadable, .messageEndUnreadable, .assistantEnd none none,
      .messageEndOther "system", .lifecycle "compaction_start", .lifecycle "auto_retry_start",
      .toolStart (some "g") (some "grep")],
   eventsVector "max-turns"
     [.toolStart (some "a") (some "read"), .toolEnd (some "a") (some ".") false,
      .completed (turnRun (some 2) 0 [true, true, true]).2 (turnRun (some 2) 0 [true, true, true]).1
        (some usage)],
   eventsVector "cancelled" [.completed .cancelled 0 none],
   eventsVector "duplicate-start"
     [.toolStart (some "c1") (some "read"), .toolStart (some "c1") (some "read"),
      .toolEnd (some "c1") (some "x") false, .toolEnd (some "c1") (some "x") false]]

/-! ## session.json -/

private def lineJson (l : Line) : Json :=
  Json.mkObj [("type", l.kind), ("id", l.id), ("parentId", optStrJson l.parentId)]

private def linesJson (ls : List Line) : Json := Json.arr (ls.map lineJson).toArray

private def header : Line := ⟨"session", "s1", none⟩
private def la : Line := ⟨"model_change", "a", none⟩
private def lb : Line := ⟨"message", "b", some "a"⟩
private def lc : Line := ⟨"message", "c", some "a"⟩
private def ld : Line := ⟨"message", "d", some "c"⟩

/-- Persist `first`, then `second`, into an empty stream, and read the stream back as `sid`. -/
private def sessionVector (id sid : String) (first second : List Line) : Vector :=
  let stream := persist (persist [] first) second
  { id,
    input := Json.mkObj [("sessionId", sid), ("first", linesJson first),
      ("second", linesJson second)],
    expected := Json.mkObj [("stream", linesJson stream),
      ("read", match readStream sid stream with
        | some ls => linesJson ls
        | none => Json.null)],
    witnesses := [t "Invariants" "the_session_tree_round_trips"] }

def sessionVectors : List Vector :=
  [sessionVector "round-trip" "s1" [header, la, lb, lc] [],
   sessionVector "grown-file-appends-only-new-lines" "s1" [header, la, lb] [header, la, lb, lc, ld],
   sessionVector "another-session" "s2" [header, la] [],
   sessionVector "dangling-parent" "s1" [header, ⟨"message", "z", some "nowhere"⟩] [],
   sessionVector "repeated-id" "s1" [header, la, ⟨"label", "a", some "a"⟩] []]

def files : List (String × Json) :=
  [("compile.json", file "engine-pi"
      "compilePiRun: the portable core and the pi arm into tools, a gateway connection and limits, or a refusal naming the capability"
      compileVectors),
   ("tool-plan.json", file "engine-pi"
      "piToolPlan: the four permission switches into pi's built-in tools, bash withheld under a read-only grant"
      toolPlanVectors),
   ("connection.json", file "engine-pi"
      "piModelConnection: the gateway base URL and the run token as the model's Authorization header"
      connectionVectors),
   ("guard.json", file "engine-pi"
      "piToolCallVerdict: the beforeToolCall guard over tools, grants and path spellings"
      guardVectors),
   ("events.json", file "engine-pi"
      "createPiFrameMapper: pi session events into the neutral agent.* frames"
      eventVectors),
   ("session.json", file "engine-pi"
      "PiSessionMirror and readPiStream: pi's JSONL tree over the engine-scoped store"
      sessionVectors)]

end Vectors.EnginePi
