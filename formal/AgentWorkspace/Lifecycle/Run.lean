import AgentWorkspace.Contracts.Runs

/-!
# The run status machine

The observable transitions of a run's `status`, as the two run stores implement them
(`InMemoryRunStore` in `apps/web/server/runs/store.ts` and the PostgreSQL repository in
`packages/core/src/db/repositories/runs.ts`, whose guards are the `WHERE` clauses of the two
updates):

* `markRunning` moves a run only from `queued` to `running`; anything else is a no-op;
* `finish s` requires a terminal `s` (a non-terminal target is a programming error, which both
  stores throw) and moves any non-terminal run to `s`; on a terminal run it is a no-op, so the
  first terminal transition wins.

Interrupt (`POST /api/runs/:id/interrupt`) is `finish cancelled` on a live run and the problem
`run_not_interruptible` on a terminal one (ADR SDK-03-RUN-235); it is modelled with the runs
behaviour, not here.
-/

namespace AgentWorkspace.Lifecycle

open AgentWorkspace.Contracts

/-- A status-changing store operation. -/
inductive RunOp where
  | markRunning
  | finish (target : RunStatus)
  deriving DecidableEq, Repr, Inhabited

/-- What a store operation does to one run's status. -/
inductive RunStepOutcome where
  /-- The row moved to the new status. -/
  | moved (next : RunStatus)
  /-- The guard did not match; nothing changed. -/
  | noOp
  /-- The call itself is invalid (a non-terminal `finish` target); both stores throw. -/
  | invalidCall
  deriving DecidableEq, Repr, Inhabited

