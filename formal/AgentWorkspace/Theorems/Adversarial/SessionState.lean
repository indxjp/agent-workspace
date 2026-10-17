import AgentWorkspace.Behaviour.SessionState

/-!
# T3 — what a run token cannot reach, and what an engine cannot claim (ENG-06, #305)

Two adversaries, and the store refuses both structurally rather than by discipline.

1. **A run token for session A.** It can neither read nor change any stream or blob of session B,
   or of another workspace, and the refusal is `404` in both cases — concealment, because these are
   private routes reached with a credential scoped to one session and "that session exists and is
   not yours" is a fact it has no business learning.
2. **A stream that names the wrong engine.** Session state is engine-scoped; one engine's state
   replayed into another is not a resume. A declaration that disagrees with `sessions.engine` is
   `409 session_engine_mismatch`.

The ordering matters and is asserted: authorisation is decided **before** the engine is looked at,
so the engine refusal cannot be used as an oracle for a session the caller may not see.
-/

namespace AgentWorkspace.Theorems.Adversarial.SessionState

open AgentWorkspace.Behaviour.SessionState

/-- **A token for another session cannot write.** Quantified over the store and the batch: what the
stream holds, and what the caller wanted to put in it, cannot change the answer. -/
@[aw_spec (tier := T3)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#concealment-404-not-403")
  (ts := "apps/web/server/sessions/state-api.ts#resolveSession")
  (ts := "apps/web/server/composition/session-rbac.ts#installSessionTranscripts")]
theorem another_sessions_stream_cannot_be_written (tok : RunToken) (pinned : Option String)
    (st : Store) (k : StreamKey) (batch : List Entry)
    (h : (tok.session == k.session) = false) :
    serveWrite tok pinned st k batch = .refused .notFound := by
  simp [serveWrite, authorised, h]

/-- **…nor read**, with the same answer, so the two cannot be told apart. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/sessions/state-api.ts#resolveSession")]
theorem another_sessions_stream_cannot_be_read (tok : RunToken) (pinned : Option String)
    (st : Store) (k : StreamKey) (h : (tok.session == k.session) = false) :
    serveRead tok pinned st k = .refused .notFound := by
  simp [serveRead, authorised, h]

/-- **…nor its blobs.** Quantified over the size, so the cap cannot leak the session's existence
either: an over-cap blob for a session the caller cannot reach is still a `404`. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/sessions/state-api.ts#blobContext")]
theorem another_sessions_blob_cannot_be_written (tok : RunToken) (pinned : Option String)
    (st : Store) (k : BlobKey) (size : Nat) (h : (tok.session == k.session) = false) :
    serveBlob tok pinned st k size = .refused .notFound := by
  simp [serveBlob, authorised, h]

/-- **Another workspace's stream is refused the same way**, even when the session id matches. Two
tenants can hold the same session id only by coincidence, and a check on one half is not a check. -/
@[aw_spec (tier := T3) (doc := "docs/architecture.md#runtime-and-trust-boundaries")
  (ts := "apps/web/server/sessions/state-store.ts#DatabaseSessionStateStore")]
theorem another_workspaces_stream_is_refused (tok : RunToken) (pinned : Option String) (st : Store)
    (k : StreamKey) (batch : List Entry) (h : (tok.workspace == k.workspace) = false) :
    serveWrite tok pinned st k batch = .refused .notFound := by
  simp [serveWrite, authorised, h]

/-- The refusal a caller sees is a `404` carrying `session_state_not_found`, never a `403`. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/sessions/state-api.ts#notFound")]
theorem the_concealing_refusal_is_a_404 :
    Refusal.notFound.status = 404 ∧ Refusal.notFound.code = "session_state_not_found" :=
  ⟨rfl, rfl⟩

/-- A witness for the hypotheses above: one token, one stream of a different session. -/
example :
    serveRead { workspace := "w1", session := "se1" } (some "claude-agent-sdk") empty
        { workspace := "w1", session := "se2", engine := "claude-agent-sdk", stream := "w1/" } =
      .refused .notFound := by
  simp [serveRead, authorised]

/-- **A stream whose engine differs from the session's is refused**, with its own code. -/
@[aw_spec (tier := T3) (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-engine-check")
  (ts := "apps/web/server/sessions/state-api.ts#engineMismatch")]
theorem a_stream_of_another_engine_is_refused (tok : RunToken) (st : Store) (k : StreamKey)
    (batch : List Entry) (pinnedEngine : String)
    (hauth : authorised tok k.workspace k.session = true)
    (h : (pinnedEngine == k.engine) = false) :
    serveWrite tok (some pinnedEngine) st k batch = .refused .engineMismatch := by
  simp [serveWrite, hauth, engineAccepts, h]

/-- The engine refusal is a `409` carrying `session_engine_mismatch`. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/sessions/state-api.ts#engineMismatch")]
theorem the_engine_refusal_is_a_409 :
    Refusal.engineMismatch.status = 409 ∧ Refusal.engineMismatch.code = "session_engine_mismatch" :=
  ⟨rfl, rfl⟩

/-- **A session no run has pinned yet accepts any engine.**

Not a hole: `sessions.engine` is NULL until a run reports the session's identity, so refusing a NULL
would refuse the first write of every new session — which is the write that exists to make the
session resumable in the first place. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/sessions/state-api.ts#engineMismatch")
  (ts := "packages/core/src/db/schema/sessions.ts#sessions")]
