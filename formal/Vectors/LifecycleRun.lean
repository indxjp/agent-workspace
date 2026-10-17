import AgentWorkspace.Lifecycle.Run
import Vectors.Common

namespace Vectors.LifecycleRun

open Lean AgentWorkspace AgentWorkspace.Contracts AgentWorkspace.Lifecycle

def actionJson : RunAction → Json
  | .markRunning elapsed => Json.mkObj [("op", "markRunning"), ("elapsed", toJson elapsed)]
  | .appendRunning => Json.mkObj [("op", "appendRunning")]
  | .appendTerminal target =>
    Json.mkObj [("op", "appendTerminal"), ("target", WireEnum.toJsonValue target)]
  | .finish target elapsed =>
    Json.mkObj [("op", "finish"), ("target", WireEnum.toJsonValue target),
      ("elapsed", toJson elapsed)]
  | .finishWithStatusEvent target elapsed =>
    Json.mkObj [("op", "finishWithStatusEvent"), ("target", WireEnum.toJsonValue target),
      ("elapsed", toJson elapsed)]
  | .revokeBrowserTokens => Json.mkObj [("op", "revokeBrowserTokens")]
  | .signalRuntime => Json.mkObj [("op", "signalRuntime")]

def stateJson (s : RunState) : Json := Json.mkObj
  [("status", WireEnum.toJsonValue s.status),
   ("startedAt", toJson s.startedAt), ("endedAt", toJson s.endedAt),
   ("logClosed", toJson s.logClosed), ("runTokenRevoked", toJson s.runTokenRevoked),
   ("browserTokenRevoked", toJson s.browserTokenRevoked),
   ("statusEvents", toJson (s.statusEvents.map WireEnum.toWire)),
   ("terminalEvents", toJson (s.terminalEvents.map WireEnum.toWire))]

def sequence (id : String) (actions : List RunAction) (witness : String) : Vector :=
  { id, input := toJson (actions.map actionJson),
    expected := stateJson (runActions {} actions), witnesses := [witness] }

def files : List (String × Json) :=
  [("run-sequences.json", file "lifecycle-run"
    "Timestamp and terminal operation sequences against InMemoryRunStore"
    [sequence "mark-once" [.markRunning 3, .markRunning 9]
       "AgentWorkspace.Theorems.Normative.LifecycleRun.mark_running_stamps_once",
     sequence "created" []
       "AgentWorkspace.Theorems.Normative.LifecycleRun.created_run_fields",
     sequence "queued-cancel" [.finish .cancelled 7]
       "AgentWorkspace.Theorems.Normative.LifecycleRun.queued_finish_stamps_both",
     sequence "queued-complete" [.finish .completed 7]
       "AgentWorkspace.Theorems.Normative.Runs.queued_run_may_finish_directly",
     sequence "queued-fail" [.finish .failed 7]
       "AgentWorkspace.Theorems.Normative.Runs.queued_run_may_finish_directly",
     sequence "running-complete" [.markRunning 2, .finish .completed 5]
       "AgentWorkspace.Theorems.Invariants.LifecycleRun.every_sequence_closes_at_terminal",
     sequence "running-cancel" [.markRunning 2, .finish .cancelled 5]
       "AgentWorkspace.Theorems.Invariants.LifecycleRun.every_sequence_closes_at_terminal",
     sequence "first-finish-wins" [.finish .failed 2, .finish .completed 4]
       "AgentWorkspace.Theorems.Invariants.Runs.run_terminal_is_absorbing",
     sequence "mark-after-finish" [.finish .completed 3, .markRunning 7]
       "AgentWorkspace.Theorems.Invariants.Runs.run_terminal_is_absorbing",
     sequence "invalid-target" [.finish .running 2]
       "AgentWorkspace.Theorems.Normative.Runs.finish_requires_terminal_target",
     sequence "preparation-failure"
       [.markRunning 1, .appendRunning, .finishWithStatusEvent .failed 1]
       "AgentWorkspace.Theorems.Normative.LifecycleRun.preparation_failure_path",
     sequence "interrupt" (interruptActions 2)
       "AgentWorkspace.Theorems.Normative.LifecycleRun.interrupt_effects",
     sequence "race" [.finishWithStatusEvent .cancelled 1, .finishWithStatusEvent .completed 1]
       "AgentWorkspace.Theorems.Refinement.LifecycleRun.interrupt_conclude_race_agrees"])]

end Vectors.LifecycleRun