/-- One operation on a run whose current status is `current`. -/
@[aw_spec (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#from-start-to-a-terminal-status")
  (ts := "apps/web/server/runs/store.ts#InMemoryRunStore")
  (ts := "packages/core/src/db/repositories/runs.ts#markRunning")
  (ts := "packages/core/src/db/repositories/runs.ts#finish")]
def runStep (current : RunStatus) : RunOp → RunStepOutcome
  | .markRunning => if current = .queued then .moved .running else .noOp
  | .finish target =>
    if !target.isTerminal then .invalidCall
    else if current.isTerminal then .noOp
    else .moved target

/-- The status after an operation: unchanged unless the operation moved the run. -/
def applyRunOp (current : RunStatus) (op : RunOp) : RunStatus :=
  match runStep current op with
  | .moved next => next
  | .noOp | .invalidCall => current

/-- The status after a sequence of operations. -/
def applyRunOps (current : RunStatus) (ops : List RunOp) : RunStatus :=
  ops.foldl applyRunOp current

/-- The one-step transition relation the status machine admits. -/
def RunTransition (s t : RunStatus) : Prop := ∃ op, runStep s op = .moved t

/-! The store transition and the control-plane event append are separate transactions. -/

/-- The observable lifecycle fields of one created run. Time is a logical clock in milliseconds.
`runTokenRevoked` models the durable repository's revocation in its finish transaction;
`browserTokenRevoked` is a different token table, changed explicitly by interrupt. -/
structure RunState where
  status : RunStatus := .queued
  clock : Nat := 0
  startedAt : Option Nat := none
  endedAt : Option Nat := none
  statusEvents : List RunStatus := []
  terminalEvents : List RunStatus := []
  logClosed : Bool := false
  runTokenRevoked : Bool := false
  browserTokenRevoked : Bool := false
  runtimeSignalled : Bool := false
  deriving DecidableEq, Repr, Inhabited

/-- Primitive operations that can interleave across launcher and interrupt requests. -/
inductive RunAction where
  | markRunning (elapsed : Nat)
  | appendRunning
  | appendTerminal (target : RunStatus)
  | finish (target : RunStatus) (elapsed : Nat)
  | finishWithStatusEvent (target : RunStatus) (elapsed : Nat)
  | revokeBrowserTokens
  | signalRuntime
  deriving DecidableEq, Repr, Inhabited

/-- One store/control-plane operation. An append is allowed until `finish` closes the log.
The repository revokes gateway run tokens in the same transaction as terminal `finish`. -/
@[aw_spec (ts := "apps/web/server/runs/store.ts#InMemoryRunStore")
  (ts := "packages/core/src/db/repositories/runs.ts#finish")
  (ts := "apps/web/server/composition/register.ts#interruptRun")]
def runAction (s : RunState) : RunAction → RunState
  | .markRunning elapsed =>
    if s.status = .queued then
      let started := { s with status := RunStatus.running }
      let started := { started with clock := s.clock + elapsed }
      { started with startedAt := some (s.clock + elapsed) }
    else s
  | .appendRunning =>
    if !s.logClosed then { s with statusEvents := s.statusEvents ++ [.running] }
    else s
  | .appendTerminal target =>
    if target.isTerminal && !s.logClosed then
      let appended := { s with statusEvents := s.statusEvents ++ [target] }
      { appended with terminalEvents := s.terminalEvents ++ [target] }
    else s
  | .finish target elapsed =>
    if target.isTerminal && !s.status.isTerminal then
      let now := s.clock + elapsed
      let finished := { s with status := target }
      let finished := { finished with clock := now }
      let finished := { finished with startedAt := some (s.startedAt.getD now) }
      let finished := { finished with endedAt := some now }
      let finished := { finished with logClosed := true }
      { finished with runTokenRevoked := true }
    else s
  | .finishWithStatusEvent target elapsed =>
    if target.isTerminal && !s.status.isTerminal then
      let now := s.clock + elapsed
      let finished := { s with status := target }
      let finished := { finished with clock := now }
      let finished := { finished with startedAt := some (s.startedAt.getD now) }
      let finished := { finished with endedAt := some now }
      let finished := { finished with statusEvents := s.statusEvents ++ [target] }
      let finished := { finished with terminalEvents := s.terminalEvents ++ [target] }
      let finished := { finished with logClosed := true }
      { finished with runTokenRevoked := true }
    else s
  | .revokeBrowserTokens => { s with browserTokenRevoked := true }
  | .signalRuntime => { s with runtimeSignalled := true }

/-- The terminal status event commits with the winning state change. -/
def interruptActions (elapsed : Nat) : List RunAction :=
  [.finishWithStatusEvent .cancelled elapsed,
   .revokeBrowserTokens, .signalRuntime]

/-- Sequential execution of primitive actions, including an interleaving chosen by the caller. -/
def runActions (s : RunState) (actions : List RunAction) : RunState :=
  actions.foldl runAction s

/-- Historical conclude pattern before the terminal event was made part of finish. -/
def terminalCommitCurrent (s : RunState) (target : RunStatus) (elapsed : Nat) : RunState :=
  runActions s [.appendTerminal target, .finish target elapsed]

/-- Single terminal commit: emit only the status that actually won the record update. -/
def terminalCommitTarget (s : RunState) (target : RunStatus) (elapsed : Nat) : RunState :=
  runAction s (.finishWithStatusEvent target elapsed)

/-- The intended event discipline: one terminal event, matching the terminal record. -/
def terminalEventAgrees (s : RunState) : Prop :=
  s.status.isTerminal = true → s.terminalEvents = [s.status]

/-- An interrupt on a terminal run is rejected by the HTTP boundary before its effects. -/
def interruptAllowed (s : RunState) : Bool := !s.status.isTerminal

/-- The lifecycle part of the interrupt route's response. Authorization and lookup precede it. -/
inductive InterruptDecision where
  | accepted
  | runNotInterruptible
  deriving DecidableEq, Repr, Inhabited

@[aw_spec (ts := "apps/web/server/runs/api.ts#interruptRun")]
def interruptDecision (s : RunState) : InterruptDecision :=
  if interruptAllowed s then .accepted else .runNotInterruptible

end AgentWorkspace.Lifecycle
