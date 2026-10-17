import AgentWorkspace.Contracts.RunEvents

/-! The per-run event log and the two `openStream` termination tests. A cycle separates a list
read from a later terminal read so the repository adapter's race is expressible. -/

namespace AgentWorkspace.Events.RunLog

open AgentWorkspace

structure Event where
  id : Nat
  name : String
  data : JValue
  deriving DecidableEq, Repr

structure Log where
  lastId : Nat
  retained : List Event
  closed : Bool
  deriving DecidableEq, Repr

def empty : Log := ⟨0, [], false⟩

@[aw_spec (ts := "apps/web/server/runs/store.ts#DEFAULT_MAX_EVENTS_PER_RUN")]
def defaultMaxEvents : Nat := 50000

/-- In-memory append allocates `max + 1`, retains only the newest `limit` events, and refuses a
closed log. The database adapter makes the same allocation under its advisory lock. -/
@[aw_spec (ts := "apps/web/server/runs/store.ts#RunEventLog")
  (ts := "packages/core/src/db/repositories/runs.ts#createDatabaseRunEventRepositoryProvider")]
def append (limit : Nat) (log : Log) (name : String) (data : JValue) : Option (Log × Event) :=
  if log.closed then none
  else
    let event : Event := ⟨log.lastId + 1, name, data⟩
    let kept := (log.retained ++ [event]).drop ((log.retained.length + 1) - limit)
    some (⟨event.id, kept, false⟩, event)

@[aw_spec (ts := "apps/web/server/runs/store.ts#RunEventLog")]
def close (log : Log) : Log := { log with closed := true }

def oldest (log : Log) : Nat :=
  match log.retained.head? with
  | some event => event.id
  | none => log.lastId + 1

inductive Reset where
  | gap (resumedAfter : Option Nat)
  | ahead (resumedAfter : Option Nat)
  deriving DecidableEq, Repr

/-- Both stores announce a gap when the requested beginning has been evicted, including a first
connection without a cursor. -/
@[aw_spec (ts := "apps/web/server/runs/store.ts#InMemoryRunStore")
  (ts := "apps/web/server/runs/store.ts#createRepositoryRunStore")]
def resetFor (log : Log) (after : Option Nat) : Option Reset :=
  match after with
  | none =>
    if !log.retained.isEmpty && oldest log > 1 then
      some (.gap (some (oldest log - 1)))
    else none
  | some n =>
    let resumed := if log.retained.isEmpty then none else some (oldest log - 1)
    if n < oldest log - 1 then some (.gap resumed)
    else if n > log.lastId then some (.ahead resumed)
    else none

def startCursor (log : Log) (after : Option Nat) : Nat :=
  if (resetFor log after).isSome then oldest log - 1 else after.getD 0

def pending (log : Log) (cursor : Nat) : List Event :=
  log.retained.filter (·.id > cursor)

/-- The in-memory loop sends all retained events before testing its closed-and-caught-up exit. -/
@[aw_spec (ts := "apps/web/server/runs/store.ts#RunEventLog")]
def memoryMayEnd (log : Log) (cursor : Nat) : Bool :=
  log.closed && cursor ≥ log.lastId

/-- The repository loop returns after it reads a terminal run and drains the durable tail. -/
@[aw_spec (ts := "apps/web/server/runs/store.ts#createRepositoryRunStore")]
def repositoryMayEndCurrent (terminal : Bool) : Bool := terminal

/-- The intended exit test includes the event-log tail. -/
def repositoryMayEndTarget (log : Log) (cursor : Nat) (terminal : Bool) : Bool :=
  terminal && cursor ≥ log.lastId

/-- The observable one-cycle result: `listed` was read before `afterList`, the state seen by the
terminal read and final drain. -/
structure FollowCycle where
  delivered : List Event
  cursor : Nat
  currentEnds : Bool
  targetEnds : Bool
  deriving DecidableEq, Repr

def repositoryCycle (listed afterList : Log) (cursor : Nat) (terminal : Bool) : FollowCycle :=
  let first := pending listed cursor
  let firstCursor := match first.getLast? with
    | some event => event.id
    | none => cursor
  let tail := if terminal then pending afterList firstCursor else []
  let sent := first ++ tail
  let finalCursor := match sent.getLast? with
    | some event => event.id
    | none => cursor
  ⟨sent, finalCursor, repositoryMayEndCurrent terminal,
    repositoryMayEndTarget afterList finalCursor terminal⟩

end AgentWorkspace.Events.RunLog
