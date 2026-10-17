import AgentWorkspace.Theorems.Normative.Release
import AgentWorkspace.Theorems.Invariants.Release
import AgentWorkspace.Theorems.Adversarial.Release
import Vectors.Common

/-!
The `release` family: step sequences over `Concepts.Release.step` and the state after each step,
replayed by `tests/formal/release.test.ts` against `decidePromote`, `decideRollback` and
`resolveSessionVersion` once 80-07, 80-08 and 80-12 export them.

Every scenario starts from the empty state with one agent (`agent-a`) and the bar given in its
input (`null`: no bar set). After each step the vector records the refusal code, or `null`, and the observable
state: the version count, each environment's pointer and history, and each conversation's pin. A
refused step leaves the state as it was.
-/

namespace Vectors.Release

open Lean AgentWorkspace AgentWorkspace.Concepts.Release

private def t (tier name : String) : String :=
  "AgentWorkspace.Theorems." ++ tier ++ ".Release." ++ name

private def agent : AgentId := ⟨"agent-a"⟩
private def sessionIds : List String := ["s1", "s2"]

private def optJson : Option Nat → Json
  | some n => toJson n
  | none => Json.null

private def opJson : Op → Json
  | .push _ body => Json.mkObj [("op", "push"), ("body", body)]
  | .point _ e v => Json.mkObj [("op", "point"), ("env", e.toWire), ("version", toJson v)]
  | .promote _ s d => Json.mkObj [("op", "promote"), ("from", s.toWire), ("to", d.toWire)]
  | .rollback _ e => Json.mkObj [("op", "rollback"), ("env", e.toWire)]
  | .startSession s _ e => Json.mkObj [("op", "startSession"), ("session", s.val), ("env", e.toWire)]
  | .recordEval _ v score =>
    Json.mkObj [("op", "recordEval"), ("version", toJson v), ("score", toJson score)]

private def stateJson (r : Release) : Json :=
  Json.mkObj
    [("versions", toJson (r.versions agent).length),
     ("pointer", Json.mkObj ((WireEnum.all : List Env).map fun e => (e.toWire, optJson (r.pointer agent e)))),
     ("history", Json.mkObj ((WireEnum.all : List Env).map fun e => (e.toWire, toJson (r.history agent e)))),
     ("sessions", Json.mkObj (sessionIds.map fun s =>
       (s, optJson ((r.sessions ⟨s⟩).map Prod.snd))))]

/-- Run the steps from the empty state, recording each outcome. -/
private def replay (bar : Option Score) (ops : List Op) : List Json :=
  (ops.foldl (fun (acc : Release × List Json) op =>
    match step bar acc.1 op with
    | .ok r' => (r', acc.2 ++ [Json.mkObj [("problem", Json.null), ("state", stateJson r')]])
    | .error p => (acc.1, acc.2 ++
        [Json.mkObj [("problem", p.toWire), ("state", stateJson acc.1)]]))
    (Release.empty, [])).2

private structure Scenario where
  id : String
  bar : Option Score
  ops : List Op
  witnesses : List String

private def push (body : String) : Op := .push agent body
private def point (e : Env) (v : VersionNo) : Op := .point agent e v
private def promote : Op := .promote agent .«local» .production
private def rollback (e : Env) : Op := .rollback agent e
private def start (s : String) (e : Env) : Op := .startSession ⟨s⟩ agent e
private def score (v : VersionNo) (s : Score) : Op := .recordEval agent v s

private def common : List String :=
  [t "Invariants" "versions_append_only", t "Invariants" "pointer_targets_existing_version",
   t "Adversarial" "ui_edit_is_a_version"]

private def scenarios : List Scenario :=
  [{ id := "promote-without-a-bar-needs-no-evaluation", bar := none,
     ops := [push "v1", point .«local» 1, promote],
     witnesses := common ++ [t "Normative" "promote_without_a_bar_needs_no_evaluation"] },
   { id := "promote-passes-the-gate", bar := some 70,
     ops := [push "v1", point .«local» 1, score 1 80, promote],
     witnesses := common ++ [t "Normative" "promote_requires_gate"] },
   { id := "promote-without-a-score-is-not-evaluated", bar := some 70,
     ops := [push "v1", point .«local» 1, promote],
     witnesses := common ++ [t "Normative" "promote_requires_gate"] },
   { id := "promote-below-the-bar-fails-the-gate", bar := some 70,
     ops := [push "v1", point .«local» 1, score 1 60, promote, score 1 70, promote],
     witnesses := common ++ [t "Normative" "promote_requires_gate"] },
   { id := "point-production-passes-the-gate-too", bar := some 70,
     ops := [push "v1", point .production 1, score 1 90, point .production 1],
     witnesses := common },
   { id := "point-at-a-missing-version-is-refused", bar := none,
     ops := [push "v1", point .«local» 2, score 3 50],
     witnesses := common },
   { id := "promote-then-rollback-is-identity", bar := some 50,
     ops := [push "v1", point .«local» 1, score 1 60, promote, push "v2", point .«local» 2,
       score 2 70, promote, rollback .production],
     witnesses := common ++ [t "Normative" "promote_requires_gate",
       t "Invariants" "rollback_restores_previous",
       t "Invariants" "rollback_after_promote_is_identity"] },
   { id := "rollback-twice-steps-back-twice", bar := none,
     ops := [push "v1", push "v2", push "v3", point .«local» 1, point .«local» 2,
       point .«local» 3, rollback .«local», rollback .«local», rollback .«local»],
     witnesses := common ++ [t "Invariants" "rollback_restores_previous"] },
   { id := "rollback-needs-a-previous-version", bar := none,
     ops := [rollback .«local», push "v1", point .«local» 1, rollback .«local»],
     witnesses := common },
   { id := "a-conversation-keeps-its-version", bar := none,
     ops := [start "s1" .«local», push "v1", point .«local» 1, start "s1" .«local», push "v2",
       point .«local» 2, start "s2" .«local», rollback .«local», start "s1" .«local», promote],
     witnesses := common ++ [t "Adversarial" "session_version_stable"] }]

def releaseVectors : List Vector :=
  scenarios.map fun s =>
    { id := s.id,
      input := Json.mkObj [("agent", agent.val), ("bar", optJson s.bar),
        ("ops", Json.arr (s.ops.map opJson).toArray)],
      expected := Json.mkObj [("steps", Json.arr (replay s.bar s.ops).toArray)],
      witnesses := s.witnesses }

def files : List (String × Json) :=
  [("steps.json",
     file "release" "step: environments, pointer history, the promotion gate, pinned conversations"
       releaseVectors)]

end Vectors.Release