theorem an_unpinned_session_accepts_any_engine (tok : RunToken) (st : Store) (k : StreamKey)
    (batch : List Entry) (hauth : authorised tok k.workspace k.session = true) :
    serveWrite tok none st k batch = .stored (append st k batch) := by
  simp [serveWrite, hauth, engineAccepts]

/-- **Authorisation is decided before the engine.**

The claim this makes precise: a caller that may not reach the session gets `notFound` whatever the
session is pinned to, so the `409` cannot be used to learn which engine a hidden session runs. -/
@[aw_spec (tier := T3) (ts := "apps/web/server/sessions/state-api.ts#streamContext")]
theorem the_engine_refusal_never_leaks_a_hidden_session (tok : RunToken) (st : Store)
    (k : StreamKey) (batch : List Entry) (pinnedEngine : String)
    (h : (tok.session == k.session) = false) :
    serveWrite tok (some pinnedEngine) st k batch = .refused .notFound := by
  simp [serveWrite, authorised, h]

/-- A witness for the engine refusal: an authorised token, a session pinned elsewhere. -/
example :
    serveWrite { workspace := "w1", session := "se1" } (some "another-engine") empty
        { workspace := "w1", session := "se1", engine := "claude-agent-sdk", stream := "w1/" } [] =
      .refused .engineMismatch := by
  simp [serveWrite, authorised, engineAccepts]

/-! ## The Claude project-key guard (R-01 §7, ADR-0071) -/

/-- **A Claude write outside the caller's project key is refused `403 project_key_mismatch`**, and
nothing is stored: a runtime whose SDK silently fell back to a `cwd`-derived key is told so rather
than writing a stream the public read cannot find. -/
@[aw_spec (tier := T3)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#a-claude-stream-key-is-checked-against-the-project-key")
  (ts := "apps/web/server/sessions/state-api.ts#projectKeyMismatch")]
theorem a_claude_write_outside_its_project_key_is_refused (tok : RunToken) (pinned : Option String)
    (st : Store) (k : StreamKey) (batch : List Entry)
    (hauth : authorised tok k.workspace k.session = true)
    (hengine : engineAccepts pinned k.engine = true) (hclaude : k.engine = claudeEngine)
    (hkey : k.stream.startsWith (k.workspace ++ "/") = false) :
    serveGuardedWrite tok pinned st k batch = .refused .projectKeyMismatch := by
  unfold serveGuardedWrite serveWrite
  simp only [hauth, hengine, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
  simp [projectKeyAccepts, hclaude, hkey]

/-- The project-key refusal travels as `403 project_key_mismatch`, the code the legacy
`POST …/transcript` has always used for the same disagreement. -/
@[aw_spec (tier := T3)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#a-claude-stream-key-is-checked-against-the-project-key")
  (ts := "apps/web/server/sessions/state-api.ts#projectKeyMismatch")]
theorem the_project_key_refusal_is_a_403 :
    Refusal.projectKeyMismatch.status = 403 ∧
      Refusal.projectKeyMismatch.code = "project_key_mismatch" := by
  simp [Refusal.status, Refusal.code]

/-- **The guard never answers for a hidden session**: a caller that may not reach the session gets
`notFound` whatever key it sent, so the `403` cannot be used to probe another session. -/
@[aw_spec (tier := T3)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#a-claude-stream-key-is-checked-against-the-project-key")
  (ts := "apps/web/server/sessions/state-api.ts#writeContext")]
theorem the_project_key_refusal_never_leaks_a_hidden_session (tok : RunToken)
    (pinned : Option String) (st : Store) (k : StreamKey) (batch : List Entry)
    (h : (tok.session == k.session) = false) :
    serveGuardedWrite tok pinned st k batch = .refused .notFound := by
  simp [serveGuardedWrite, serveWrite, authorised, h]

/-- **Every other engine's stream key stays opaque**: the guarded write is exactly the unguarded
one. -/
@[aw_spec (tier := T3)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#a-claude-stream-key-is-checked-against-the-project-key")
  (ts := "apps/web/server/sessions/state-api.ts#projectKeyMismatch")]
theorem another_engines_stream_key_is_opaque (tok : RunToken) (pinned : Option String)
    (st : Store) (k : StreamKey) (batch : List Entry) (h : (k.engine != claudeEngine) = true) :
    serveGuardedWrite tok pinned st k batch = serveWrite tok pinned st k batch := by
  unfold serveGuardedWrite
  cases serveWrite tok pinned st k batch <;> simp [projectKeyAccepts, h]

end AgentWorkspace.Theorems.Adversarial.SessionState
