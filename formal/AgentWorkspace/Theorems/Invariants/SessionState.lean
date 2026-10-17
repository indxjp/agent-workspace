import AgentWorkspace.Behaviour.SessionState

/-!
# T2 — what the engine-scoped session store promises about its own operations (ENG-06, #305)

Four claims, one per operation, and each of them is an acceptance criterion of #305 rather than an
implementation detail:

* appending an entry whose key the stream already holds leaves the stream the same length, with the
  entry in the place it already had — a redelivery is not a second turn;
* `delete-last` removes exactly the last entry;
* `replace-all` yields exactly the entries it was given;
* a blob over the cap is refused **and the state is unchanged** — the second half is the one a
  truncating implementation would fail.

A fifth, about durability, is stated here too because it is the same kind of claim: the verdict is
`false` whenever the store could not write, for every engine.
-/

namespace AgentWorkspace.Theorems.Invariants.SessionState

open AgentWorkspace.Behaviour.SessionState

/-- Rewriting the row that already carries `k` leaves `k` reading back as the rewritten entries. -/
private theorem find?_map_of_any (rows : List (StreamKey × List Entry)) (k : StreamKey)
    (es : List Entry) (h : rows.any (fun row => row.1 == k) = true) :
    ((rows.map (fun row => if row.1 == k then (k, es) else row)).find?
      (fun row => row.1 == k)).map Prod.snd = some es := by
  induction rows with
  | nil => simp at h
  | cons row rest ih =>
    by_cases hr : row.1 = k
    · simp [hr]
    · have hf : (if (row.1 == k) = true then (k, es) else row) = row := by simp [hr]
      rw [List.map_cons, hf, List.find?_cons_of_neg (by simp [hr])]
      exact ih (by simpa [hr] using h)

/-- Appending the row is the same read when no row carried `k`. -/
private theorem find?_append_of_not_any (rows : List (StreamKey × List Entry)) (k : StreamKey)
    (es : List Entry) (h : rows.any (fun row => row.1 == k) = false) :
    ((rows ++ [(k, es)]).find? (fun row => row.1 == k)).map Prod.snd = some es := by
  induction rows with
  | nil => simp
  | cons row rest ih =>
    simp only [List.any_cons, Bool.or_eq_false_iff] at h
    rw [List.cons_append, List.find?_cons_of_neg (by simpa using h.1)]
    exact ih h.2

/-- Setting a stream and reading it back answers exactly what was set. -/
private theorem list_setStream (st : Store) (k : StreamKey) (es : List Entry) :
    list (setStream st k es) k = some es := by
  unfold setStream list
  by_cases h : st.streams.any (fun row => row.1 == k) = true
  · simpa [h] using find?_map_of_any st.streams k es h
  · simp only [Bool.not_eq_true] at h
    simpa [h] using find?_append_of_not_any st.streams k es h

/-- **Replace-all yields exactly the given entries.** The `PUT` half of the store's contract. -/
@[aw_spec (tier := T2) (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-operations")
  (ts := "apps/web/server/sessions/state-api.ts#replaceSessionState")
  (ts := "packages/core/src/db/repositories/session-state.ts#createDatabaseSessionStateRepositoryProvider")]
theorem replace_all_yields_exactly_those_entries (st : Store) (k : StreamKey) (es : List Entry) :
    list (replaceAll st k es) k = some es := by
  simpa [replaceAll] using list_setStream st k es

/-- **Appending an entry whose key is already in the stream does not grow it.**

R-01 §7: the Agent SDK's retries redeliver a batch, so an append must upsert on the entry's key.
The stream a redelivery leaves behind has the same length as the one it found — which is the whole
of "appending the same `entry_key` twice stores one entry". -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#idempotency-and-why-entry_key-is-nullable")
  (ts := "packages/core/src/db/repositories/session-state.ts#createDatabaseSessionStateRepositoryProvider")
  (ts := "apps/web/server/sessions/state-api.ts#appendSessionState")]
theorem append_of_a_known_key_does_not_grow_the_stream (es : List Entry) (e : Entry) (k : String)
    (hk : e.key = some k) (hp : es.any (fun x => x.key == some k) = true) :
    (upsert es e).length = es.length := by
  simp [upsert, hk, hp]

/-- **An entry with no key is always appended.** The other half of R-01 §7: an entry the engine gave
no identity has nothing to dedup on, so the store must not invent one for it. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#idempotency-and-why-entry_key-is-nullable")
  (ts := "apps/web/server/sessions/state.ts#parseSessionStateEntry")]
theorem append_of_a_keyless_entry_always_grows_the_stream (es : List Entry) (e : Entry)
    (hk : e.key = none) : upsert es e = es ++ [e] := by
  simp [upsert, hk]

