import AgentWorkspace.Theorems.WellFormed.CliRuns

namespace AgentWorkspace.Theorems.Normative.CliRuns

open AgentWorkspace AgentWorkspace.Cli.Runs

/-- Each run command delegates to the corresponding SDK operation. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/04-api-specification.md#7-cli--aw")
  (ts := "packages/aw/src/commands/runs.ts#runCommands")]
theorem every_command_routes_to_sdk :
    sdkCall .start = .start ∧ sdkCall .get = .get ∧ sdkCall .list = .list ∧
    sdkCall .events = .events ∧ sdkCall .follow = .follow ∧
    sdkCall .interrupt = .interrupt ∧ sdkCall .wait = .waitForOutcome := by decide

/-- Start rejects simultaneous wait and follow, otherwise preserving the selected completion mode. -/
@[aw_spec (tier := T1) (ts := "packages/aw/src/commands/runs.ts#start")]
theorem start_mode_cases :
    startMode false false = .plain ∧ startMode true false = .wait ∧
    startMode false true = .follow ∧ startMode true true = .invalid := by decide

/-- Start's selected mode controls its complete SDK call sequence. -/
@[aw_spec (tier := T1) (ts := "packages/aw/src/commands/runs.ts#start")]
theorem start_secondary_dispatch :
    startCalls .plain = [.start] ∧
    startCalls .wait = [.start, .waitForOutcome] ∧
    startCalls .follow = [.start, .follow] ∧
    startCalls .invalid = [] := by decide

/-- Events forwards `--after`, while list forwards the five supported filters in wire order. -/
@[aw_spec (tier := T1) (ts := "packages/aw/src/commands/runs.ts#eventsOptions")
  (ts := "packages/aw/src/commands/runs.ts#runCommands")]
theorem resume_and_list_flags :
    (eventsAfter "r" (some "7")).headers =
      [("accept", "text/event-stream"), ("last-event-id", "7")] ∧
    listFilters (some "completed") (some "agent") (some "project") (some 2)
      (some "next") =
      [("status", "completed"), ("agent", "agent"), ("project", "project"),
        ("limit", "2"), ("cursor", "next")] := by decide

/-- `--json` retains the page and next cursor; a human list and `--jsonl` print rows. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/cli/output-and-exit-codes.mdx#--json")
  (ts := "packages/aw/src/commands/runs.ts#runCommands")]
theorem list_envelope_is_structured :
    listOutputShape .human = "rows" ∧ listOutputShape .json = "page" ∧
    listOutputShape .jsonl = "rows" := by decide

/-- Quiet mode suppresses notices without altering the result payload. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/cli/output-and-exit-codes.mdx#--quiet")
  (ts := "packages/aw/src/output.ts#notice")]
theorem notices_never_enter_stdout :
    listNoticeLines .human false "next page: --cursor x" =
      ["next page: --cursor x"] ∧
    listNoticeLines .human true "next page: --cursor x" = [] ∧
    listNoticeLines .json false "next page: --cursor x" = [] ∧
    listNoticeLines .jsonl false "next page: --cursor x" = ["next page: --cursor x"] ∧
    listNoticeLines .jsonl true "next page: --cursor x" = [] := by decide

/-- Raw emits a done frame; structured output suppresses it and keeps platform frames distinct. -/
@[aw_spec (tier := T1) (doc := "docs/sdk/site/cli/output-and-exit-codes.mdx#--raw-streams-only")
  (ts := "packages/aw/src/stream.ts#renderFrame")]
theorem stream_frame_output_cases :
    outputFrameKind .raw .done = ["raw"] ∧
    outputFrameKind .jsonl .done = [] ∧
    outputFrameKind .jsonl .platform = ["platform"] ∧
    outputFrameKind .jsonl .runtime = ["json-agent"] := by decide

/-- A courtesy interrupt is attempted only when requested after the follow signal aborts. -/
@[aw_spec (tier := T1) (ts := "packages/aw/src/commands/runs.ts#interrupt-on-cancel")]
theorem cancel_interrupt_gate :
    interruptOnCancel true true = true ∧ interruptOnCancel true false = false ∧
    interruptOnCancel false true = false ∧ courtesyTimeoutMs = 5000 := by decide

end AgentWorkspace.Theorems.Normative.CliRuns
