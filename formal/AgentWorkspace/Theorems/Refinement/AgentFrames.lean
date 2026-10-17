import AgentWorkspace.Events.AgentFrames

/-!
# T4 — replaying a legacy run is replaying a fresh one (ENG-03, #302)

The claim the whole "upgrade on read, never migrate" decision rests on: a run recorded before ENG-03
and a fresh run of the same engine messages yield **the same frames**.

It holds because the two paths are literally the same two functions in the same order over the same
input — `classify` then `toAgentFrames` — which is why this is a refinement and not a coincidence to
be re-checked per message shape.

**The hypothesis Lean cannot discharge**, stated rather than assumed away: the stored message is the
JSON round-trip of what the SDK produced (the runner wrote it with `JSON.stringify`, the relay read it
with `JSON.parse`). `classify` reads only `type` and `subtype`, and JSON preserves strings and
objects, so a classification survives the round-trip; a value JSON drops (`undefined`, a function, a
symbol) can only make a discriminant *absent*, which classifies as `malformed` — the same answer as
before it was dropped. `apps/web/formal/legacy-frames.test.ts` exercises it against real rows.
-/

namespace AgentWorkspace.Theorems.Refinement.AgentFrames

open AgentWorkspace AgentWorkspace.Events.AgentFrames

variable (systemSubtypes resultSubtypes eventTypes : List String)

/-- **Replaying a legacy row yields exactly what a fresh run of the same message yields.**

Stated over the envelope the relay actually wrote, so the theorem is about the stored shape and not
about an idealised one. -/
@[aw_spec (tier := T4) (doc := "docs/formal/domains/d1-runs.md#events")
  (ts := "apps/web/server/runs/agent-frames.ts#upgradeStoredEvent")]
theorem legacy_replay_equals_fresh_run (kind : String) (message : JValue) :
    upgradeLegacy systemSubtypes resultSubtypes eventTypes (legacyEnvelope kind message) =
      toAgentFrames (classify systemSubtypes resultSubtypes eventTypes message) := by
  simp [upgradeLegacy, legacyEnvelope, legacyMessage, JValue.lookup]

/-- The upgrade is **deterministic**: it is a function of the stored row and of nothing else — no
clock, no run record, no engine column. Trivial as a proposition, and load-bearing as a statement:
it is why re-deriving on every read cannot drift from what a fresh run produces, which a one-time
data migration could not promise. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/runs/agent-frames.ts#upgradeStoredEvent")]
theorem legacy_upgrade_is_deterministic (data : JValue) :
    upgradeLegacy systemSubtypes resultSubtypes eventTypes data =
      upgradeLegacy systemSubtypes resultSubtypes eventTypes data := rfl

/-- A row that is not the relay's envelope is reported as `agent.malformed`, not guessed at.

"Do not invent a lossy mapping" as a theorem: the only frame such a row can produce is the one that
says its envelope could not be read. -/
@[aw_spec (tier := T4) (ts := "apps/web/server/runs/agent-frames.ts#upgradeStoredEvent")]
theorem unreadable_legacy_row_is_reported_not_guessed (data : JValue) (reason : String)
    (h : legacyMessage data = .error reason) :
    upgradeLegacy systemSubtypes resultSubtypes eventTypes data = [.malformed reason] := by
  simp [upgradeLegacy, h]

/-! ## Witnesses

The subtype and type lists `packages/core` holds, cut down to the members these vectors exercise;
the replay suites run the whole lists against the real TypeScript. -/

def someSystemSubtypes : List String := ["init", "status", "compact_boundary"]
def someResultSubtypes : List String := ["success", "error_max_turns", "error_max_budget_usd"]
def someEventTypes : List String := ["assistant", "user", "stream_event"]

private def initMessage : JValue :=
  .obj [("type", .str "system"), ("subtype", .str "init"), ("session_id", .str "sess_1")]

private def assistantMessage : JValue :=
  .obj [("type", .str "assistant"),
    ("message", .obj [("id", .str "msg_1"),
      ("content", .arr [
        .obj [("type", .str "text"), ("text", .str "Reading.")],
        .obj [("type", .str "tool_use"), ("id", .str "tool_1"), ("name", .str "Read")]])])]

/-- The three legacy rows a real pre-ENG-03 run left behind, upgraded, are the frames a fresh run
produces — computed on both sides rather than written out. -/
example :
    upgradeLegacy someSystemSubtypes someResultSubtypes someEventTypes
        (legacyEnvelope "system" initMessage) =
      toAgentFrames (classify someSystemSubtypes someResultSubtypes someEventTypes initMessage) ∧
    upgradeLegacy someSystemSubtypes someResultSubtypes someEventTypes
        (legacyEnvelope "sdk-event" assistantMessage) =
      toAgentFrames
        (classify someSystemSubtypes someResultSubtypes someEventTypes assistantMessage) ∧
    upgradeLegacy someSystemSubtypes someResultSubtypes someEventTypes
        (legacyEnvelope "malformed" (.str "nope")) =
      toAgentFrames (classify someSystemSubtypes someResultSubtypes someEventTypes (.str "nope")) :=
  by decide

/-- And the upgraded frames are what the model says they are, arm by arm, so the equality above is
not two functions agreeing on nothing. -/
example :
    upgradeLegacy someSystemSubtypes someResultSubtypes someEventTypes
        (legacyEnvelope "sdk-event" assistantMessage) =
      [.message (some "msg_1") .assistant [.text "Reading."],
       .toolCall "tool_1" "Read" .read .null] := by decide

end AgentWorkspace.Theorems.Refinement.AgentFrames