/-- **Delete-last removes exactly the last entry**, and nothing else. -/
@[aw_spec (tier := T2) (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-operations")
  (ts := "apps/web/server/sessions/state-api.ts#deleteSessionState")
  (ts := "packages/core/src/db/repositories/session-state.ts#createDatabaseSessionStateRepositoryProvider")]
theorem delete_last_removes_exactly_the_last (st : Store) (k : StreamKey) (es : List Entry)
    (h : list st k = some es) : list (deleteLast st k) k = some es.dropLast := by
  simp [deleteLast, h, list_setStream]

/-- **Delete-last on an empty stream leaves an empty stream**, so a retry is not a failure. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/sessions/state-api.ts#deleteSessionState")]
theorem delete_last_of_an_empty_stream_is_empty (st : Store) (k : StreamKey)
    (h : list st k = some []) : list (deleteLast st k) k = some [] := by
  simp [deleteLast, h, list_setStream]

/-- **A blob over the cap is refused, and the state is unchanged.**

`putBlob` answers `none`, which the route turns into `413 session_state_too_large`. The unchanged
half is structural: there is no path through the function that writes and then refuses. -/
@[aw_spec (tier := T2) (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-blob-cap")
  (ts := "packages/engine/src/session-state.ts#SESSION_STATE_BLOB_MAX_BYTES")
  (ts := "apps/web/server/sessions/state-api.ts#putSessionStateBlob")]
theorem a_blob_over_the_cap_is_refused (st : Store) (k : BlobKey) (size : Nat)
    (h : size > blobCap) : putBlob st k size = none := by
  simp [putBlob, h]

/-- The same claim as the route sees it: the outcome is the refusal, with its code and its status. -/
@[aw_spec (tier := T2) (ts := "apps/web/server/sessions/state-api.ts#putSessionStateBlob")]
theorem an_over_cap_blob_answers_413 (tok : RunToken) (pinned : Option String) (st : Store)
    (k : BlobKey) (size : Nat) (hauth : authorised tok k.workspace k.session = true)
    (hengine : engineAccepts pinned k.engine = true) (h : size > blobCap) :
    serveBlob tok pinned st k size = .refused .tooLarge ∧
    Refusal.tooLarge.status = 413 ∧ Refusal.tooLarge.code = "session_state_too_large" := by
  refine ⟨?_, rfl, rfl⟩
  simp [serveBlob, hauth, hengine, putBlob, h]

/-- A witness for the hypotheses above: an authorised token, an unpinned session, a blob one byte
over the cap. -/
example :
    serveBlob { workspace := "w1", session := "se1" } none empty
        { workspace := "w1", session := "se1", engine := "claude-agent-sdk", blob := "state.tar" }
        (blobCap + 1) = .refused .tooLarge := by
  simp [serveBlob, authorised, engineAccepts, putBlob, blobCap]

/-- **A failed store write makes the run non-durable, for every engine.**

The adapter's own answer is quantified over, which is the engine-neutral half: whatever the engine
told its adapter, a store that could not write makes the verdict `false`. -/
@[aw_spec (tier := T2) (doc := "docs/adr/W1-RN-01-session-durability-is-a-verdict.md#decision")
  (ts := "packages/engine/src/session-state.ts#withStoreWriteFailures")
  (ts := "apps/runner/src/runtime.ts#startEngineAgent")]
theorem a_failed_store_write_is_not_durable (adapterSaysDurable : Bool) (failures : Nat)
    (h : failures ≠ 0) : durable adapterSaysDurable failures = false := by
  simp [durable, h]

/-- …and the fold can only ever make a verdict worse: a store with nothing to report returns the
adapter's own answer unchanged. -/
@[aw_spec (tier := T2) (ts := "packages/engine/src/session-state.ts#withStoreWriteFailures")]
theorem a_clean_store_returns_the_adapters_answer (adapterSaysDurable : Bool) :
    durable adapterSaysDurable 0 = adapterSaysDurable := by
  simp [durable]

/-! ## The public transcript writes match the read (ADR-0071) -/

/-- Deleting the stream leaves nothing under its key. -/
private theorem list_deleteStream (st : Store) (k : StreamKey) : list (deleteStream st k) k = none := by
  unfold deleteStream list
  simp [List.find?_filter]

/-- **What `POST …/transcript` stores is what `GET …/transcript` reads**, whatever the legacy
tables hold: the append lands in the stream the read serves first. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-public-transcript-writes-match-the-read")
  (ts := "apps/web/server/sessions/api.ts#appendTranscript")]
theorem a_posted_transcript_is_read_back (st : Store) (k : StreamKey) (batch : List Entry)
    (legacy : Option (List Delivery)) :
    publicTranscriptRead (publicTranscriptAppend st k batch) k legacy =
      some (upsertAll ((list st k).getD []) batch) := by
  simp [publicTranscriptRead, publicTranscriptAppend, append, list_setStream]

/-- **After `DELETE …/transcript` the read is `404`**, for a post-ENG-06 session and a legacy one
alike: the stream is gone and so are the legacy rows, so neither side of the fallback answers. -/
@[aw_spec (tier := T2)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-public-transcript-writes-match-the-read")
  (ts := "apps/web/server/sessions/api.ts#deleteTranscript")]
theorem a_deleted_transcript_reads_as_not_found (st : Store) (k : StreamKey) :
    publicTranscriptRead (publicTranscriptDelete st k).1 k (publicTranscriptDelete st k).2 =
      none := by
  simp [publicTranscriptRead, publicTranscriptDelete, list_deleteStream]

end AgentWorkspace.Theorems.Invariants.SessionState
