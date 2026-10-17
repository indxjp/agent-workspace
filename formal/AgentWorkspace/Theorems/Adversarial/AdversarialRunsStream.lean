import AgentWorkspace.Events.RunLog
import AgentWorkspace.Events.Resume
import AgentWorkspace.Events.SdkSse
import AgentWorkspace.Events.Sse
import AgentWorkspace.Lifecycle.Run
import AgentWorkspace.Sdk.Runs

/-! Adversarial stream observations. These are candidate counterexamples until the corresponding
real parser, repository store, and launcher interleavings have been replayed. -/

namespace AgentWorkspace.Theorems.Adversarial.AdversarialRunsStream

open AgentWorkspace AgentWorkspace.Events AgentWorkspace.Lifecycle

/-- A credential's claimed kind is attacker-controlled at the HTTP boundary; authentication must
establish its actual kind before a route uses it. -/
private inductive CredentialKind where
  | session | apiKey | runToken | browserRun | browserSession
  deriving DecidableEq, Repr

/-- The attacker may choose their own principal/credential, request spelling and headers, stream
bytes, and timing. The model also permits guessed foreign ids and a hostile runtime summary. -/
private structure StreamAttacker where
  principalId : String
  role : String
  workspaceId : String
  credentialKind : CredentialKind
  credential : String
  method : String
  path : String
  body : String
  headers : List (String × String)
  runId : String
  sessionId : String
  cursor : Option Nat
  wire : String
  runtimeEventName : String
  runtimeFailureMessage : String
  interleaving : List RunAction
  deriving DecidableEq, Repr

/-- An injected line terminator cannot turn a runtime event name into an additional SSE field. -/
@[aw_spec (tier := T3) (doc := "docs/adr/W1-CP-04-event-names-are-validated-at-ingestion.md#decision")
  (ts := "apps/web/server/runs/sse.ts#classifyEventName")]
theorem newline_name_injection_rejected :
    Sse.classifyEventName "model.result\nevent: run.status" = .rejected ∧
    Sse.classifyEventName "model.result\r\ndata: forged" = .rejected := by
  decide

/-- Whatever spelling a runtime controlled input uses, an accepted event name satisfies the
wire grammar. This rules out field and frame delimiters for every attacker-chosen name. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/sse.ts#classifyEventName")]
theorem every_accepted_attacker_name_is_grammatical (raw name : String)
    (h : Sse.classifyEventName raw = .ok name) :
    AgentWorkspace.Contracts.RunEvents.eventNamePattern raw = true := by
  unfold Sse.classifyEventName at h
  split at h
  · cases h
  · rename_i valid
    simpa using valid

/-- Neither runtime events nor stored events can take an outward control-frame name. The
platform-only append path admits only its status event. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/sse.ts#classifyEventName")
  (ts := "apps/web/server/runs/sse.ts#classifyPlatformEventName")
  (ts := "apps/web/server/runs/sse.ts#classifyStoredEventName")]
theorem stream_name_channels_stay_separate :
    Sse.classifyEventName "done" = .reserved "done" ∧
    Sse.classifyEventName "run-failed" = .reserved "run-failed" ∧
    Sse.classifyEventName "stream-reset" = .reserved "stream-reset" ∧
    Sse.classifyEventName "error" = .reserved "error" ∧
    Sse.classifyEventName "run.status" = .reserved "run.status" ∧
    Sse.classifyPlatformEventName "model.result" = .rejected ∧
    Sse.classifyPlatformEventName "run.status" = .ok "run.status" ∧
    Sse.classifyStoredEventName "done" = .rejected ∧
    Sse.classifyStoredEventName "run-failed" = .rejected ∧
    Sse.classifyStoredEventName "stream-reset" = .rejected ∧
    Sse.classifyStoredEventName "error" = .rejected := by
  decide

/-- Every accepted platform name is the sole platform status event, regardless of attacker input. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/sse.ts#classifyPlatformEventName")]
theorem platform_acceptance_is_status_only (name admitted : String)
    (h : Sse.classifyPlatformEventName name = .ok admitted) :
    name = AgentWorkspace.Contracts.RunEvents.runStatusEvent := by
  unfold Sse.classifyPlatformEventName at h
  split at h
  · rename_i heq
    simpa using heq
  · cases h

/-- An invalid present header wins over a valid query cursor and stops before event lookup. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/cursor.ts#readResumeCursor")]
theorem invalid_resume_header_cannot_fall_back_to_query :
    Resume.readResumeCursor (some "1\nevent: forged") (some "7") =
      .invalid .header ∧
    Resume.toAfter (Resume.readResumeCursor (some "1\nevent: forged") (some "7")) =
      none := by
  decide

/-- A syntactically numeric cursor beyond the database event-id range cannot enter replay. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/cursor.ts#readResumeCursor")]
theorem oversized_resume_id_is_rejected :
    Resume.parseId "9223372036854775808" = none ∧
    Resume.readResumeCursor (some "9223372036854775808") none = .invalid .header ∧
    Resume.parseId "00000000000000000000" = none := by
  decide

/-- Separate SSE data lines are joined with one newline before JSON decoding, preserving the
payload boundary instead of silently dropping a line. -/
@[aw_spec (tier := T3) (ts := "packages/sdk/src/events/sse.ts#parseSseFrame")]
theorem multiline_sdk_data_is_preserved :
    SdkSse.parseSseFrame "event: x\ndata: {\"a\":\ndata: 1}" =
      some ⟨"x", none, some "{\"a\":\n1}"⟩ ∧
    SdkSse.parseSseFrame "event: x\ndata: {\ndata: \"a\":\ndata: 1}" =
      some ⟨"x", none, some "{\n\"a\":\n1}"⟩ := by
  decide

