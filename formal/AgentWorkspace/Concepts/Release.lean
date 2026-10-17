import AgentWorkspace.Prelude.Ids

/-!
# Release: environments, pointer history, the promotion gate, pinned conversations

The one place in the developer journey where several writers act on shared state: `aw push` and a
UI edit add versions, `point`, `promote` and `rollback` move an environment's pointer, a
conversation pins the version it started on, and `aw eval` records a score. This module is the one
model of that state machine (issue #614, `docs/formal/domains/release.md`); 80-07, 80-08 and 80-12
refine it rather than adding a model each.

It is new behaviour, so it has a target only: there is no `…Current` to relate it to.

**Choices.**

* The pointer is not stored: it *is* the head of the environment's history
  (`Release.pointer`). Storing both would need an invariant tying them together; deriving one from
  the other makes them agree by construction.
* Scores are keyed by agent *and* version number. Version numbers restart at 1 for every agent,
  so a number alone does not name a version.
* The bar is optional (`Option Score`): with no bar, promotion needs no evaluation; with a bar, a
  version with no score is refused as not evaluated, and one below the bar as failing the gate
  (80-12, #619).
* `point` to `production` passes the same gate as `promote`, so the gate cannot be bypassed by
  pointing directly. `rollback` does not: it only returns to a version production already ran.
* `rollback` takes the pointer off the history rather than pushing the earlier version on top, so
  the history is the stack of versions an environment can still step back through. Rolling back
  twice goes two versions back, never forward again (BH061-004); the server's audit table still
  records every move, and `decideRollback` reads this stack replayed from it.
* A refused step changes nothing: `step` returns the refusal instead of a state.
-/

namespace AgentWorkspace.Concepts.Release

open AgentWorkspace

/-- An environment: a name, and one pointer per agent. -/
@[aw_spec (doc := "docs/formal/domains/release.md#the-release-model")]
inductive Env where
  | «local»
  | production
  deriving DecidableEq, Repr, Inhabited

namespace Env

/-- The wire spelling. -/
def toWire : Env → String
  | «local» => "local"
  | production => "production"

instance : WireEnum Env where
  all := [«local», production]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end Env

/-- A version number: 1 for an agent's first version, then 2, 3, … -/
abbrev VersionNo := Nat

/-- An evaluation score. The gate compares it with the bar; how it is computed is not modelled. -/
abbrev Score := Nat

/-- One saved version of an agent. -/
structure Version where
  no : VersionNo
  body : String
  deriving DecidableEq, Repr, Inhabited

/-- The release state. -/
@[aw_spec (doc := "docs/formal/domains/release.md#the-release-model")]
structure Release where
  /-- Every version of each agent, oldest first. Only `push` appends; nothing removes. -/
  versions : AgentId → List Version
  /-- Every version an environment has pointed at, newest first. Its head is the pointer. -/
  history : AgentId → Env → List VersionNo
  /-- The recorded score of a version, if any. -/
  evals : AgentId → VersionNo → Option Score
  /-- The agent and version a conversation pinned when it started. -/
  sessions : SessionId → Option (AgentId × VersionNo)

/-- Why a step is refused. The codes are the problem codes 80-07, 80-08 and 80-12 return. -/
@[aw_spec (doc := "docs/formal/domains/release.md#the-release-model")]
inductive Problem where
  | versionNotFound
  | noPointer
  | promotionNotEvaluated
  | promotionGateFailed
  | nothingToRollBack
  | sessionAlreadyStarted
  deriving DecidableEq, Repr, Inhabited

/-- The wire spelling of a refusal. -/
def Problem.toWire : Problem → String
  | .versionNotFound => "version_not_found"
  | .noPointer => "no_pointer"
  | .promotionNotEvaluated => "promotion_not_evaluated"
  | .promotionGateFailed => "promotion_gate_failed"
  | .nothingToRollBack => "nothing_to_roll_back"
  | .sessionAlreadyStarted => "session_already_started"

/-- An operation on the release state. A UI edit is a `push`: it saves a new version. -/
@[aw_spec (doc := "docs/formal/domains/release.md#the-release-model")]
inductive Op where
  | push (agent : AgentId) (body : String)
  | point (agent : AgentId) (env : Env) (v : VersionNo)
  | promote (agent : AgentId) (src dst : Env)
  | rollback (agent : AgentId) (env : Env)
  | startSession (session : SessionId) (agent : AgentId) (env : Env)
  | recordEval (agent : AgentId) (v : VersionNo) (score : Score)
  deriving DecidableEq, Repr

namespace Release

/-- No versions, no pointers, no scores, no conversations. -/
def empty : Release := ⟨fun _ => [], fun _ _ => [], fun _ _ => none, fun _ => none⟩

/-- The version an environment points at for an agent: the head of its history. -/
def pointer (r : Release) (a : AgentId) (e : Env) : Option VersionNo := (r.history a e).head?

/-- Whether the agent has a saved version with this number. -/
def hasVersion (r : Release) (a : AgentId) (v : VersionNo) : Bool :=
  (r.versions a).any (·.no == v)

/-- Every history entry, so every pointer, names a saved version of the same agent. -/
def WellFormed (r : Release) : Prop :=
  ∀ a e v, v ∈ r.history a e → r.hasVersion a v = true

/-- Move a pointer: the new version goes on top of the history, and the old entries stay. -/
def movePointer (r : Release) (a : AgentId) (e : Env) (v : VersionNo) : Release :=
  { r with history := fun b f => if b = a ∧ f = e then v :: r.history b f else r.history b f }

/-- Roll a pointer back: the head of the history comes off, so the entry below it is the pointer. -/
def dropPointer (r : Release) (a : AgentId) (e : Env) : Release :=
  { r with history := fun b f => if b = a ∧ f = e then (r.history b f).tail else r.history b f }

end Release

/-- The promotion gate: a pure decision over the bar and a version's score, `none` when it passes.
With no bar, promotion needs no evaluation. With a bar, a version with no score is not evaluated,
and one scored below the bar fails the gate. -/
@[aw_spec (doc := "docs/formal/domains/release.md#the-release-model")]
def gate : (bar : Option Score) → (score : Option Score) → Option Problem
  | none, _ => none
  | some _, none => some .promotionNotEvaluated
  | some b, some s => if b ≤ s then none else some .promotionGateFailed

/-- The gate for moving an environment's pointer: only `production` is gated. -/
def gateFor (e : Env) (bar score : Option Score) : Option Problem :=
  if e = .production then gate bar score else none

/-- Whether an operation adds a version to this agent: only `push` (an `aw push` or a UI edit). -/
def Op.addsVersionTo : Op → AgentId → Bool
  | .push b _, a => decide (b = a)
  | _, _ => false

open Release in
/-- One step of the release state machine, with the gate's bar as a parameter (`none`: no bar set). -/
@[aw_spec (doc := "docs/formal/domains/release.md#the-release-model")]
def step (bar : Option Score) (r : Release) : Op → Except Problem Release
  | .push a body =>
    .ok { r with versions := fun b =>
      if b = a then r.versions b ++ [⟨(r.versions b).length + 1, body⟩] else r.versions b }
  | .point a e v =>
    if r.hasVersion a v = false then .error .versionNotFound
    else match gateFor e bar (r.evals a v) with
      | some p => .error p
      | none => .ok (r.movePointer a e v)
  | .promote a src dst =>
    match r.pointer a src with
    | none => .error .noPointer
    | some v =>
      match gateFor dst bar (r.evals a v) with
      | some p => .error p
      | none => .ok (r.movePointer a dst v)
  | .rollback a e =>
    match r.history a e with
    | _ :: _ :: _ => .ok (r.dropPointer a e)
    | _ => .error .nothingToRollBack
  | .startSession s a e =>
    if (r.sessions s).isSome then .error .sessionAlreadyStarted
    else match r.pointer a e with
      | none => .error .noPointer
      | some v => .ok { r with sessions := fun t => if t = s then some (a, v) else r.sessions t }
  | .recordEval a v score =>
    if r.hasVersion a v = false then .error .versionNotFound
    else .ok { r with evals := fun b w => if b = a ∧ w = v then some score else r.evals b w }

end AgentWorkspace.Concepts.Release
