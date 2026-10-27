import AgentWorkspace.Behaviour.SessionState

/-!
# T4 — the migration preserves every Claude entry, its order and its key (ENG-06, #305)

Migration 0027 moves `session_transcripts`/`session_messages` into the engine-scoped store. The
acceptance criterion is that *"a Claude session created before the migration resumes after it with
its full history"*, and "resumes with its full history" is a statement about three things at once:
every entry survives, they arrive in the order `load()` produced, and each keeps the idempotency key
a later redelivery is matched against.

`Behaviour.SessionState` models both sides — `legacyLoad` is the read fold
`session-transcripts.ts` performs over the append-only delivery log, and `migrated` is the
`DISTINCT ON … ORDER BY sequence DESC` plus `dense_rank()` the migration's `SELECT` performs. The
theorems below relate them.

## The hypothesis this refinement carries, and why it is one

`legacyLoad` walks positions in **first-delivery** order; `migrated` walks them in **numeric**
order, because `dense_rank()` sorts. The two agree because `session-transcripts.ts` allocates a new
entry's `position` as `max(sequence) + 1` and a redelivery keeps the position it already had, so the
positions of a delivery log appear in non-decreasing order. Lean cannot prove a property of rows
PostgreSQL wrote, so that becomes an explicit hypothesis — `positionsAllocatedInOrder` — and it is
enforced where it can be:
`packages/core/src/db/repositories/session-state-migration.test.ts` seeds the old tables through the
old repository, migrates, and compares the resumed history entry for entry.
-/

namespace AgentWorkspace.Theorems.Refinement.SessionStateMigration

open AgentWorkspace.Behaviour.SessionState

/-- Adjacent order is order: `nonDecreasing` compares neighbours, `Pairwise` compares every pair,
and `≤` being transitive is what makes the two the same statement. -/
private theorem pairwise_of_nonDecreasing :
    ∀ (l : List Nat), nonDecreasing l = true → l.Pairwise (fun a b => a ≤ b)
  | [], _ => List.Pairwise.nil
  | [_], _ => by simp
  | a :: b :: rest, h => by
    have hab : a ≤ b := Nat.le_of_ble_eq_true ((Bool.and_eq_true _ _).mp h).1
    have hrest := pairwise_of_nonDecreasing (b :: rest) ((Bool.and_eq_true _ _).mp h).2
    refine List.pairwise_cons.mpr ⟨?_, hrest⟩
    intro c hc
    rcases List.mem_cons.mp hc with rfl | hc'
    · exact hab
    · exact Nat.le_trans hab ((List.pairwise_cons.mp hrest).1 c hc')

/-- Sorting a list that is already non-decreasing changes nothing. -/
private theorem mergeSort_of_nonDecreasing (l : List Nat) (h : nonDecreasing l = true) :
    l.mergeSort (· ≤ ·) = l :=
  List.mergeSort_of_pairwise (by simpa using pairwise_of_nonDecreasing l h)

/-- **The migration preserves every entry, its order and its key.**

Stated as an equality of the two folds, which is exactly the three claims at once: the same list
means the same entries (payloads), in the same positions, carrying the same `Entry.key`. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-migrations-need-a-single-revision-cutover")
  (ts := "packages/core/src/db/repositories/session-transcripts.ts#createDatabaseSessionTranscriptRepositoryProvider")
  (ts := "packages/core/src/db/repositories/session-state.ts#createDatabaseSessionStateRepositoryProvider")]
theorem migration_preserves_the_history (ds : List Delivery)
    (h : positionsAllocatedInOrder ds = true) : migrated ds = legacyLoad ds := by
  unfold migrated legacyLoad
  rw [mergeSort_of_nonDecreasing (positions ds) h]

/-- A witness for the hypothesis, and the case the fold is most easily got wrong on: a redelivery
of the first entry, and an entry with no `uuid` at all.

Read it as the row set `session-state-migration.test.ts` seeds: `u-1` delivered at sequence 1 and
redelivered at sequence 4 keeping position 1, `u-2` at position 2, and a keyless summary at
position 3. What survives is the redelivery, in the first entry's place, and the summary keeps a
`none` key — no key is invented for an entry that has none. -/
example :
    legacyLoad
        [{ position := 1, sequence := 1, uuid := some "u-1", payload := "first" },
         { position := 2, sequence := 2, uuid := some "u-2", payload := "second" },
         { position := 3, sequence := 3, uuid := none, payload := "summary" },
         { position := 1, sequence := 4, uuid := some "u-1", payload := "redelivered" }] =
      [{ key := some "u-1", payload := "redelivered" },
       { key := some "u-2", payload := "second" },
       { key := none, payload := "summary" }] := by
  decide +kernel

