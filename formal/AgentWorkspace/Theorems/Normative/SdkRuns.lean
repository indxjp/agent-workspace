import AgentWorkspace.Theorems.WellFormed.SdkRuns

namespace AgentWorkspace.Theorems.Normative.SdkRuns

open AgentWorkspace AgentWorkspace.Sdk.Runs

/-- Starting a run posts a fully normalized body and expects acceptance. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "packages/sdk/src/resources/runs.ts#start")]
theorem start_request_normalizes_absent_fields :
    start "agent" "go" none none =
      { method := .post, path := "/api/agents/agent/runs", expect := 202,
        body := some (.obj [("prompt", .str "go"), ("sessionId", .null),
          ("modelConnectionId", .null), ("model", .null)]) } := by decide

/-- A supplied session and model pair are carried in the start body without changing the path. -/
@[aw_spec (tier := T1) (ts := "packages/sdk/src/resources/runs.ts#start")]
theorem start_request_keeps_override :
    (start "agent" "go" (some "session") (some ("connection", "model"))).body =
      some (.obj [("prompt", .str "go"), ("sessionId", .str "session"),
        ("modelConnectionId", .str "connection"), ("model", .str "model")]) := by decide

/-- Get, interrupt and token revocation use their distinct paths, verbs, and expected statuses. -/
@[aw_spec (tier := T1) (ts := "packages/sdk/src/resources/runs.ts#get")
  (ts := "packages/sdk/src/resources/runs.ts#interrupt")
  (ts := "packages/sdk/src/resources/runs.ts#revokeTokens")]
theorem record_and_mutation_requests :
    get "r" = { method := .get, path := "/api/runs/r", expect := 200 } ∧
    interrupt "r" = { method := .post, path := "/api/runs/r/interrupt", expect := 200 } ∧
    revokeTokens "r" none =
      { method := .post, path := "/api/runs/r/revoke-tokens", expect := 200,
        body := some (.obj [("tokenId", .null)]) } := by decide

/-- Revoking one token carries its id, while the omitted form sends JSON null. -/
@[aw_spec (tier := T1) (ts := "packages/sdk/src/resources/runs.ts#revokeTokens")]
theorem revoke_one_token_body :
    (revokeTokens "r" (some "token")).body =
      some (.obj [("tokenId", .str "token")]) := by decide

/-- Listing delegates its ordered query to the contract, and events carry the resume header. -/
@[aw_spec (tier := T1) (ts := "packages/sdk/src/resources/runs.ts#list")
  (ts := "packages/sdk/src/resources/runs.ts#events")]
theorem list_and_events_requests :
    list {} = ({ method := .get, path := "/api/runs", expect := 200 }, []) ∧
    events "r" (some "7") =
      { method := .get, path := "/api/runs/r/events", expect := 200,
        headers := [("accept", "text/event-stream"), ("last-event-id", "7")] } := by decide

/-- An absent resume cursor leaves out `Last-Event-ID` rather than sending a null value. -/
@[aw_spec (tier := T1) (ts := "packages/sdk/src/resources/runs.ts#events")]
theorem initial_events_have_no_resume_header :
    (events "r" none).headers = [("accept", "text/event-stream")] := by decide

/-- Fetch and body read classify aborts differently; a successful malformed body breaks the contract. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/timeouts-and-cancellation.mdx#timeoutms-covers-response-headers-only")
  (ts := "packages/sdk/src/http.ts#send")
  (ts := "packages/sdk/src/http.ts#json")]
theorem timeout_and_response_classes :
    fetchFailure false true = .transport true ∧
    streamReadFailure false = .transport false ∧
    classifyResponse 200 409 true "conflict" = some (.apiProblem 409 "conflict") ∧
    classifyResponse 200 200 false "ignored" = some .contractViolation := by decide

/-- A different successful HTTP status still violates the method's expected-status contract. -/
@[aw_spec (tier := T1) (ts := "packages/sdk/src/http.ts#send")]
theorem unexpected_success_status_is_api_problem :
    classifyResponse 200 201 true "unrecognised_error_body" =
      some (.apiProblem 201 "unrecognised_error_body") := by decide

/-- A nonempty list filter retains the contract's key order and values. -/
@[aw_spec (tier := T1) (ts := "packages/sdk/src/resources/runs.ts#list")]
theorem list_keeps_nonempty_query :
    (list { status := some "completed", agent := some "agent", limit := some 2 }).2 =
      [("status", "completed"), ("agent", "agent"), ("limit", "2")] := by decide

/-- The event response must be an SSE body, even when its HTTP status is 200. -/
@[aw_spec (tier := T1) (ts := "packages/sdk/src/resources/runs.ts#events")]
theorem events_refuses_non_stream_success :
    streamResponseFailure true true = none ∧
    streamResponseFailure false true = some .contractViolation ∧
    streamResponseFailure true false = some .contractViolation := by decide

/-- A stream reset reaches the caller without erasing the last durable cursor. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/streaming.mdx#resuming-with-after-and-last-event-id")
  (ts := "packages/sdk/src/resources/runs.ts#follow")]
theorem reset_keeps_resume_cursor :
    onStreamReset { after := some "7", reconnects := 1 } =
      { after := some "7", reconnects := 1 } := rfl

/-- The SDK's ordinary send path makes one fetch, leaving retry policy to the caller. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/guides/retries-and-idempotency.mdx#the-one-built-in-retry-follows-reconnect")
  (ts := "packages/sdk/src/http.ts#send")]
theorem ordinary_requests_are_single_attempt : attemptCount = 1 := rfl

/-- A completed, failed, or cancelled run is settled; a live record after done is a contract error. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#512-runs-and-the-event-stream--awruns")
  (ts := "packages/sdk/src/resources/runs.ts#waitForOutcome")]
theorem wait_requires_settled_record :
    waitOutcome true .completed = none ∧ waitOutcome true .failed = none ∧
    waitOutcome true .cancelled = none ∧
    waitOutcome true .running = some .contractViolation := by decide

/-- An API refusal or transport drop while following remains that error class during wait. -/
@[aw_spec (tier := T1) (ts := "packages/sdk/src/resources/runs.ts#waitForOutcome")]
theorem wait_propagates_follow_failures :
    waitAfterFollow (.error (.apiProblem 404 "run_not_found")) .running =
      some (.apiProblem 404 "run_not_found") ∧
    waitAfterFollow (.error (.transport true)) .running =
      some (.transport true) ∧
    waitAfterFollow (.ok ()) .running = some .contractViolation := by decide

end AgentWorkspace.Theorems.Normative.SdkRuns
