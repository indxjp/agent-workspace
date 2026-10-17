import AgentWorkspace.Lifecycle.Run
import AgentWorkspace.Concepts.Usage

/-! Usage settlement can continue after the run's status becomes terminal. -/

namespace AgentWorkspace.Lifecycle

open AgentWorkspace.Concepts.Usage

/-- The repository's aggregate accounting state, including a settlement failure marker.
A later ledger insert recomputes the state and supersedes `failed`. -/
structure RunAccounting where
  ledger : List Bool := []
  state : AccountingState := .pending
  deriving DecidableEq, Repr, Inhabited

/-- Recompute from the ledger after every accepted settlement. -/
def accountingFromLedger (ledger : List Bool) : AccountingState :=
  if ledger.isEmpty then .pending
  else
    let pricedCount := (ledger.filter id).length
    if pricedCount == 0 then .unavailable
    else if pricedCount == ledger.length then .complete
    else .«partial»

/-- A successful record insert or duplicate response: only a new response appends to the ledger.
`priced` is whether that response has a price table version. -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
def recordAccounting (a : RunAccounting) (priced : Bool) (isNew : Bool) : RunAccounting :=
  if isNew then
    let ledger := a.ledger ++ [priced]
    { ledger, state := accountingFromLedger ledger }
  else a

/-- A late price for the first, previously unpriced response updates that ledger row without
inserting another response or adding its token counters again. -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
def priceFirstResponse (a : RunAccounting) : RunAccounting :=
  if a.ledger.head? = some false then
    let ledger := a.ledger.set 0 true
    { ledger, state := accountingFromLedger ledger }
  else a

/-- Two different priced catalogue versions conflict; an unpriced arrival has no version
opinion and cannot conflict with an earlier priced response. -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs.ts#recordUsage")]
def priceVersionConflict (existing incoming : Option String) : Bool :=
  match existing, incoming with
  | some a, some b => a != b
  | _, _ => false

/-- The repository writes `failed` only while accounting is pending. -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs.ts#markAccountingFailed")]
def failAccounting (a : RunAccounting) : RunAccounting :=
  if a.state = .pending then { a with state := .failed } else a

/-- A run's lifecycle status and accounting are independent product components. -/
structure AccountedRun where
  lifecycle : RunState := {}
  accounting : RunAccounting := {}
  deriving DecidableEq, Repr, Inhabited

end AgentWorkspace.Lifecycle
