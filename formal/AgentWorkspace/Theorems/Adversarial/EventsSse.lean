import AgentWorkspace.Events.Sse

namespace AgentWorkspace.Theorems.Adversarial.EventsSse

open AgentWorkspace AgentWorkspace.Events

/-- A runtime cannot append a control frame or the platform status event through the relay
name classifier. -/
@[aw_spec (tier := T3) (doc := "docs/adr/W1-CP-04-event-names-are-validated-at-ingestion.md#decision")
  (ts := "apps/web/server/runs/sse.ts#classifyEventName")]
theorem runtime_cannot_claim_control_or_platform_name :
    Sse.classifyEventName "done" = .reserved "done" ∧
    Sse.classifyEventName "run-failed" = .reserved "run-failed" ∧
    Sse.classifyEventName "stream-reset" = .reserved "stream-reset" ∧
    Sse.classifyEventName "error" = .reserved "error" ∧
    Sse.classifyEventName "run.status" = .reserved "run.status" ∧
    Sse.classifyEventName "run.warning" = .reserved "run.warning" := by
  decide +kernel

/-- The platform append path admits its own events and refuses runtime and control names. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/sse.ts#classifyPlatformEventName")]
theorem platform_path_admits_only_its_own_names :
    Sse.classifyPlatformEventName "run.status" = .ok "run.status" ∧
    Sse.classifyPlatformEventName "run.warning" = .ok "run.warning" ∧
    Sse.classifyPlatformEventName "system" = .rejected ∧
    Sse.classifyPlatformEventName "done" = .rejected := by
  decide +kernel

/-- No control name may be rendered as a durable event, while the platform's events are valid. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/runs/sse.ts#classifyStoredEventName")]
theorem durable_wire_refuses_control_names :
    (Sse.serverControlNames.all fun name =>
      decide (Sse.classifyStoredEventName name = .rejected)) = true ∧
    Sse.classifyStoredEventName "run.status" = .ok "run.status" ∧
    Sse.classifyStoredEventName "run.warning" = .ok "run.warning" := by
  decide +kernel

/-- A newline-bearing event name is refused before it can create another SSE field or frame. -/
@[aw_spec (tier := T3) (doc := "docs/adr/W1-CP-04-event-names-are-validated-at-ingestion.md#decision")
  (ts := "apps/web/server/runs/sse.ts#classifyEventName")]
theorem name_injection_is_refused :
    Sse.classifyEventName "system\ndata: forged" = .rejected ∧
    Sse.classifyEventName "system\r\nevent: done" = .rejected := by
  decide +kernel

/-- Every relayed name the server accepts satisfies the narrow event-name grammar. -/
@[aw_spec (tier := T3) (doc := "docs/adr/W1-CP-04-event-names-are-validated-at-ingestion.md#decision")
  (ts := "apps/web/server/runs/sse.ts#classifyEventName")]
theorem accepted_runtime_name_is_in_grammar (raw name : String)
    (h : Sse.classifyEventName raw = .ok name) :
    AgentWorkspace.Contracts.RunEvents.eventNamePattern raw = true := by
  unfold Sse.classifyEventName at h
  split at h
  · cases h
  · rename_i hvalid
    simpa using hvalid

end AgentWorkspace.Theorems.Adversarial.EventsSse