/-- The same log, through the migration's own `SELECT`. The two agree, which is the theorem above
exercised on the case it exists for rather than only stated. -/
example :
    migrated
        [{ position := 1, sequence := 1, uuid := some "u-1", payload := "first" },
         { position := 2, sequence := 2, uuid := some "u-2", payload := "second" },
         { position := 3, sequence := 3, uuid := none, payload := "summary" },
         { position := 1, sequence := 4, uuid := some "u-1", payload := "redelivered" }] =
      [{ key := some "u-1", payload := "redelivered" },
       { key := some "u-2", payload := "second" },
       { key := none, payload := "summary" }] := by
  -- `mergeSort` is defined by well-founded recursion, so it does not reduce under `decide`; the
  -- sort is discharged by the lemma above and the fold itself is then evaluated.
  unfold migrated
  rw [mergeSort_of_nonDecreasing _ (by decide +kernel)]
  decide +kernel

/-- **A migrated stream is resumable**: reading the stream the migration wrote answers exactly the
history the old `load()` answered, rather than `none`.

`none` and `some []` and `some history` are three different answers here and only the third is a
resume, so the refinement has to say which one a migrated session gets. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-migrations-need-a-single-revision-cutover")
  (ts := "apps/web/server/sessions/state-api.ts#listSessionStateEntries")]
theorem a_migrated_session_reads_back_its_history (ds : List Delivery) (k : StreamKey)
    (h : positionsAllocatedInOrder ds = true) :
    list (replaceAll empty k (migrated ds)) k = some (legacyLoad ds) := by
  rw [migration_preserves_the_history ds h]
  simp [replaceAll, setStream, list, empty]

/-- **The stream a Claude transcript lands in is named by its own key.**

The other half of "the same history": a migration that preserved every entry and put it under a key
nothing looks up would satisfy the theorem above and lose the conversation. The Claude adapter reads
`projectKey + '/' + subpath`, and the main transcript's subpath is the empty string. -/
@[aw_spec (tier := T4) (ts := "packages/engine/src/session-state.ts#engineStreamKey")
  (ts := "apps/runner/src/session-state.ts#createHttpEngineSessionStore")]
theorem the_main_transcript_lands_under_the_project_key (projectKey : String) :
    claudeStreamKey projectKey "" = projectKey ++ "/" := by
  simp [claudeStreamKey]

/-- A subagent transcript lands under its own key, distinct from the main one. -/
example : claudeStreamKey "w1" "subagents/agent-1" ≠ claudeStreamKey "w1" "" := by decide +kernel

/-! ## The public transcript read (Owner decision on #305, ADR-0071) -/

/-- **A stream the store has is served from the store**, whatever the legacy tables hold.

This is the half of the read that keeps `sessions.transcript.read()` answering for a session created
after ENG-06, which no writer puts into the legacy tables any more. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-public-transcript-read-is-served-from-this-store")
  (ts := "apps/web/server/sessions/api.ts#loadTranscript")]
theorem the_public_read_serves_the_store_when_it_has_the_stream (st : Store) (k : StreamKey)
    (legacy : Option (List Delivery)) (es : List Entry) (h : list st k = some es) :
    publicTranscriptRead st k legacy = some es := by
  simp [publicTranscriptRead, h]

/-- **A session the store has no stream for is served from the legacy tables**, folded the way the
old `load()` folded them — a pre-ENG-06 session keeps its history whether or not 0027 reached it. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-public-transcript-read-is-served-from-this-store")
  (ts := "apps/web/server/sessions/api.ts#loadTranscript")]
theorem a_pre_eng06_session_falls_back_to_its_legacy_history (st : Store) (k : StreamKey)
    (ds : List Delivery) (h : list st k = none) :
    publicTranscriptRead st k (some ds) = some (legacyLoad ds) := by
  simp [publicTranscriptRead, h]

/-- **The migration does not change what the public read answers.** Before 0027 the store is empty
and the read falls back to the legacy fold; after it, the store holds the migrated stream and the
read serves it — and the two answers are the same list. -/
@[aw_spec (tier := T4)
  (doc := "docs/adr/0071-one-engine-scoped-session-state-store.md#the-public-transcript-read-is-served-from-this-store")
  (ts := "apps/web/server/sessions/api.ts#loadTranscript")]
theorem the_public_read_is_unchanged_by_the_migration (ds : List Delivery) (k : StreamKey)
    (h : positionsAllocatedInOrder ds = true) :
    publicTranscriptRead (replaceAll empty k (migrated ds)) k (some ds) =
      publicTranscriptRead empty k (some ds) := by
  rw [the_public_read_serves_the_store_when_it_has_the_stream _ _ _ _
    (a_migrated_session_reads_back_its_history ds k h)]
  simp [publicTranscriptRead, list, empty]

end AgentWorkspace.Theorems.Refinement.SessionStateMigration
