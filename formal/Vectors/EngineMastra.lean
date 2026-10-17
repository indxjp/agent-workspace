import AgentWorkspace.Theorems.Normative.Mastra
import AgentWorkspace.Theorems.Adversarial.Mastra
import AgentWorkspace.Theorems.Invariants.Mastra
import Vectors.Common

/-!
The `engine-mastra` family (ENG-10, #309), replayed by `tests/formal/engine-mastra.test.ts` against
`@agent-workspace/engine-mastra`:

* `compile.json` — `compileMastraRun` over accepted requests and one refusal per capability;
* `tool-plan.json` — `mastraToolPlan` over all sixteen permission sets, with and without a
  read-only grant;
* `connection.json` — `mastraModelConnection` per protocol, the explicit provider
  `mastraProviderSpec` decides for it, and the one model request that provider can issue;
* `write.json` — `mastraWriteAllowed` and `mastraRemoveAllowed` over grants and path spellings;
* `events.json` — `createMastraFrameMapper` over chunk streams (neutral fields compared; the
  engine-native `raw`, `payload` and `input` are not modelled);
* `memory.json` — `readMastraThread` over journalled streams;
* `stop.json` — `mastraStopReason` over a drained run's steps, last step reason, limit, cap and
  interrupt;
* `process-env.json` — `mastraInstalledEnvironment` over runner environments.
-/

namespace Vectors.EngineMastra

open Lean AgentWorkspace AgentWorkspace.Events.AgentFrames AgentWorkspace.Authz.PathGrant
open AgentWorkspace.Behaviour.Engines.Mastra

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".Mastra." ++ name

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

private def sessionJson : SessionMode → Json
  | .fresh => Json.mkObj [("mode", "fresh")]
  | .resume sid => Json.mkObj [("mode", "resume"), ("engineSessionId", sid)]
  | .fork sid => Json.mkObj [("mode", "fork"), ("engineSessionId", sid)]

private def grantsJson (grants : List (Bool × String × Bool)) : Json :=
  Json.arr (grants.map fun (d, p, ro) =>
    Json.mkObj [("directory", d), ("path", p), ("readOnly", ro)]).toArray

private def connectorJson (c : Connector) : Json :=
  Json.mkObj [("name", c.name), ("readable", c.readable), ("asksApproval", c.asksApproval)]

private def requestJson (r : Request) : Json :=
  Json.mkObj
    [("cwd", r.cwd), ("sessionId", r.sessionId), ("projectKey", r.projectKey),
     ("policyReadable", r.policyReadable), ("permissions", permissionsJson r.permissions),
     ("model", optStrJson r.model), ("skills", Lean.toJson r.skills),
     ("session", sessionJson r.session), ("maxTurns", optNatJson r.maxTurns),
     ("budgetCap", r.budgetCap),
     ("gateway",
       match r.gateway with
       | some (b, tok, w) => Json.mkObj [("baseUrl", b), ("token", tok), ("protocol", w)]
       | none => Json.null),
     ("environmentClean", r.environmentClean), ("envNames", Lean.toJson r.envNames),
     ("grants", grantsJson r.grants),
     ("connectors", Json.arr (r.connectors.map connectorJson).toArray)]

private def connectionJson (c : Connection) : Json :=
  Json.mkObj
    [("protocol", c.protocol.toWire), ("api", c.api.toWire), ("baseUrl", c.baseUrl),
     ("authorization", c.authorization)]

private def grantJson (g : Grant) : Json :=
  Json.mkObj
    [("directory", g.directory), ("path", String.intercalate "/" g.segments),
     ("readOnly", g.readOnly)]

private def memoryJson (m : Memory) : Json :=
  Json.mkObj
    [("threadId", m.threadId), ("resourceId", m.resourceId),
     ("lastMessages", Json.num m.lastMessages), ("semanticRecall", m.semanticRecall),
     ("workingMemory", m.workingMemory), ("generateTitle", m.generateTitle)]

private def outcomeJson : Outcome → Json
  | .ok c =>
    Json.mkObj
      [("ok", true), ("cwd", c.cwd), ("tools", Lean.toJson (c.tools.map Tool.name)),
       ("skillTools", c.skillTools), ("networkEgress", c.networkEgress),
       ("connection", connectionJson c.connection), ("model", c.model),
       ("maxSteps", optNatJson c.maxSteps), ("budgetCap", c.budgetCap),
       ("grants", Json.arr (c.grants.map grantJson).toArray), ("skills", Lean.toJson c.skills),
       ("connectors", Lean.toJson c.connectors), ("memory", memoryJson c.memory),
       ("observability",
         Json.mkObj [("telemetry", c.observability.telemetry),
           ("exporters", Lean.toJson c.observability.exporters)])]
  | .refused r => Json.mkObj [("ok", false), ("code", r.code), ("names", r.names)]

private def refusalWitness (r : Behaviour.Engines.OpenAiAgents.Refusal) : List String :=
  match r.names with
  | "fork" => [t "Normative" "a_fork_is_refused_by_name"]
  | "maxBudget" => [t "Normative" "an_unpriced_budget_cap_is_refused_by_name"]
  | "wireProtocols" => [t "Normative" "an_unspoken_protocol_is_refused_by_name"]
  | "approvals" => [t "Normative" "an_approval_is_refused_by_name"]
  | "database" => [t "Adversarial" "no_accepted_run_carries_a_database_credential"]
  | _ => []

private def compileVector (id : String) (r : Request) : Vector :=
  let outcome := compile r
  { id, input := requestJson r, expected := outcomeJson outcome,
    witnesses :=
      match outcome with
      | .ok _ =>
        [t "Normative" "accepted_agent_offers_exactly_the_permitted_tools",
         t "Normative" "skills_and_connectors_are_honoured",
         t "Normative" "semantic_recall_and_working_memory_are_off",
         t "Adversarial" "every_model_request_goes_to_the_gateway_with_the_run_token",
         t "Adversarial" "the_model_is_an_explicit_provider_at_the_gateway",
         t "Adversarial" "observability_is_off_for_every_compiled_agent",
         t "Adversarial" "no_accepted_run_carries_a_database_credential",
         t "Invariants" "the_step_limit_is_max_turns"]
      | .refused refusal => refusalWitness refusal }

private def everything : Behaviour.Engines.OpenAiAgents.Permissions :=
  { readFiles := true, writeFiles := true, runCommands := true, unrestrictedNetwork := true }

private def base : Request :=
  { cwd := "/workspace", sessionId := "session-1", projectKey := "tenant-a",
    policyReadable := true, permissions := everything, model := some "claude-sonnet-4-5",
    skills := ["writer"], session := .fresh, maxTurns := none, budgetCap := false,
    gateway := some ("http://gateway.invalid", "run-token", "anthropic-messages"),
    environmentClean := true, envNames := ["HOME", "PATH"], grants := [], connectors := [] }

def compileVectors : List Vector :=
  [compileVector "everything" base,
   compileVector "default-model-trailing-slash"
     { base with model := none, skills := [],
                 gateway := some ("http://gateway.invalid/", "run-token", "anthropic-messages") },
   compileVector "openai-responses-default-model"
     { base with model := none,
                 gateway := some ("http://gateway.invalid", "run-token", "openai-responses") },
   compileVector "openai-chat-completions"
     { base with model := some "gpt-4.1",
                 gateway := some ("http://gateway.invalid", "run-token",
                   "openai-chat-completions") },
   compileVector "read-only-grant-withholds-commands"
     { base with maxTurns := some 3,
                 grants := [(false, "contract.pdf", true), (true, "notes", false)] },
   compileVector "resume-names-the-thread"
     { base with session := .resume "thread-earlier", skills := ["writer", "reviewer", "writer"] },
   compileVector "connectors-in-order"
     { base with connectors := [⟨"docs", true, false⟩, ⟨"search", true, false⟩] },
   compileVector "priced-cap" { base with budgetCap := true },
   compileVector "nothing-permitted"
     { base with skills := [],
                 permissions := { readFiles := false, writeFiles := false, runCommands := false,
                                  unrestrictedNetwork := false } },
   compileVector "unreadable-policy" { base with policyReadable := false },
   compileVector "grant-in-the-adapter-directory"
     { base with grants := [(false, ".mastra/skills/x/SKILL.md", true)] },
   compileVector "no-gateway" { base with gateway := none },
   compileVector "unspoken-protocol"
     { base with gateway := some ("http://gateway.invalid", "run-token", "gemini-generate") },
   compileVector "provider-credential" { base with environmentClean := false },
   compileVector "database-variable" { base with envNames := ["PATH", "DATABASE_URL"] },
   compileVector "database-variable-lower-case" { base with envNames := ["database_url"] },
   compileVector "database-variable-prefixed" { base with envNames := ["X_DATABASE_URL"] },
   compileVector "database-variable-libpq" { base with envNames := ["PGPASSWORD"] },
   compileVector "database-variable-turso" { base with envNames := ["TURSO_AUTH_TOKEN"] },
   compileVector "database-look-alikes-accepted"
     { base with envNames := ["_DATABASE_URL", "DATABASE_URLS", "PGDATA", "MY_DATABASE", "TURSO"] },
   compileVector "unpriced-cap" { base with budgetCap := true, model := some "unpriced-model" },
   compileVector "unreadable-connector" { base with connectors := [⟨"docs", false, false⟩] },
   compileVector "connector-asks-approval" { base with connectors := [⟨"docs", true, true⟩] },
   compileVector "fork" { base with session := .fork "parent-1" }]

/-! ## tool-plan.json -/

private def allPermissions : List Behaviour.Engines.OpenAiAgents.Permissions :=
  [false, true].flatMap fun r => [false, true].flatMap fun w => [false, true].flatMap fun c =>
    [false, true].map fun n =>
      { readFiles := r, writeFiles := w, runCommands := c, unrestrictedNetwork := n }

def toolPlanVectors : List Vector :=
  allPermissions.flatMap fun p => [false, true].map fun ro =>
    { id := s!"r{p.readFiles}-w{p.writeFiles}-c{p.runCommands}-n{p.unrestrictedNetwork}-ro{ro}",
      input := Json.mkObj [("permissions", permissionsJson p), ("hasReadOnlyGrant", Json.bool ro)],
      expected := Lean.toJson ((toolPlan p ro).map Tool.name),
      witnesses := [t "Normative" "accepted_agent_offers_exactly_the_permitted_tools"] }

/-! ## connection.json -/

private def modelSpecJson : ModelSpec → Json
  | .provider spec =>
    Json.mkObj [("kind", "provider"), ("factory", spec.factory.toWire),
      ("option", spec.option.toWire), ("method", spec.method.toWire), ("baseURL", spec.baseURL)]
  | .routedString id => Json.mkObj [("kind", "routedString"), ("id", id)]

private def connectionVector (id : String) (protocol : Behaviour.Engines.OpenAiAgents.Protocol)
    (baseUrl token : String) : Vector :=
  let c := connectionFor protocol baseUrl token
  { id,
    input := Json.mkObj [("protocol", protocol.toWire), ("baseUrl", baseUrl), ("token", token)],
    expected := Json.mkObj
      [("connection", connectionJson c),
       ("requests", Json.arr ((modelRequests c).map fun (url, auth) =>
          Json.mkObj [("url", url), ("authorization", auth)]).toArray),
       ("model", modelSpecJson (modelSpecOf c))],
    witnesses := [t "Adversarial" "every_model_request_goes_to_the_gateway_with_the_run_token",
                  t "Adversarial" "the_model_is_an_explicit_provider_at_the_gateway"] }

def connectionVectors : List Vector :=
  [connectionVector "anthropic-messages" .anthropicMessages "http://gateway.invalid" "run-token",
   connectionVector "anthropic-trailing-slashes" .anthropicMessages "http://gateway:8787//" "t",
   connectionVector "openai-responses" .openaiResponses "https://gw.example" "run-token",
   connectionVector "openai-chat-completions" .openaiChatCompletions "https://gw.example/" "tok"]

/-! ## write.json -/

private def writeGrants : List (Bool × String × Bool) :=
  [(true, "docs", true), (false, "contracts/signed.pdf", true), (false, "notes.md", false)]

private def writeCwd : String := "/workspace"

private def writeCompiled : Compiled :=
  match normaliseGrants (some protectedDirectory) writeGrants with
  | some grants =>
    { cwd := writeCwd, tools := [], skillTools := false, networkEgress := false,
      connection := connectionFor .anthropicMessages "http://gw" "tok",
      model := "claude-sonnet-4-5", maxSteps := none, budgetCap := false, grants,
      skills := [], connectors := [], memory := memoryFor "s" "tenant",
      observability := observabilityOff }
  | none => default

private def writeVector (id path : String) : Vector :=
  { id,
    input := Json.mkObj [("cwd", writeCwd), ("grants", grantsJson writeGrants), ("path", path)],
    expected := Json.mkObj [("allowed", writeAllowed writeCompiled path),
      ("removeAllowed", removeAllowed writeCompiled path)],
    witnesses := [t "Adversarial" "no_permitted_write_lands_in_a_read_only_grant",
                  t "Adversarial" "no_permitted_removal_takes_a_read_only_grant"] }

def writeVectors : List Vector :=
  [writeVector "sibling" "drafts/a.md",
   writeVector "read-write-grant" "notes.md",
   writeVector "absolute-sibling" "/workspace/drafts/a.md",
   writeVector "read-only-directory" "docs/a.md",
   writeVector "read-only-directory-itself" "docs",
   writeVector "read-only-file" "contracts/signed.pdf",
   writeVector "dot-dot-into-read-only" "drafts/../docs/a.md",
   writeVector "absolute-into-read-only" "/workspace/docs/a.md",
   writeVector "adapter-directory" ".mastra/skills/x/SKILL.md",
   writeVector "home" "~/.ssh/id_rsa",
   writeVector "absolute-outside" "/etc/passwd",
   writeVector "prefix-lookalike" "/workspacex/a.md",
   writeVector "climbs-out" "../escape.md",
   writeVector "root-dot" ".",
   writeVector "root-absolute" "/workspace/",
   writeVector "prefix-lookalike-relative" "docs-private/a.md",
   writeVector "parent-of-read-only-file" "contracts",
   writeVector "parent-of-read-only-file-spelled" "drafts/../contracts/",
   writeVector "parent-of-read-only-file-absolute" "/workspace/contracts",
   writeVector "sibling-of-read-only-file" "contracts/unsigned.pdf",
   writeVector "adapter-directory-itself" ".mastra",
   writeVector "read-write-sibling-directory" "drafts"]

/-! ## events.json -/

private def usageJson (u : Usage) : Json :=
  Json.mkObj
    [("inputTokens", Json.num u.inputTokens), ("outputTokens", Json.num u.outputTokens),
     ("cacheReadInputTokens", optNatJson u.cacheReadInputTokens),
     ("cacheCreationInputTokens", optNatJson u.cacheCreationInputTokens),
     ("reasoningTokens", optNatJson u.reasoningTokens)]

private def chunkJson : Chunk → Json
  | .textDelta id text =>
    Json.mkObj [("kind", "textDelta"), ("id", optStrJson id), ("text", optStrJson text)]
  | .reasoningDelta id text =>
    Json.mkObj [("kind", "reasoningDelta"), ("id", optStrJson id), ("text", optStrJson text)]
  | .textEnd id => Json.mkObj [("kind", "textEnd"), ("id", optStrJson id)]
  | .reasoningEnd id => Json.mkObj [("kind", "reasoningEnd"), ("id", optStrJson id)]
  | .toolCall callId name =>
    Json.mkObj [("kind", "toolCall"), ("callId", optStrJson callId), ("name", optStrJson name)]
  | .toolResult callId output isError =>
    Json.mkObj [("kind", "toolResult"), ("callId", optStrJson callId), ("output", output),
      ("isError", isError)]
  | .toolError callId message =>
    Json.mkObj [("kind", "toolError"), ("callId", optStrJson callId), ("message", message)]
  | .error => Json.mkObj [("kind", "error")]
  | .stepFinish => Json.mkObj [("kind", "stepFinish")]
  | .other type => Json.mkObj [("kind", "other"), ("type", type)]
  | .notAnObject => Json.mkObj [("kind", "notAnObject")]
  | .untyped => Json.mkObj [("kind", "untyped")]
  | .completed stop steps usage =>
    Json.mkObj [("kind", "completed"), ("stopReason", stop.toWire), ("steps", Json.num steps),
      ("usage", match usage with | some u => usageJson u | none => Json.null)]

private def frameJson (f : Frame) : Json := (encode "mastra" .null f).toJson

private def eventsVector (id : String) (connectors : List String) (chunks : List Chunk) : Vector :=
  { id,
    input := Json.mkObj [("connectors", Lean.toJson connectors),
      ("chunks", Json.arr (chunks.map chunkJson).toArray)],
    expected := Json.mkObj
      [("frames", Json.arr ((mapAll connectors chunks).map frameJson).toArray)],
    witnesses := [t "Invariants" "the_mapping_never_drops_an_event",
                  t "Invariants" "tool_pairing_holds"] }

private def usage : Usage :=
  { inputTokens := 22, outputTokens := 8, cacheReadInputTokens := some 4,
    cacheCreationInputTokens := some 0, reasoningTokens := none }

def eventVectors : List Vector :=
  [eventsVector "skill-read-edit-command-reply" []
     [.other "start", .other "step-start", .toolCall (some "t1") (some "skill"),
      .toolResult (some "t1") "Always greet with Ahoy." false, .stepFinish,
      .toolCall (some "t2") (some "mastra_workspace_read_file"),
      .toolResult (some "t2") "hello doc" false, .stepFinish,
      .toolCall (some "t3") (some "mastra_workspace_edit_file"),
      .toolResult (some "t3") "edited" false, .stepFinish,
      .toolCall (some "t4") (some "mastra_workspace_execute_command"),
      .toolResult (some "t4") "Ahoy doc" false, .stepFinish,
      .other "text-start", .textDelta (some "x") (some "Ahoy, "),
      .textDelta (some "x") (some "done."), .textEnd (some "x"), .stepFinish,
      .completed .endTurn 5 (some usage)],
   eventsVector "reasoning" []
     [.reasoningDelta (some "r") (some "plan"), .reasoningEnd (some "r"),
      .textDelta (some "t") (some "answer"), .textEnd (some "t"),
      .completed .endTurn 1 none],
   eventsVector "mcp-connector-tool" ["docs"]
     [.toolCall (some "c1") (some "docs_search"), .toolResult (some "c1") "3 hits" false,
      .toolCall (some "c2") (some "docsearch_other"), .toolResult (some "c2") "x" false],
   eventsVector "refused-write" []
     [.toolCall (some "t1") (some "mastra_workspace_write_file"),
      .toolError (some "t1") "write refused: read-only grant"],
   eventsVector "error-chunk" [] [.other "start", .stepFinish, .error],
   eventsVector "error-then-finish" []
     (boundaryEvents [.chunk (.other "start"), .chunk .error, .chunk .stepFinish, .finish]
       (.error, 1, none)),
   eventsVector "unannounced-and-unreadable" []
     [.toolResult (some "orphan") "x" false, .toolResult none "x" false,
      .toolCall none (some "mastra_workspace_read_file"), .toolCall (some "t") none,
      .textDelta none (some "x"), .textDelta (some "x") none, .textEnd none,
      .reasoningEnd none, .notAnObject, .untyped],
   eventsVector "native-chunks" []
     [.other "tool-call-delta", .other "tool-call-approval", .other "data-workspace-metadata",
      .other "step-start"],
   eventsVector "max-turns" []
     [.toolCall (some "a") (some "mastra_workspace_read_file"),
      .toolResult (some "a") "." false, .stepFinish,
      .completed (stepRun (some 1) 0 [true, true]).2 (stepRun (some 1) 0 [true, true]).1
        (some usage)],
   eventsVector "cancelled" [] [.completed .cancelled 0 none],
   eventsVector "duplicate-call" []
     [.toolCall (some "c1") (some "mastra_workspace_grep"),
      .toolCall (some "c1") (some "mastra_workspace_grep"),
      .toolResult (some "c1") "x" false, .toolResult (some "c1") "x" false]]

/-! ## memory.json -/

private def messageJson (m : Behaviour.Engines.Mastra.Message) : Json :=
  Json.mkObj [("id", m.id), ("threadId", m.threadId), ("body", m.body)]

private def entryJson : Entry → Json
  | .thread id => Json.mkObj [("kind", "thread"), ("id", id)]
  | .message m => Json.mkObj [("kind", "message"), ("message", messageJson m)]
  | .foreign => Json.mkObj [("kind", "foreign")]

private def memoryVector (id tid : String) (entries : List Entry) : Vector :=
  { id,
    input := Json.mkObj [("threadId", tid),
      ("entries", Json.arr (entries.map entryJson).toArray)],
    expected := Json.mkObj [("messages",
      match readThread tid entries with
      | some ms => Json.arr (ms.map messageJson).toArray
      | none => Json.null)],
    witnesses := [t "Invariants" "the_thread_round_trips"] }

private def m1 : Behaviour.Engines.Mastra.Message := ⟨"m1", "t", "The code word is heron."⟩
private def m2 : Behaviour.Engines.Mastra.Message := ⟨"m2", "t", "Noted."⟩
private def m1' : Behaviour.Engines.Mastra.Message :=
  ⟨"m1", "t", "The code word is heron (edited)."⟩

def memoryVectors : List Vector :=
  [memoryVector "round-trip" "t" (journal "t" [m1, m2]),
   memoryVector "empty-thread" "t" (journal "t" []),
   memoryVector "update-replaces-in-place" "t" (journal "t" [m1, m2] ++ [.message m1']),
   memoryVector "another-thread" "u" (journal "t" [m1]),
   memoryVector "foreign-message" "t" (journal "t" [m1, ⟨"x", "other", "y"⟩]),
   memoryVector "no-thread-record" "t" [.message m1],
   memoryVector "foreign-entry" "t" (journal "t" [m1] ++ [.foreign])]

/-! ## stop.json -/

private def stopVector (id : String) (steps : Nat) (last : Option String) (maxSteps : Option Nat)
    (overBudget interrupted : Bool) : Vector :=
  { id,
    input := Json.mkObj [("steps", Json.num steps), ("lastStepReason", optStrJson last),
      ("maxSteps", optNatJson maxSteps), ("overBudget", overBudget),
      ("interrupted", interrupted)],
    expected := Json.mkObj
      [("stopReason", (stopReason steps last maxSteps overBudget interrupted).toWire)],
    witnesses := [t "Invariants" "the_stop_reason_follows_the_precedence"] }

def stopVectors : List Vector :=
  [stopVector "no-limit" 3 (some "stop") none false false,
   stopVector "no-limit-tool-calls" 3 (some "tool-calls") none false false,
   stopVector "at-limit-asking-for-tools" 2 (some "tool-calls") (some 2) false false,
   stopVector "at-limit-final-stop" 2 (some "stop") (some 2) false false,
   stopVector "below-limit-asking-for-tools" 1 (some "tool-calls") (some 2) false false,
   stopVector "past-limit-asking-for-tools" 3 (some "tool-calls") (some 2) false false,
   stopVector "no-step-reason" 2 none (some 2) false false,
   stopVector "interrupted" 1 (some "tool-calls") (some 1) false true,
   stopVector "over-budget" 1 (some "tool-calls") (some 1) true false,
   stopVector "over-budget-and-interrupted" 0 none none true true]

/-! ## process-env.json -/

private def envJson (env : List (String × String)) : Json :=
  Json.mkObj (env.map fun (k, v) => (k, Json.str v))

private def processEnvVector (id : String) (env : List (String × String)) : Vector :=
  { id, input := Json.mkObj [("env", envJson env)],
    expected := Json.mkObj [("installed", envJson (installedEnvironment env))],
    witnesses := [t "Adversarial" "observability_is_off_for_every_compiled_agent"] }

def processEnvVectors : List Vector :=
  [processEnvVector "empty" [],
   processEnvVector "telemetry-turned-on" [("MASTRA_TELEMETRY_DISABLED", "0"), ("HOME", "/root")],
   processEnvVector "offline-off" [("MASTRA_OFFLINE", "false")],
   processEnvVector "empty-base-urls-removed"
     [("ANTHROPIC_BASE_URL", ""), ("OPENAI_BASE_URL", ""), ("PATH", "/usr/bin")],
   processEnvVector "set-base-urls-kept"
     [("ANTHROPIC_BASE_URL", "http://gw"), ("OPENAI_BASE_URL", "http://gw/v1")]]

def files : List (String × Json) :=
  [("compile.json", file "engine-mastra"
      "compileMastraRun: the portable core and the mastra arm into workspace tools, a gateway provider, limits and memory, or a refusal naming the capability"
      compileVectors),
   ("tool-plan.json", file "engine-mastra"
      "mastraToolPlan: the four permission switches into Mastra's workspace tools, the command tools withheld under a read-only grant"
      toolPlanVectors),
   ("connection.json", file "engine-mastra"
      "mastraModelConnection: the gateway /v1 prefix, the run token as the bearer, and an explicit provider"
      connectionVectors),
   ("write.json", file "engine-mastra"
      "mastraWriteAllowed: the filesystem wrapper over grants and path spellings"
      writeVectors),
   ("events.json", file "engine-mastra"
      "createMastraFrameMapper: Mastra fullStream chunks into the neutral agent.* frames"
      eventVectors),
   ("memory.json", file "engine-mastra"
      "readMastraThread: a thread journalled into the engine-scoped store, folded back by key"
      memoryVectors),
   ("stop.json", file "engine-mastra"
      "mastraStopReason: the budget cap, then an interrupt, then max_turns exactly when the last allowed step asked for tools"
      stopVectors),
   ("process-env.json", file "engine-mastra"
      "mastraInstalledEnvironment: the process environment Mastra loads under, telemetry and the catalogue refresh off"
      processEnvVectors)]

end Vectors.EngineMastra
