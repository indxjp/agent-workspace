import AgentWorkspace.Theorems.Invariants.SdkRuns
import AgentWorkspace.Events.Sse

namespace AgentWorkspace.Theorems.Refinement.SdkRuns

open AgentWorkspace AgentWorkspace.Sdk.Runs AgentWorkspace.Events

/-- The server's indeterminate outcome ends its stream, while the SDK refuses a still-running record. -/
@[aw_spec (tier := T4) (doc := "docs/sdk/site/guides/streaming.mdx#what-done-does-and-does-not-mean")
  (ts := "apps/web/server/runs/sse.ts#sseStreamResponse")
  (ts := "packages/sdk/src/resources/runs.ts#waitForOutcome")]
theorem indeterminate_done_diverges_from_settled_wait :
    Sse.outcomeFrames (.indeterminate "lost") =
      [Sse.controlFrame "run-failed" (.obj [("status", .str "unknown"),
        ("message", .str "lost")]), Sse.controlFrame "done" (.obj [])] ∧
    waitOutcome true .running = some .contractViolation := by decide +kernel

end AgentWorkspace.Theorems.Refinement.SdkRuns
