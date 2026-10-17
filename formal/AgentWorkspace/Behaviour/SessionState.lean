import AgentWorkspace.Contracts.Sessions

/-!
# The engine-scoped session store (ENG-06, #305)

Every engine makes a session resumable through **one** platform-owned store. This module is that
store as a pure function over an explicit state: streams of opaque entries keyed by
`(workspace, session, engine, streamKey)`, plus size-capped blobs for an engine whose state is a
file snapshot rather than a list.

Three things the model deliberately does **not** know, because the platform does not either:

* what an entry *is*. `Entry.payload` is one opaque string; the only field the platform reads is
  `Entry.key`, the idempotency key, and it reads it to decide whether a delivery is a redelivery.
* what a `streamKey` means. It is adapter-defined; the Claude adapter renders `projectKey + '/' +
  subpath` into it, and `Behaviour.SessionState.claudeStreamKey` is that rendering so the migration
  theorem can talk about it.
* how bytes are stored. A blob is its key and its size, because the only decision the platform makes
  about one is whether it is under the cap.

## Current and Target

`docs/formal/README.md` asks that where today's code and the target differ both are modelled and
related. They differ in one place — **where a Claude transcript lives** — and section 5 models both:
`legacyLoad` is what `session_messages` answered before this unit (an append-only delivery log
folded on read) and `migrated` is what migration 0027 writes into `session_state_entries`. The T4
theorem of this unit relates them.
-/

namespace AgentWorkspace.Behaviour.SessionState

open AgentWorkspace

/-! ## 1. The key -/

/-- Which stream. The tenant, the **platform's** session id, the engine, and one opaque key.

`session` is `sessions.id` and never the engine's own id: `session_transcripts` keyed by the
engine's, and that only ever worked because the Claude Agent SDK is handed `sessions.id` as its
`Options.sessionId`. No other engine promises the two are equal. -/
structure StreamKey where
  workspace : String
  session : String
  engine : String
  stream : String
  deriving DecidableEq, Repr, Inhabited

/-- Which blob. The same tenant, session and engine, with the adapter's own blob key. -/
structure BlobKey where
  workspace : String
  session : String
  engine : String
  blob : String
  deriving DecidableEq, Repr, Inhabited

