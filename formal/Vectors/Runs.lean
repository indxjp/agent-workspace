import AgentWorkspace.Lifecycle.Run
import Vectors.Common

/-! Vectors for the runs family: the status enumeration and the status machine. -/

namespace Vectors.Runs

open Lean AgentWorkspace AgentWorkspace.Contracts AgentWorkspace.Lifecycle

def opJson : RunOp → Json
  | .markRunning => Json.mkObj [("op", "markRunning")]
  | .finish t => Json.mkObj [("op", "finish"), ("target", WireEnum.toJsonValue t)]

def outcomeJson : RunStepOutcome → Json
  | .moved t => Json.mkObj [("kind", "moved"), ("status", WireEnum.toJsonValue t)]
  | .noOp => Json.mkObj [("kind", "noOp")]
  | .invalidCall => Json.mkObj [("kind", "invalidCall")]

def allOps : List RunOp := .markRunning :: (WireEnum.all : List RunStatus).map .finish

/-- Strings that must not decode: case, whitespace, near misses, other enums' members. -/
def invalidSpellings : List String :=
  ["", "Queued", "QUEUED", " queued", "queued ", "canceled", "cancel", "done", "succeeded",
    "pending", "complete", "error", "unknown", "running\u0000"]

def statusVectors : List Vector :=
  let valid := (WireEnum.all : List RunStatus).map fun s =>
    ({ id := s!"status/valid/{WireEnum.toWire s}", input := WireEnum.toJsonValue s,
       expected := Json.mkObj [("valid", true), ("terminal", s.isTerminal)],
       witnesses := ["AgentWorkspace.Theorems.WellFormed.Runs.run_status_json_round_trips",
         "AgentWorkspace.Theorems.WellFormed.Runs.is_terminal_iff_mem_terminal"] } : Vector)
  let invalid := invalidSpellings.map fun w =>
    ({ id := s!"status/invalid/{(Json.str w).compress}", input := Json.str w,
       expected := Json.mkObj [("valid", false)],
       witnesses := ["AgentWorkspace.Theorems.WellFormed.Runs.run_status_rejects_unknown_spelling"] }
      : Vector)
  valid ++ invalid

def transitionVectors : List Vector :=
  (WireEnum.all : List RunStatus).flatMap fun s => allOps.map fun op =>
    { id := s!"transition/{WireEnum.toWire s}/{(opJson op).compress}",
      input := Json.mkObj [("from", WireEnum.toJsonValue s), ("operation", opJson op)],
      expected := outcomeJson (runStep s op),
      witnesses := ["AgentWorkspace.Theorems.Normative.Runs.running_is_entered_only_from_queued",
        "AgentWorkspace.Theorems.Normative.Runs.finish_requires_terminal_target",
        "AgentWorkspace.Theorems.Invariants.Runs.run_terminal_is_absorbing"] }

def files : List (String × Json) :=
  [("run-status.json",
      file "runs" "RUN_STATUSES: every member and a set of near-miss spellings" statusVectors),
   ("run-transitions.json",
      file "runs" "Every run status × every store operation" transitionVectors)]

end Vectors.Runs
