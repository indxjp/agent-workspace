import AgentWorkspace.Theorems.Adversarial.SessionState
import AgentWorkspace.Theorems.Invariants.SessionState
import AgentWorkspace.Theorems.Refinement.SessionStateMigration
import Vectors.Common

/-!
The `session-state` family (ENG-06, #305), replayed by two suites:

* `apps/web/formal/session-state.test.ts` against the routes and the store — the operations, the
  engine check, the concealment and the blob cap;
* `apps/runner/formal/session-store-client.test.ts` against the runner's client — the stream-key
  rendering and the durability fold.

The inputs are the sequences a store is actually driven with, not the tidy ones: a redelivery, a
keyless entry, a pop of an empty stream, a blob one byte over the cap. A vector file of
well-behaved operations would prove nothing about the cases these operations exist for.
-/

namespace Vectors.SessionState

open Lean AgentWorkspace.Behaviour.SessionState

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".SessionState." ++ name

private def refinement (name : String) : String :=
  "AgentWorkspace.Theorems.Refinement.SessionStateMigration." ++ name

/-! ## operations.json — append, replace-all and delete-last over one stream -/

/-- One operation, as the replay drives it. -/
inductive Op where
  | append (entries : List Entry)
  | replaceAll (entries : List Entry)
  | deleteLast
  | deleteStream

private def entryJson (e : Entry) : Json :=
  Json.mkObj
    [("entryKey", match e.key with | none => Json.null | some k => Json.str k),
     ("payload", Json.str e.payload)]

private def opJson : Op → Json
  | .append es => Json.mkObj [("op", "append"), ("entries", Json.arr (es.map entryJson).toArray)]
  | .replaceAll es =>
    Json.mkObj [("op", "replace-all"), ("entries", Json.arr (es.map entryJson).toArray)]
  | .deleteLast => Json.mkObj [("op", "delete-last")]
  | .deleteStream => Json.mkObj [("op", "delete-stream")]

private def theKey : StreamKey :=
  { workspace := "w1", session := "se1", engine := "claude-agent-sdk", stream := "w1/" }

private def applyOp (st : Store) : Op → Store
  | .append es => append st theKey es
  | .replaceAll es => replaceAll st theKey es
  | .deleteLast => deleteLast st theKey
  | .deleteStream => deleteStream st theKey

private def run (ops : List Op) : Option (List Entry) :=
  list (ops.foldl applyOp empty) theKey

private def entriesJson : Option (List Entry) → Json
  | none => Json.null
  | some es => Json.arr (es.map entryJson).toArray

private def opVector (id : String) (ops : List Op) : Vector :=
  { id,
    input := Json.mkObj [("operations", Json.arr (ops.map opJson).toArray)],
    expected := Json.mkObj [("entries", entriesJson (run ops))],
    witnesses :=
      [t "Invariants" "replace_all_yields_exactly_those_entries",
       t "Invariants" "append_of_a_known_key_does_not_grow_the_stream",
       t "Invariants" "append_of_a_keyless_entry_always_grows_the_stream",
       t "Invariants" "delete_last_removes_exactly_the_last"] }

private def keyed (k p : String) : Entry := { key := some k, payload := p }
private def keyless (p : String) : Entry := { key := none, payload := p }

def operationVectors : List Vector :=
  [opVector "never-written" [],
   opVector "empty-batch-creates-the-stream" [.append []],
   opVector "two-entries" [.append [keyed "a" "first", keyed "b" "second"]],
   opVector "redelivery-upserts-in-place"
     [.append [keyed "a" "first", keyed "b" "second"], .append [keyed "a" "redelivered"]],
   opVector "keyless-entries-are-never-deduped"
     [.append [keyless "summary"], .append [keyless "summary"]],
   opVector "delete-last-removes-one"
     [.append [keyed "a" "first", keyed "b" "second"], .deleteLast],
   opVector "delete-last-of-an-empty-stream" [.append [], .deleteLast],
   opVector "replace-all-renumbers"
     [.append [keyed "a" "first"], .replaceAll [keyed "z" "only"]],
   opVector "delete-stream-is-not-an-empty-stream" [.append [keyed "a" "first"], .deleteStream]]

/-! ## access.json — who may touch a stream, and on which engine -/

private def outcomeJson : Outcome → Json
  | .stored _ => Json.mkObj [("outcome", "stored")]
  | .read entries => Json.mkObj [("outcome", "read"), ("entries", entriesJson entries)]
  | .refused r =>
    Json.mkObj
      [("outcome", "refused"), ("code", Json.str r.code), ("status", Json.num r.status)]

private def accessVector (id : String) (tok : RunToken) (pinned : Option String) (k : StreamKey) :
    Vector :=
  { id,
    input :=
      Json.mkObj
        [("token", Json.mkObj [("workspace", tok.workspace), ("session", tok.session)]),
         ("pinnedEngine", match pinned with | none => Json.null | some e => Json.str e),
         ("stream",
           Json.mkObj
             [("workspace", k.workspace), ("session", k.session), ("engine", k.engine),
              ("streamKey", k.stream)])],
    expected := outcomeJson (serveGuardedWrite tok pinned empty k [keyed "a" "first"]),
    witnesses :=
      [t "Adversarial" "another_sessions_stream_cannot_be_written",
       t "Adversarial" "another_workspaces_stream_is_refused",
       t "Adversarial" "a_stream_of_another_engine_is_refused",
       t "Adversarial" "an_unpinned_session_accepts_any_engine",
       t "Adversarial" "the_engine_refusal_never_leaks_a_hidden_session",
       t "Adversarial" "a_claude_write_outside_its_project_key_is_refused",
       t "Adversarial" "the_project_key_refusal_is_a_403",
       t "Adversarial" "the_project_key_refusal_never_leaks_a_hidden_session"] }

private def ownToken : RunToken := { workspace := "w1", session := "se1" }

def accessVectors : List Vector :=
  [accessVector "own-session-pinned-to-this-engine" ownToken (some "claude-agent-sdk") theKey,
   accessVector "own-session-not-yet-pinned" ownToken none theKey,
   accessVector "another-session" ownToken (some "claude-agent-sdk")
     { theKey with session := "se2" },
   accessVector "another-workspace" ownToken (some "claude-agent-sdk")
     { theKey with workspace := "w2" },
   accessVector "engine-disagrees" ownToken (some "another-engine") theKey,
   accessVector "another-session-of-another-engine" ownToken (some "another-engine")
     { theKey with session := "se2" },
   accessVector "claude-key-outside-the-project-key" ownToken (some "claude-agent-sdk")
     { theKey with stream := "cwd-derived/" },
   accessVector "another-session-outside-the-project-key" ownToken (some "claude-agent-sdk")
     { theKey with session := "se2", stream := "cwd-derived/" }]

/-! ## blobs.json — the size cap -/

private def blobVector (id : String) (size : Nat) : Vector :=
  { id,
    input := Json.mkObj [("sizeBytes", Json.num size), ("cap", Json.num blobCap)],
    expected :=
      outcomeJson
        (serveBlob ownToken (some "claude-agent-sdk") empty
          { workspace := "w1", session := "se1", engine := "claude-agent-sdk",
            blob := "state.tar" }
          size),
    witnesses :=
      [t "Invariants" "a_blob_over_the_cap_is_refused",
       t "Invariants" "an_over_cap_blob_answers_413"] }

def blobVectors : List Vector :=
  [blobVector "empty" 0,
   blobVector "small" 1024,
   blobVector "exactly-the-cap" blobCap,
   blobVector "one-byte-over" (blobCap + 1)]

/-! ## durability.json — the engine-neutral verdict -/

private def durabilityVector (id : String) (adapter : Bool) (failures : Nat) : Vector :=
  { id,
    input := Json.mkObj [("adapterSaysDurable", Json.bool adapter),
      ("storeWriteFailures", Json.num failures)],
    expected := Json.mkObj [("durable", Json.bool (durable adapter failures))],
    witnesses :=
      [t "Invariants" "a_failed_store_write_is_not_durable",
       t "Invariants" "a_clean_store_returns_the_adapters_answer"] }

def durabilityVectors : List Vector :=
  [durabilityVector "clean-store-durable-adapter" true 0,
   durabilityVector "clean-store-undurable-adapter" false 0,
   durabilityVector "one-failed-write" true 1,
   durabilityVector "many-failed-writes" true 7,
   durabilityVector "failed-write-and-undurable-adapter" false 2]

/-! ## migration.json — the Claude transcript, before and after -/

private def deliveryJson (d : Delivery) : Json :=
  Json.mkObj
    [("position", Json.num d.position), ("sequence", Json.num d.sequence),
     ("entryUuid", match d.uuid with | none => Json.null | some u => Json.str u),
     ("payload", Json.str d.payload)]

private def migrationVector (id : String) (ds : List Delivery) : Vector :=
  { id,
    input := Json.mkObj [("deliveries", Json.arr (ds.map deliveryJson).toArray)],
    expected :=
      Json.mkObj
        [("legacyLoad", Json.arr ((legacyLoad ds).map entryJson).toArray),
         ("migrated", Json.arr ((migrated ds).map entryJson).toArray)],
    witnesses :=
      [refinement "migration_preserves_the_history",
       refinement "a_migrated_session_reads_back_its_history"] }

def migrationVectors : List Vector :=
  [migrationVector "one-entry"
     [{ position := 1, sequence := 1, uuid := some "u-1", payload := "first" }],
   migrationVector "redelivery-and-a-keyless-entry"
     [{ position := 1, sequence := 1, uuid := some "u-1", payload := "first" },
      { position := 2, sequence := 2, uuid := some "u-2", payload := "second" },
      { position := 3, sequence := 3, uuid := none, payload := "summary" },
      { position := 1, sequence := 4, uuid := some "u-1", payload := "redelivered" }],
   migrationVector "two-redeliveries-of-one-entry"
     [{ position := 1, sequence := 1, uuid := some "u-1", payload := "first" },
      { position := 1, sequence := 2, uuid := some "u-1", payload := "second" },
      { position := 1, sequence := 3, uuid := some "u-1", payload := "third" }],
   migrationVector "empty-transcript" []]

/-! ## transcript-read.json — the public transcript read, over both stores -/

private def transcriptReadVector (id : String) (stored : Option (List Entry))
    (legacy : Option (List Delivery)) : Vector :=
  let st := match stored with
    | none => empty
    | some es => replaceAll empty theKey es
  { id,
    input :=
      Json.mkObj
        [("storeEntries", entriesJson stored),
         ("legacyDeliveries",
           match legacy with
           | none => Json.null
           | some ds => Json.arr (ds.map deliveryJson).toArray)],
    expected := Json.mkObj [("entries", entriesJson (publicTranscriptRead st theKey legacy))],
    witnesses :=
      [refinement "the_public_read_serves_the_store_when_it_has_the_stream",
       refinement "a_pre_eng06_session_falls_back_to_its_legacy_history",
       refinement "the_public_read_is_unchanged_by_the_migration"] }

private def oldLog : List Delivery :=
  [{ position := 1, sequence := 1, uuid := some "u-1", payload := "first" },
   { position := 2, sequence := 2, uuid := none, payload := "summary" },
   { position := 1, sequence := 3, uuid := some "u-1", payload := "redelivered" }]

def transcriptReadVectors : List Vector :=
  [transcriptReadVector "a-new-session-is-served-from-the-store"
     (some [keyed "a" "first", keyed "b" "second"]) none,
   transcriptReadVector "the-store-wins-over-the-legacy-tables"
     (some [keyed "a" "current"]) (some oldLog),
   transcriptReadVector "an-empty-stream-is-an-empty-transcript" (some []) (some oldLog),
   transcriptReadVector "a-pre-eng06-session-falls-back" none (some oldLog),
   transcriptReadVector "a-pre-eng06-empty-transcript-falls-back" none (some []),
   transcriptReadVector "neither-store-has-it" none none]

/-! ## stream-keys.json — the one opaque string a Claude key becomes -/

private def streamKeyVector (id projectKey subpath : String) : Vector :=
  { id,
    input := Json.mkObj [("projectKey", projectKey), ("subpath", subpath)],
    expected := Json.mkObj [("streamKey", claudeStreamKey projectKey subpath)],
    witnesses := [refinement "the_main_transcript_lands_under_the_project_key"] }

def streamKeyVectors : List Vector :=
  [streamKeyVector "main" "w1" "",
   streamKeyVector "subagent" "w1" "subagents/agent-1",
   streamKeyVector "nested-subagent" "w1" "subagents/agent-1/nested"]

def files : List (String × Json) :=
  [("operations.json",
     file "session-state" "Append, replace-all and delete-last over one stream" operationVectors),
   ("access.json",
     file "session-state" "Which streams a run token reaches, and on which engine" accessVectors),
   ("blobs.json", file "session-state" "The blob size cap" blobVectors),
   ("durability.json",
     file "session-state" "The durability verdict, for any engine" durabilityVectors),
   ("migration.json",
     file "session-state" "Today's Claude delivery log, and where 0027 lands it" migrationVectors),
   ("stream-keys.json",
     file "session-state" "A Claude session key as one opaque stream key" streamKeyVectors),
   ("transcript-read.json",
     file "session-state" "The public transcript read, over the store and the legacy tables"
       transcriptReadVectors)]

end Vectors.SessionState