/-- One stored entry. `key` is the idempotency key, absent for an entry the engine gave no identity
(the Agent SDK's titles, tags and mode markers — R-01 §7). `payload` is opaque. -/
structure Entry where
  key : Option String
  payload : String
  deriving DecidableEq, Repr, Inhabited

/-- The Claude adapter's stream key: `projectKey`, `/`, `subpath`.

The main transcript's `subpath` is the empty string, so its key ends in a bare `/`. The join is
injective over the keys the platform can produce because a `projectKey` matches
`/^[A-Za-z0-9_-]{1,64}$/` and therefore cannot contain a `/`. -/
def claudeStreamKey (projectKey subpath : String) : String := projectKey ++ "/" ++ subpath

/-! ## 2. The store -/

/-- The store: streams as an association list, and blobs as another.

An association list rather than a function, because the operations below have to be able to say
"this stream does not exist" — and `none` and `some []` are different answers whose difference
decides whether a session resumes. -/
structure Store where
  streams : List (StreamKey × List Entry)
  blobs : List (BlobKey × Nat)
  deriving DecidableEq, Repr, Inhabited

/-- The empty store. -/
def empty : Store := { streams := [], blobs := [] }

/-- The entries of one stream, or `none` when the stream was never written. -/
def list (st : Store) (k : StreamKey) : Option (List Entry) :=
  (st.streams.find? (fun row => row.1 == k)).map Prod.snd

/-- The store with stream `k`'s entries set to `es`, creating the stream if it is absent. -/
def setStream (st : Store) (k : StreamKey) (es : List Entry) : Store :=
  if st.streams.any (fun row => row.1 == k) then
    { st with streams := st.streams.map (fun row => if row.1 == k then (k, es) else row) }
  else
    { st with streams := st.streams ++ [(k, es)] }

/-- Replace every entry carrying key `k` with `e`. Idempotent as a function on one entry. -/
def replaceKeyed (k : String) (e : Entry) (x : Entry) : Entry :=
  if x.key == some k then e else x

/-- Persist one entry into a stream's contents.

Two arms, and the split is R-01 §7's: an entry **with** a key upserts **in place** — a transcript
is a chain and a redelivery must not reorder it — and an entry **without** one is appended, because
it carries no identity to dedup on. -/
def upsert (es : List Entry) (e : Entry) : List Entry :=
  match e.key with
  | none => es ++ [e]
  | some k => if es.any (fun x => x.key == some k) then es.map (replaceKeyed k e) else es ++ [e]

/-- Persist a batch, in order. -/
def upsertAll (es : List Entry) (batch : List Entry) : List Entry := batch.foldl upsert es

/-- `append`: persist a batch into a stream, creating the stream even for an empty batch.

The empty batch matters: it is what makes "this stream exists and is empty" a different state from
"this stream was never written", and only the first of those resumes. -/
def append (st : Store) (k : StreamKey) (batch : List Entry) : Store :=
  setStream st k (upsertAll ((list st k).getD []) batch)

/-- `replace-all`: the stream holds exactly these entries afterwards. -/
def replaceAll (st : Store) (k : StreamKey) (es : List Entry) : Store := setStream st k es

/-- `delete-last`: remove the highest-sequence entry, which is the last of the list. -/
def deleteLast (st : Store) (k : StreamKey) : Store :=
  match list st k with
  | none => st
  | some es => setStream st k es.dropLast

/-- `delete`: remove the whole stream. -/
def deleteStream (st : Store) (k : StreamKey) : Store :=
  { st with streams := st.streams.filter (fun row => row.1 != k) }

/-! ## 3. Blobs and the cap -/

/-- The largest blob the store accepts, in bytes: 32 MiB.

`packages/engine/src/session-state.ts`'s `SESSION_STATE_BLOB_MAX_BYTES`. A refusal, never a
truncation: a snapshot cut off at the cap replays into an agent as a state directory its own code
never wrote. -/
def blobCap : Nat := 33554432

/-- Store one blob, or refuse it. `none` is `413 session_state_too_large`. -/
def putBlob (st : Store) (k : BlobKey) (size : Nat) : Option Store :=
  if size > blobCap then none
  else if st.blobs.any (fun row => row.1 == k) then
    some { st with blobs := st.blobs.map (fun row => if row.1 == k then (k, size) else row) }
  else some { st with blobs := st.blobs ++ [(k, size)] }

/-- The size recorded for one blob, or `none`. -/
def getBlob (st : Store) (k : BlobKey) : Option Nat :=
  (st.blobs.find? (fun row => row.1 == k)).map Prod.snd

/-! ## 4. Who may touch a stream, and on which engine -/

/-- A run token, as the control plane resolves it: one workspace and one session, and no more. -/
structure RunToken where
  workspace : String
  session : String
  deriving DecidableEq, Repr, Inhabited

/-- The token reaches this stream. Both halves, and neither substitutes for the other. -/
def authorised (tok : RunToken) (workspace session : String) : Bool :=
  tok.workspace == workspace && tok.session == session

/-- Why a request was refused. Every arm is a stable code on the wire. -/
inductive Refusal where
  /-- The caller may not reach this session. Concealment: the same answer for "not yours". -/
  | notFound
  /-- The stream's engine is not the engine the session is pinned to. -/
  | engineMismatch
  /-- The blob is over {@link blobCap}. -/
  | tooLarge
  /-- A `claude-agent-sdk` stream key is not under the caller's own project key (R-01 §7). -/
  | projectKeyMismatch
  deriving DecidableEq, Repr, Inhabited

/-- The wire code each refusal travels under. -/
def Refusal.code : Refusal → String
  | .notFound => "session_state_not_found"
  | .engineMismatch => "session_engine_mismatch"
  | .tooLarge => "session_state_too_large"
  | .projectKeyMismatch => "project_key_mismatch"

/-- The HTTP status each refusal travels under. -/
def Refusal.status : Refusal → Nat
  | .notFound => 404
  | .engineMismatch => 409
  | .tooLarge => 413
  | .projectKeyMismatch => 403

/-- The engine the session is pinned to accepts this declaration.

`none` is a session no run has pinned yet, and it is **accepted**: refusing it would refuse the
first write of every new session, which is the write that exists to make the session resumable.
What is refused is a disagreement. -/
def engineAccepts (pinned : Option String) (declared : String) : Bool :=
  match pinned with
  | none => true
  | some e => e == declared

/-- What one request answers: the new store, or a refusal. -/
inductive Outcome where
  | stored (store : Store)
  | read (entries : Option (List Entry))
  | refused (reason : Refusal)
  deriving DecidableEq, Repr, Inhabited

/-- Serve one write: authorise, check the engine, then act.

The order is the invariant, not an optimisation. A caller that may not reach the session is refused
before the engine is looked at, so the refusal cannot be used to learn which engine a session it may
not see is running on. -/
def serveWrite (tok : RunToken) (pinned : Option String) (st : Store) (k : StreamKey)
    (batch : List Entry) : Outcome :=
  if !authorised tok k.workspace k.session then .refused .notFound
  else if !engineAccepts pinned k.engine then .refused .engineMismatch
  else .stored (append st k batch)

/-- Serve one read, with the same order and the same concealment. -/
def serveRead (tok : RunToken) (pinned : Option String) (st : Store) (k : StreamKey) : Outcome :=
  if !authorised tok k.workspace k.session then .refused .notFound
  else if !engineAccepts pinned k.engine then .refused .engineMismatch
  else .read (list st k)

/-- Serve one blob write. The cap is the last check, because it is the only one that needs bytes. -/
def serveBlob (tok : RunToken) (pinned : Option String) (st : Store) (k : BlobKey) (size : Nat) :
    Outcome :=
  if !authorised tok k.workspace k.session then .refused .notFound
  else if !engineAccepts pinned k.engine then .refused .engineMismatch
  else match putBlob st k size with
    | none => .refused .tooLarge
    | some next => .stored next

/-! ## 5. Durability, for any engine -/

/-- The run's durability verdict.

Two observers and both must be satisfied: the adapter says what its own engine told it, the store
says what it could not write. Before ENG-06 only the first existed, so the verdict could only be
honest for the one engine that emits a `system/mirror_error`. -/
def durable (adapterSaysDurable : Bool) (storeWriteFailures : Nat) : Bool :=
  adapterSaysDurable && storeWriteFailures == 0

/-! ## 6. The migration: today's Claude transcript, and where it lands -/

/-- One row of `session_messages`, the append-only delivery log ENG-06 replaces.

`position` is the first delivery's sequence and is retained by every redelivery; `sequence` grows
with each delivery. A read folded the **latest** delivery of each position into that position. -/
structure Delivery where
  position : Nat
  sequence : Nat
  uuid : Option String
  payload : String
  deriving DecidableEq, Repr, Inhabited

/-- The latest delivery of `p`, by sequence. -/
def latestAt (ds : List Delivery) (p : Nat) : Option Delivery :=
  ds.foldl
    (fun best d =>
      if d.position == p then
        match best with
        | none => some d
        | some b => if b.sequence ≤ d.sequence then some d else some b
      else best)
    none

/-- The positions of a delivery log, each once, in first-delivery order. -/
def positions (ds : List Delivery) : List Nat :=
  ds.foldl (fun acc d => if acc.contains d.position then acc else acc ++ [d.position]) []

/-- One delivery as the new store holds it. -/
def toEntry (d : Delivery) : Entry := { key := d.uuid, payload := d.payload }

/-- **Current**: what `load()` answered before this unit — the latest delivery of each position, in
position order. `packages/core/src/db/repositories/session-transcripts.ts`'s `load`. -/
def legacyLoad (ds : List Delivery) : List Entry :=
  (positions ds).filterMap (fun p => (latestAt ds p).map toEntry)

/-- **Target**: what migration 0027 inserts into `session_state_entries` — `DISTINCT ON (position)`
ordered by `sequence DESC`, renumbered densely by `dense_rank() OVER (ORDER BY position)`.

The renumbering is what `sequence` becomes and is not part of the entry, so this function answers
the same list `legacyLoad` does when the migration is correct. The T4 theorem says so; it is not
true by construction, because `positions` is *first-delivery* order and `dense_rank` is *position*
order, and the two agree only because a position is allocated as a fresh maximum. -/
def migrated (ds : List Delivery) : List Entry :=
  ((positions ds).mergeSort (· ≤ ·)).filterMap (fun p => (latestAt ds p).map toEntry)

/-- Non-decreasing, as a decidable Bool rather than a `Prop`. -/
def nonDecreasing : List Nat → Bool
  | [] => true
  | [_] => true
  | a :: b :: rest => Nat.ble a b && nonDecreasing (b :: rest)

/-- A delivery log whose positions were allocated as fresh maxima, which is what
`session-transcripts.ts` does: a new entry takes `max(sequence) + 1`, and a redelivery keeps the
position it already had. The hypothesis the T4 theorem needs, stated rather than assumed — Lean
cannot prove a property of rows PostgreSQL wrote, so the property becomes a hypothesis and
`packages/core/src/db/repositories/session-state-migration.test.ts` is what enforces it. -/
def positionsAllocatedInOrder (ds : List Delivery) : Bool := nonDecreasing (positions ds)

/-! ## 7. The public transcript read, over both stores -/

/-- The public `GET /api/sessions/:id/transcript` of a Claude session since ENG-06 —
`apps/web/server/sessions/api.ts`'s `loadTranscript`, ADR-0071.

The engine-scoped stream when the store has one, whatever it holds (`some []` included); otherwise
the legacy fold of whatever the legacy tables hold for the key. `legacy` is `none` when they hold no
transcript, and the answer `none` is `404 transcript_not_found`. The fallback is per stream and never
a merge: a stream the store has is answered from the store alone. -/
def publicTranscriptRead (st : Store) (k : StreamKey) (legacy : Option (List Delivery)) :
    Option (List Entry) :=
  match list st k with
  | some es => some es
  | none => legacy.map legacyLoad

/-! ## 8. The public transcript writes, over both stores -/

/-- The public `POST /api/sessions/:id/transcript` since ENG-06 — `api.ts`'s `appendTranscript`,
ADR-0071. It appends to the engine-scoped stream the read serves, never to the legacy tables. -/
def publicTranscriptAppend (st : Store) (k : StreamKey) (batch : List Entry) : Store :=
  append st k batch

/-- The public `DELETE /api/sessions/:id/transcript` since ENG-06 — `api.ts`'s `deleteTranscript`.
It removes the stream **and** the legacy rows, so the answer is the new store and an empty legacy
side (`none`). -/
def publicTranscriptDelete (st : Store) (k : StreamKey) : Store × Option (List Delivery) :=
  (deleteStream st k, none)

/-! ## 9. The Claude project-key guard on state writes (R-01 §7) -/

/-- The one engine whose stream keys have a shape the platform knows. -/
def claudeEngine : String := "claude-agent-sdk"

/-- A stream key the guard accepts: any key of another engine (opaque), and a Claude key only
under the workspace's own project key and `/` — `state-api.ts`'s `projectKeyMismatch`. The
platform's `projectKey` is the workspace id. -/
def projectKeyAccepts (k : StreamKey) : Bool :=
  k.engine != claudeEngine || k.stream.startsWith (k.workspace ++ "/")

/-- Serve one state write with the guard: `serveWrite`'s authorise-then-engine order first, so the
guard never answers for a session the caller may not reach, and then the key. -/
def serveGuardedWrite (tok : RunToken) (pinned : Option String) (st : Store) (k : StreamKey)
    (batch : List Entry) : Outcome :=
  match serveWrite tok pinned st k batch with
  | .stored next => if projectKeyAccepts k then .stored next else .refused .projectKeyMismatch
  | other => other

end AgentWorkspace.Behaviour.SessionState
