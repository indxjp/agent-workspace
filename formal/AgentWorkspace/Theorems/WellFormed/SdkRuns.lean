import AgentWorkspace.Sdk.Runs

namespace AgentWorkspace.Theorems.WellFormed.SdkRuns

open AgentWorkspace AgentWorkspace.Sdk.Runs

/-- Each of the three accepted problem envelopes keeps its code; other bodies get a stable fallback. -/
@[aw_spec (tier := T0) (ts := "packages/sdk/src/http.ts#readProblem")]
theorem problem_envelopes_keep_codes (code : String) :
    problemCode .standard code = code ∧
    problemCode .detail code = code ∧
    problemCode .bare code = code ∧
    problemCode .unknown code = "unrecognised_error_body" := by simp [problemCode]

/-! The four neutral-view theorems this file used to hold were about `toAgentEvents`, the
Claude-shaped projection every client re-derived. ENG-03 (#302) deleted that function — the stream
itself now carries the neutral vocabulary — so they cannot stay verbatim. Each has a successor that
states the same property about the new frame mapping, in
`Theorems/{WellFormed,Invariants}/AgentFrames.lean`:

* `platform_frames_do_not_invent_events` → `WellFormed.AgentFrames.platform_frames_carry_no_agent_event`;
* `agent_event_fanout_order` → `WellFormed.AgentFrames.engine_message_fans_out_in_order`, and for
  every row `Invariants.AgentFrames.served_frames_keep_emission_order`;
* `missing_result_subtype_is_provider` →
  `WellFormed.AgentFrames.result_without_a_readable_subtype_never_claims_success` — the message is
  now refused by name as `agent.malformed` instead of forwarded as a provider event; either way it
  is not a result and not a success;
* `result_preserves_accounting_and_raw` →
  `WellFormed.AgentFrames.result_frame_preserves_accounting_and_raw`, and for every message
  `WellFormed.AgentFrames.every_frame_of_a_message_carries_its_raw`. -/

end AgentWorkspace.Theorems.WellFormed.SdkRuns
