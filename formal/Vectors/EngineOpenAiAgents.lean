import AgentWorkspace.Theorems.Normative.OpenAiAgents
import AgentWorkspace.Theorems.Adversarial.OpenAiAgents
import AgentWorkspace.Theorems.Invariants.OpenAiAgents
import AgentWorkspace.Theorems.Refinement.OpenAiAgents
import AgentWorkspace.Theorems.Invariants.EngineSwitch
import Vectors.Common

/-!
The `engine-openai-agents` family (ENG-09, #308), replayed by
`tests/formal/engine-openai-agents.test.ts` against `@agent-workspace/engine-openai-agents`:

* `compile.json` — `compileOpenAiAgentsRun` over accepted requests and one refusal per capability;
* `tool-plan.json` — `openAiAgentsToolPlan` over all sixteen permission sets, with and without a
  read-only grant;
* `connection.json` — `openAiAgentsModelConnection`, and the one model request it can issue;
* `write.json` — `workspaceWriteAllowed` over grants and candidate spellings;
* `events.json` — `createOpenAiAgentsFrameMapper` over event streams (neutral fields compared; the
  engine-native `raw`, `payload` and parsed `input` are not modelled);
* `session.json` — `EngineStoreSession` over a list store, operation by operation;
* `engine-switch.json` — `translatePolicyForEngineSwitch` over Claude arms (and its reverse), with
  `openAiAgentsToolPlan` under the carried arm's narrowed permissions (ADR-0074 D12).
-/

namespace Vectors.EngineOpenAiAgents

open Lean AgentWorkspace AgentWorkspace.Events.AgentFrames AgentWorkspace.Authz.PathGrant
open AgentWorkspace.Behaviour.Engines.OpenAiAgents

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".OpenAiAgents." ++ name

/-! ## compile.json -/

private def permissionsJson (p : Permissions) : Json :=
  Json.mkObj
    [("readFiles", p.readFiles), ("writeFiles", p.writeFiles), ("runCommands", p.runCommands),
     ("unrestrictedNetwork", p.unrestrictedNetwork)]

private def sessionWire : SessionMode → String
  | .fresh => "fresh"
  | .resume => "resume"
  | .fork => "fork"

private def optStrJson : Option String → Json
  | some s => Json.str s
  | none => Json.null

private def optNatJson : Option Nat → Json
  | some n => Json.num n
  | none => Json.null

private def requestJson (r : Request) : Json :=
  Json.mkObj
    [("policyReadable", r.policyReadable), ("permissions", permissionsJson r.permissions),
     ("model", optStrJson r.model), ("skills", Lean.toJson r.skills),
     ("session", sessionWire r.session), ("maxTurns", optNatJson r.maxTurns),
     ("budgetCap", r.budgetCap),
     ("gateway",
       match r.gateway with
       | some (b, tok, w) => Json.mkObj [("baseUrl", b), ("token", tok), ("protocol", w)]
       | none => Json.null),
     ("environmentClean", r.environmentClean),
     ("grants",
       Json.arr (r.grants.map fun (d, p, ro) =>
         Json.mkObj [("directory", d), ("path", p), ("readOnly", ro)]).toArray),
     ("connectors",
       Json.arr (r.connectors.map fun c =>
         Json.mkObj [("name", c.name), ("remote", c.remote),
           ("asksApproval", c.asksApproval)]).toArray)]

private def connectionJson (c : Connection) : Json :=
  Json.mkObj
    [("protocol", c.protocol.toWire), ("client", c.client.toWire), ("endpoint", c.endpoint),
     ("authorization", c.authorization)]

private def grantJson (g : Grant) : Json :=
  Json.mkObj
    [("directory", g.directory), ("path", String.intercalate "/" g.segments),
     ("readOnly", g.readOnly)]

private def outcomeJson : Outcome → Json
  | .ok c =>
    Json.mkObj
      [("ok", true), ("tools", Lean.toJson (c.tools.map Tool.name)),
       ("networkEgress", c.networkEgress), ("connection", connectionJson c.connection),
       ("connectors", Lean.toJson c.connectors), ("maxTurns", optNatJson c.maxTurns),
       ("budgetCap", c.budgetCap),
       ("grants", Json.arr (c.grants.map grantJson).toArray),
       ("tracingDisabled", c.tracingDisabled)]
  | .refused r => Json.mkObj [("ok", false), ("code", r.code), ("names", r.names)]

private def refusalWitness (r : Behaviour.Engines.OpenAiAgents.Refusal) : List String :=
  match r.names with
  | "skills" => [t "Normative" "a_granted_skill_is_refused_by_name"]
  | "fork" => [t "Normative" "a_fork_is_refused_by_name"]
  | "maxBudget" => [t "Normative" "an_unpriced_budget_cap_is_refused_by_name"]
  | "wireProtocols" => [t "Normative" "an_unspoken_protocol_is_refused_by_name"]
  | "model" => [t "Normative" "anthropic_without_a_model_is_refused_by_name"]
  | "approvals" => [t "Normative" "an_unhonourable_connector_is_refused_by_name"]
  | _ => []

private def compileVector (id : String) (r : Request) : Vector :=
  let outcome := compile r
  { id, input := requestJson r, expected := outcomeJson outcome,
    witnesses :=
      match outcome with
      | .ok _ =>
        [t "Normative" "accepted_agent_offers_exactly_the_permitted_tools",
         t "Normative" "no_vendor_hosted_tool_is_compiled",
         t "Normative" "compiled_protocol_is_the_gateway_protocol",
         t "Adversarial" "every_model_request_goes_to_the_gateway_with_the_run_token",
         t "Adversarial" "tracing_is_disabled_for_every_compiled_run",
         t "Normative" "an_accepted_budget_cap_is_priced_and_compiled"] ++
          (if r.connectors.any (·.remote) then
            [t "Normative" "a_remote_connector_needs_no_network_switch"] else [])
      | .refused refusal => refusalWitness refusal }

private def everything : Permissions :=
  { readFiles := true, writeFiles := true, runCommands := true, unrestrictedNetwork := true }

private def base : Request :=
  { policyReadable := true, permissions := everything, model := some "gpt-5", skills := [],
    session := .fresh, maxTurns := none, budgetCap := false,
    gateway := some ("http://gateway.invalid", "run-token", "openai-responses"),
    environmentClean := true, grants := [], connectors := [] }

def compileVectors : List Vector :=
  [compileVector "responses-everything" base,
   compileVector "chat-completions-default-model"
     { base with model := none,
                 gateway := some ("http://gateway.invalid/", "run-token", "openai-chat-completions") },
   compileVector "anthropic-with-model"
     { base with model := some "claude-sonnet-4-5",
                 gateway := some ("http://gateway.invalid", "run-token", "anthropic-messages") },
   compileVector "read-only-grant-withholds-shell"
     { base with maxTurns := some 2,
                 grants := [(true, "docs", true), (false, "notes/plan.md", false)] },
   compileVector "read-and-commands-only"
     { base with permissions := { everything with writeFiles := false,
                                                   unrestrictedNetwork := false } },
   compileVector "connectors-stdio-and-remote"
     { base with connectors := [⟨"files", false, false⟩, ⟨"github", true, false⟩] },
   compileVector "stdio-connector-without-network"
     { base with permissions := { everything with unrestrictedNetwork := false },
                 connectors := [⟨"files", false, false⟩] },
   compileVector "resume" { base with session := .resume },
   compileVector "unreadable-policy" { base with policyReadable := false },
   compileVector "grant-into-protected-directory"
     { base with grants := [(false, ".openai-agents/settings.json", true)] },
   compileVector "grant-escaping-root" { base with grants := [(false, "../etc/passwd", true)] },
   compileVector "skill" { base with skills := ["support"] },
   compileVector "fork" { base with session := .fork },
   compileVector "budget-cap-on-a-priced-model" { base with budgetCap := true },
   compileVector "budget-cap-on-an-unpriced-model"
     { base with budgetCap := true, model := some "gpt-unlisted" },
   compileVector "budget-cap-on-the-default-model"
     { base with budgetCap := true, model := none,
                 gateway := some ("http://gateway.invalid", "run-token", "openai-chat-completions") },
   compileVector "no-gateway" { base with gateway := none },
   compileVector "unspoken-protocol"
     { base with gateway := some ("http://gateway.invalid", "run-token", "gemini-generate") },
   compileVector "anthropic-without-model"
     { base with model := none,
                 gateway := some ("http://gateway.invalid", "run-token", "anthropic-messages") },
   compileVector "provider-credential-in-environment" { base with environmentClean := false },
   compileVector "connector-asking-approval"
     { base with connectors := [⟨"github", true, true⟩] },
   compileVector "remote-connector-without-network"
     { base with permissions := { everything with unrestrictedNetwork := false },
                 connectors := [⟨"github", true, false⟩] }]

/-! ## tool-plan.json -/

private def allPermissions : List Permissions :=
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

private def connectionVector (id : String) (p : Protocol) (baseUrl token : String) : Vector :=
  let c := connectionFor p baseUrl token
  { id,
    input := Json.mkObj [("protocol", p.toWire), ("baseUrl", baseUrl), ("token", token)],
    expected := Json.mkObj
      [("connection", connectionJson c),
       ("requests", Json.arr ((modelRequests c).map fun (url, auth) =>
          Json.mkObj [("url", url), ("authorization", auth)]).toArray)],
    witnesses := [t "Adversarial" "every_model_request_goes_to_the_gateway_with_the_run_token",
                  t "Normative" "the_protocol_follows_the_connection"] }

def connectionVectors : List Vector :=
  [connectionVector "responses" .openaiResponses "http://gateway:8080" "run-token-1",
   connectionVector "chat-completions-trailing-slash" .openaiChatCompletions
     "https://gw.example/" "run-token-2",
   connectionVector "anthropic-messages" .anthropicMessages "https://gw.example//" "run-token-3"]

/-! ## write.json -/

private def writeGrants : List (Bool × String × Bool) :=
  [(true, "docs", true), (false, "notes/plan.md", true), (true, "src", false)]

private def writeVector (candidate : String) : Vector :=
  match normaliseGrants (some protectedDirectory) writeGrants with
  | none => { id := candidate, input := Json.null, expected := Json.null, witnesses := [] }
  | some grants =>
    let c : Compiled :=
      { tools := [.applyPatch], networkEgress := false,
        connection := connectionFor .openaiResponses "http://gw" "tok", connectors := [],
        maxTurns := none, budgetCap := false, grants, tracingDisabled := true }
    { id := candidate,
      input := Json.mkObj
        [("grants", Json.arr (writeGrants.map fun (d, p, ro) =>
            Json.mkObj [("directory", d), ("path", p), ("readOnly", ro)]).toArray),
         ("candidate", candidate)],
      expected := Json.mkObj [("allowed", writeAllowed c candidate)],
      witnesses := [t "Adversarial" "no_permitted_write_lands_in_a_read_only_grant"] }

def writeVectors : List Vector :=
  ["docs", "docs/spec.md", "docs/./spec.md", "notes/../docs/spec.md", "docs/deep/er.md",
   "notes/plan.md", "notes/other.md", "docs-private/draft.md", "src/main.ts", "scratch/out.md",
   ".openai-agents/settings.json", "x/../.openai-agents/settings.json", "../escape.md",
   "/etc/passwd"].map writeVector

/-! ## events.json -/

private def usageJson (u : Usage) : Json :=
  Json.mkObj
    [("inputTokens", Json.num u.inputTokens), ("outputTokens", Json.num u.outputTokens),
     ("cachedInputTokens", optNatJson u.cacheReadInputTokens),
     ("reasoningTokens", optNatJson u.reasoningTokens)]

private def eventJson : Event → Json
  | .textDelta id d => Json.mkObj [("kind", "textDelta"), ("itemId", optStrJson id), ("delta", d)]
  | .reasoningDelta id d =>
    Json.mkObj [("kind", "reasoningDelta"), ("itemId", optStrJson id), ("delta", d)]
  | .rawOther type => Json.mkObj [("kind", "rawOther"), ("type", type)]
  | .rawUntyped => Json.mkObj [("kind", "rawUntyped")]
  | .messageCreated id texts =>
    Json.mkObj [("kind", "messageCreated"), ("id", optStrJson id),
      ("texts", match texts with | some ts => Lean.toJson ts | none => Json.null)]
  | .reasoningCreated id text =>
    Json.mkObj [("kind", "reasoningCreated"), ("id", optStrJson id), ("text", optStrJson text)]
  | .toolCalled f callId name =>
    Json.mkObj [("kind", "toolCalled"), ("isFunction", f), ("callId", optStrJson callId),
      ("name", optStrJson name)]
  | .toolOutput f callId output incomplete =>
    Json.mkObj [("kind", "toolOutput"), ("isFunctionResult", f), ("callId", optStrJson callId),
      ("output", output), ("incomplete", incomplete)]
  | .otherItem name => Json.mkObj [("kind", "otherItem"), ("name", name)]
  | .agentUpdated => Json.mkObj [("kind", "agentUpdated")]
  | .completed stop turns usage =>
    Json.mkObj [("kind", "completed"), ("stopReason", stop.toWire), ("turns", optNatJson turns),
      ("usage", match usage with | some u => usageJson u | none => Json.null)]

private def frameJson (f : Frame) : Json := (encode "openai-agents" .null f).toJson

private def eventsVector (id : String) (ctx : FrameContext) (events : List Event) : Vector :=
  { id,
    input := Json.mkObj
      [("localTools", Lean.toJson ctx.localTools), ("hasMcp", ctx.hasMcp),
       ("events", Json.arr (events.map eventJson).toArray)],
    expected := Json.mkObj [("frames", Json.arr ((mapAll ctx events).map frameJson).toArray)],
    witnesses := [t "Invariants" "the_mapping_never_drops_an_event",
                  t "Invariants" "tool_pairing_holds"] }

private def local_ : FrameContext :=
  { localTools := ["read_file", "list_files", "search_files", "apply_patch", "shell"],
    hasMcp := false }

private def withMcp : FrameContext := { local_ with hasMcp := true }

private def usage : Usage :=
  { inputTokens := 100, outputTokens := 20, cacheReadInputTokens := some 40,
    cacheCreationInputTokens := none, reasoningTokens := some 5 }

def eventVectors : List Vector :=
  [eventsVector "read-patch-test" local_
     [.rawOther "response_started", .textDelta (some "msg_1") "Reading.",
      .toolCalled true (some "call_1") (some "read_file"),
      .toolOutput true (some "call_1") "hello" false,
      .toolCalled true (some "call_2") (some "apply_patch"),
      .toolOutput true (some "call_2") "updated a.md" false,
      .toolCalled true (some "call_3") (some "shell"),
      .toolOutput true (some "call_3") "ERROR: $ npm test\n[exit 1]" false,
      .messageCreated (some "msg_1") (some ["Reading.", " Done."]),
      .rawOther "response_done", .agentUpdated,
      .completed .endTurn (some 1) (some usage)],
   eventsVector "reasoning" local_
     [.reasoningDelta (some "rs_1") "think", .reasoningCreated (some "rs_1") (some "think"),
      .completed .endTurn (some 1) none],
   eventsVector "mcp-tool" withMcp
     [.toolCalled true (some "call_9") (some "echo"), .toolOutput true (some "call_9") "hi" false,
      .completed .endTurn (some 1) none],
   eventsVector "unannounced-output" local_
     [.toolOutput true (some "call_x") "orphan" false, .completed .endTurn none none],
   eventsVector "incomplete-output" local_
     [.toolCalled true (some "c") (some "shell"), .toolOutput true (some "c") "cut" true],
   eventsVector "malformed-and-native" local_
     [.rawUntyped, .messageCreated none none, .reasoningCreated none none,
      .toolCalled true none (some "shell"), .toolOutput true none "x" false,
      .toolCalled false (some "h") (some "web_search"), .toolOutput false (some "h") "x" false,
      .otherItem "handoff_requested", .otherItem "tool_approval_requested"],
   eventsVector "max-turns" local_
     [.toolCalled true (some "a") (some "list_files"), .toolOutput true (some "a") "." false,
      .completed (runOutcome (some 2) 5).2 (some (runOutcome (some 2) 5).1) (some usage)],
   eventsVector "cancelled" local_ [.completed .cancelled (some 0) none]]

/-! ## session.json -/

/-- One session operation, as the replay drives `EngineStoreSession`. -/
private inductive Op where
  | add (items : List String)
  | get (limit : Option Nat)
  | pop
  | clear

private def opJson : Op → Json
  | .add items => Json.mkObj [("op", "add"), ("items", Lean.toJson items)]
  | .get limit => Json.mkObj [("op", "get"), ("limit", optNatJson limit)]
  | .pop => Json.mkObj [("op", "pop")]
  | .clear => Json.mkObj [("op", "clear")]

/-- Run the operations over the model; each answers the value it returns (or `null`). -/
private def runOps : List (Entry String) → List Op → List Json
  | _, [] => []
  | s, .add items :: rest => Json.null :: runOps (addItems s items) rest
  | s, .get limit :: rest =>
    (match getItems s limit with | some xs => Lean.toJson xs | none => Json.null) :: runOps s rest
  | s, .pop :: rest =>
    let (last, next) := popItem s
    optStrJson last :: runOps next rest
  | s, .clear :: rest => Json.null :: runOps (clearSession s) rest

private def sessionVector (id : String) (ops : List Op) : Vector :=
  { id, input := Json.mkObj [("ops", Json.arr (ops.map opJson).toArray)],
    expected := Json.mkObj [("results", Json.arr (runOps [] ops).toArray)],
    witnesses := [t "Refinement" "the_session_refines_the_store"] }

def sessionVectors : List Vector :=
  [sessionVector "two-runs-see-each-other"
     [.add ["u1", "a1"], .get none, .add ["u2"], .get none, .get (some 2)],
   sessionVector "pop-and-clear"
     [.add ["u1", "a1", "u2"], .pop, .get none, .clear, .get none, .pop, .get none],
   sessionVector "empty-add-writes-nothing" [.add [], .get none, .pop]]

/-! ## engine-switch.json (ADR-0074 D12) -/

open AgentWorkspace.Behaviour.Engines.EngineSwitch in
private def modeWire : Mode → String
  | .default => "default"
  | .acceptEdits => "acceptEdits"
  | .bypassPermissions => "bypassPermissions"
  | .plan => "plan"
  | .dontAsk => "dontAsk"
  | .auto => "auto"

private def switchTheorem (name : String) : String :=
  "AgentWorkspace.Theorems.Invariants.EngineSwitch." ++ name

open AgentWorkspace.Behaviour.Engines.EngineSwitch in
private def switchVector (id : String) (a : ClaudeArm) (existing : List Key := []) : Vector :=
  let input := Json.mkObj
    [("kind", "claude-to-openai"),
     ("claude", Json.mkObj
        [("base", match a.base with
                  | none => Json.str "claude_code_preset"
                  | some b => Lean.toJson b),
         ("autoApprove", Lean.toJson a.autoApprove), ("deny", Lean.toJson a.deny),
         ("permissionMode", modeWire a.mode)]),
     ("existing", Lean.toJson (existing.map Key.wire))]
  match translate a existing with
  | .error names =>
    { id, input,
      expected := Json.mkObj [("ok", false), ("refused", Lean.toJson names)],
      witnesses := [switchTheorem "the_switch_refuses_exactly_what_it_cannot_express"] }
  | .ok w =>
    { id, input,
      expected := Json.mkObj
        [("ok", true), ("withheld", Lean.toJson (w.map Key.wire)),
         ("plans", Json.arr (allPermissions.map fun p =>
            Json.mkObj [("permissions", permissionsJson p),
                        ("tools", Lean.toJson ((toolPlan (narrow p w) false).map Tool.name))]).toArray)],
      witnesses := [switchTheorem "the_switch_never_widens_the_tool_plan",
                    switchTheorem "the_switch_refuses_exactly_what_it_cannot_express",
                    switchTheorem "the_narrowing_never_opens_the_network"] }

open AgentWorkspace.Behaviour.Engines.EngineSwitch in
private def reverseVector (id : String) (withheld : List Key) (deny : List String) : Vector :=
  { id,
    input := Json.mkObj [("kind", "openai-to-claude"),
                         ("withheld", Lean.toJson (withheld.map Key.wire)),
                         ("deny", Lean.toJson deny)],
    expected := Json.mkObj [("deny", Lean.toJson (reverseDeny withheld deny))],
    witnesses := [switchTheorem "the_reverse_switch_denies_every_withheld_tool"] }

open AgentWorkspace.Behaviour.Engines.EngineSwitch in
private def preset (deny : List String) (mode : Mode := .default) : ClaudeArm :=
  { base := none, autoApprove := [], deny, mode }

open AgentWorkspace.Behaviour.Engines.EngineSwitch in
def engineSwitchVectors : List Vector :=
  [switchVector "nothing-narrowed" (preset []),
   switchVector "deny-read" (preset ["Read"]),
   switchVector "deny-glob" (preset ["Glob"]),
   switchVector "deny-grep" (preset ["Grep"]),
   switchVector "deny-write" (preset ["Write"]),
   switchVector "deny-edit" (preset ["Edit"]),
   switchVector "deny-notebook-edit" (preset ["NotebookEdit"]),
   switchVector "deny-bash" (preset ["Bash"]),
   switchVector "deny-bash-output" (preset ["BashOutput"]),
   switchVector "deny-kill-shell" (preset ["KillShell"]),
   switchVector "deny-scoped-bash" (preset ["Bash(git push:*)"]),
   switchVector "deny-scoped-write" (preset ["Write(/etc/**)"]),
   switchVector "deny-without-equivalent" (preset ["WebFetch", "WebSearch", "Task"]),
   switchVector "mode-plan" (preset [] .plan),
   switchVector "mode-accept-edits" (preset [] .acceptEdits),
   switchVector "mode-auto" (preset [] .auto),
   switchVector "mode-dont-ask-read-and-bash-approved"
     { base := none, autoApprove := ["Read", "Glob", "Grep", "Bash"], deny := [], mode := .dontAsk },
   switchVector "mode-dont-ask-nothing-approved" (preset [] .dontAsk),
   switchVector "base-list-without-commands"
     { base := some ["Read", "Glob", "Grep", "Edit"], autoApprove := [], deny := [],
       mode := .default },
   switchVector "plan-and-deny-read" (preset ["Read", "Bash"] .plan),
   switchVector "existing-withheld-kept" (preset ["Bash"]) [.unrestrictedNetwork, .readFiles],
   switchVector "refuse-mcp-tool" (preset ["Bash", "mcp__github__delete_repo"]),
   switchVector "refuse-mcp-glob" (preset ["mcp__jira__*"]),
   switchVector "refuse-scoped-mcp" (preset ["mcp__github__issue(write)"]),
   switchVector "refuse-wildcard" (preset ["*"]),
   switchVector "refuse-tool-glob" (preset ["Bash*", "Edit"]),
   reverseVector "reverse-nothing-withheld" [] ["Task"],
   reverseVector "reverse-read" [.readFiles] ["Task"],
   reverseVector "reverse-write" [.writeFiles] [],
   reverseVector "reverse-commands" [.runCommands] ["Bash"],
   reverseVector "reverse-network" [.unrestrictedNetwork] [],
   reverseVector "reverse-all" [.unrestrictedNetwork, .runCommands, .writeFiles, .readFiles] ["Edit"]]

def files : List (String × Json) :=
  [("compile.json", file "engine-openai-agents"
      "compileOpenAiAgentsRun over accepted requests and one refusal per capability" compileVectors),
   ("tool-plan.json", file "engine-openai-agents"
      "openAiAgentsToolPlan over every permission set, with and without a read-only grant"
      toolPlanVectors),
   ("connection.json", file "engine-openai-agents"
      "openAiAgentsModelConnection and the one model request it can issue" connectionVectors),
   ("write.json", file "engine-openai-agents"
      "workspaceWriteAllowed over read-only grants and candidate spellings" writeVectors),
   ("events.json", file "engine-openai-agents"
      "createOpenAiAgentsFrameMapper over SDK event streams" eventVectors),
   ("session.json", file "engine-openai-agents"
      "EngineStoreSession over a list store, operation by operation" sessionVectors),
   ("engine-switch.json", file "engine-openai-agents"
      "translatePolicyForEngineSwitch over Claude arms, and the tool plan under the carried arm"
      engineSwitchVectors)]

end Vectors.EngineOpenAiAgents