/-- An empty durable id clears the remembered cursor before a reconnect. -/
@[aw_spec (tier := T3) (ts := "packages/sdk/src/events/sse.ts#parseSseFrame")
  (ts := "packages/sdk/src/resources/runs.ts#follow")]
theorem empty_sdk_id_clears_reconnect_header :
    SdkSse.parseSseFrame "event: run.status\nid:\ndata: {}\n" =
      some ⟨"run.status", some "", some "{}"⟩ ∧
    AgentWorkspace.Sdk.Runs.recordFrameId { after := some "7" } true (some "") =
      { after := none } ∧
    AgentWorkspace.Sdk.Runs.onDrop { after := some "7" } none 5 false
      (.transport false) = .reconnect { after := none, reconnects := 1 } := by
  decide

/-- A resolved lone-CR blank line now completes the SDK frame. -/
@[aw_spec (tier := T3) (ts := "packages/sdk/src/events/sse.ts#splitSseFrames")]
theorem sdk_lone_cr_frame_delivered :
    SdkSse.splitSseFrames "event: x\rdata: {}\r\rX" =
      (["event: x\ndata: {}"], "X") := by
  decide

/-- A final event can arrive after the repository follow loop's list read and before its terminal
read. The repaired loop drains it before exiting. -/
private def listedLog : RunLog.Log := RunLog.empty
private def terminalLog : RunLog.Log :=
  ⟨1, [⟨1, "run.status", .null⟩], true⟩

/-- The final durable drain delivers an event committed between the first list and terminal read. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/store.ts#createRepositoryRunStore")]
theorem repository_terminal_read_drains_tail :
    let cycle := RunLog.repositoryCycle listedLog terminalLog 0 true
    cycle.delivered = [⟨1, "run.status", .null⟩] ∧ cycle.cursor = 1 ∧
    cycle.currentEnds = true ∧ cycle.targetEnds = true := by
  decide

/-- A first connection supplies no cursor, but the retained log starts after id 1. -/
private def truncatedLog : RunLog.Log :=
  ⟨3, [⟨3, "runtime", .null⟩], false⟩

/-- A first subscriber is told that earlier ids were lost before receiving retained id 3. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/store.ts#createRepositoryRunStore")
  (ts := "apps/web/server/runs/store.ts#InMemoryRunStore")]
theorem first_connection_to_truncated_log_resets :
    RunLog.oldest truncatedLog = 3 ∧
    RunLog.resetFor truncatedLog none = some (.gap (some 2)) := by
  decide

/-- A supplied cursor ahead of the newest id must request a reset; it must not wait for an id
that the run may never produce. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/store.ts#createRepositoryRunStore")
  (ts := "apps/web/server/runs/store.ts#InMemoryRunStore")]
theorem ahead_cursor_requests_reset :
    RunLog.resetFor terminalLog (some 7) = some (.ahead (some 0)) ∧
    RunLog.resetFor RunLog.empty (some 7) = some (.ahead none) := by
  decide

/-- Competing terminal writers each attempt one atomic status-and-event commit. -/
private def racedTerminal : RunState :=
  runActions { status := .running }
    [.finishWithStatusEvent .cancelled 1, .finishWithStatusEvent .completed 1]

/-- The losing terminal writer cannot publish a second status event. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/composition/register.ts#interruptRun")
  (ts := "apps/web/server/runs/launcher.ts#conclude")]
theorem interrupt_conclude_commits_one_terminal_event :
    racedTerminal.status = .cancelled ∧
    racedTerminal.terminalEvents = [.cancelled] := by
  decide

/-- Changing the runner's private outcome text cannot change either public terminal message. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/launcher.ts#publicRelayFailure")]
theorem runtime_outcome_text_does_not_reach_public_record
    (first second : String) (cancelled : Bool) :
    Sse.publicRuntimeOutcomeReason cancelled first =
      Sse.publicRuntimeOutcomeReason cancelled second := by
  simp [Sse.publicRuntimeOutcomeReason]

/-- A successful terminal finish closes the log and revokes the run credential. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/store.ts#InMemoryRunStore")
  (ts := "packages/core/src/db/repositories/runs.ts#finish")]
theorem terminal_finish_closes_log_and_revokes_token :
    let finished := runAction { status := .running } (.finish .completed 1)
    finished.logClosed = true ∧ finished.runTokenRevoked = true ∧
    let queuedFinish := runAction ({} : RunState) (.finish .completed 1)
    queuedFinish.status = .completed ∧ queuedFinish.logClosed = true ∧
      queuedFinish.runTokenRevoked = true := by
  decide

/-- An indeterminate stream emits a failure frame and then `done`; a live record after that
terminal marker is rejected by the SDK's wait operation. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/sse.ts#sseStreamResponse")
  (ts := "packages/sdk/src/resources/runs.ts#waitForOutcome")]
theorem indeterminate_done_stops_follow_but_live_wait_fails :
    Sse.outcomeFrames (.indeterminate "lost") =
      [Sse.controlFrame "run-failed" (.obj [("status", .str "unknown"),
        ("message", .str "lost")]), Sse.controlFrame "done" (.obj [])] ∧
    AgentWorkspace.Sdk.Runs.waitOutcome true .running = some .contractViolation := by
  decide

end AgentWorkspace.Theorems.Adversarial.AdversarialRunsStream
