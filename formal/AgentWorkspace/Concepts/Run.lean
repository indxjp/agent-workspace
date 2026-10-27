import AgentWorkspace.Contracts.Runs
import AgentWorkspace.Concepts.Usage
import AgentWorkspace.Concepts.Session

/-!
# Run and run token

A **run** is "one execution of one agent inside a session" (`packages/core/src/db/schema/runs.ts`).
It belongs to exactly one workspace and exactly one session, and reaches its agent, its project,
its initiating user and its owning principal **through that session**: `runs` deliberately has no
`agent_id` ("a second copy … could disagree with `sessions.agent_id`"), and it has no
`owner_principal_id` either.

Two independent state components:

* `status` — the run lifecycle, reused from `Contracts.RunStatus` (`queued`, `running` live;
  `completed`, `failed`, `cancelled` terminal);
* `accountingState` — whether usage settlement is trustworthy (`Usage.AccountingState`). "A run's
  `status` reaching a terminal value and its `accountingState` reaching `'complete'` are two
  separate facts."

The six `runs` checks are the invariants below; `Er/Current/Work.lean` gives them at the row level
and `Theorems/WellFormed/ConceptWork.lean` proves the two readings agree. `stamp` is what the two
run stores write alongside a status change (`startedAt` on `running`; `endedAt`, and a `startedAt`
if there was none, on a terminal status), so that the status machine of `Lifecycle/Run.lean`
never produces a row the checks refuse.

A **run token** (`run_tokens`) is a gateway credential minted for one run; only its digest is kept.
-/

namespace AgentWorkspace.Concepts.Run

open AgentWorkspace AgentWorkspace.Contracts AgentWorkspace.Concepts.Usage
  AgentWorkspace.Concepts.Session

/-- `MODEL_PROVIDERS` (`modelProviders` in the schema): who served a run. -/
@[aw_spec (ts := "packages/contracts/src/runs.ts#MODEL_PROVIDERS")
  (ts := "packages/core/src/db/schema/model-connections.ts#modelProviders")]
inductive ModelProvider where
  | anthropic
  | anthropicCompatible
  | openai
  | azureOpenai
  | openaiCompatible
  deriving DecidableEq, Repr, Inhabited

namespace ModelProvider

/-- The wire spelling. -/
def toWire : ModelProvider → String
  | anthropic => "anthropic"
  | anthropicCompatible => "anthropic-compatible"
  | openai => "openai"
  | azureOpenai => "azure-openai"
  | openaiCompatible => "openai-compatible"

instance : WireEnum ModelProvider where
  all := [anthropic, anthropicCompatible, openai, azureOpenai, openaiCompatible]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

end ModelProvider

/-- One run, with the fields `runs` stores. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs")
  (ts := "packages/contracts/src/runs.ts#RunResourceSchema")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
structure Run where
  id : RunId
  workspace : WorkspaceId
  session : SessionId
  status : RunStatus
  model : Option String
  provider : Option ModelProvider
  modelConnection : Option ModelConnectionId
  startedAt : Option Nat
  endedAt : Option Nat
  counters : Counters
  costUsd : String
  costCurrency : String
  priceTableVersion : Option String
  error : Option String
  accountingState : AccountingState
  accountingError : Option String
  createdAt : Nat
  updatedAt : Nat
  /-- The canonical tool call a paused run waits on (ADR-0145); `none` unless one was stored. -/
  pendingApproval : Option String := none
  /-- When a paused run stops waiting for a decision (ADR-0145 D2.4); `none` unless it paused. -/
  approvalDeadlineAt : Option Nat := none
  deriving DecidableEq, Repr, Inhabited

namespace Run

/-- `runs_ended_at_iff_terminal`: "A finished run has an end time and an unfinished one does
not." (a schema comment; no document states it, finding F-9). A run paused at
`awaiting_approval` counts as finished here: nothing executes (ADR-0145 D1). -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs_ended_at_iff_terminal")]
def endedAtIffTerminal (r : Run) : Bool := r.status.isStopped == r.endedAt.isSome

/-- `runs_awaiting_approval_has_pending`: a paused run stores the call it waits on. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs_awaiting_approval_has_pending")]
def pendingWhenAwaiting (r : Run) : Bool :=
  r.status != .awaitingApproval || r.pendingApproval.isSome

/-- `runs_awaiting_approval_has_deadline`: a paused run stores when it stops waiting. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs_awaiting_approval_has_deadline")]
def deadlineWhenAwaiting (r : Run) : Bool :=
  r.status != .awaitingApproval || r.approvalDeadlineAt.isSome

/-- `runs_ended_after_started`. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs_ended_after_started")]
def endedAfterStarted (r : Run) : Bool :=
  match r.startedAt, r.endedAt with
  | some s, some e => s ≤ e
  | _, _ => true

/-- The cost part of `runs_counters_non_negative` (the counters are natural numbers). -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs_counters_non_negative")]
def costNonNegative (r : Run) : Bool := isNonNegDecimal r.costUsd

/-- `runs_cost_currency_usd`. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs_cost_currency_usd")]
def currencyUsd (r : Run) : Bool := r.costCurrency == settlementCurrency

/-- `runs_price_version_matches_accounting_state`: a price table version exactly when some usage
is priced. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs_price_version_matches_accounting_state")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
def priceVersionMatches (r : Run) : Bool :=
  r.accountingState.isPriced == r.priceTableVersion.isSome

/-- `runs_unpriced_cost_zero`: a run with no priced usage costs exactly zero. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs_unpriced_cost_zero")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
def unpricedCostZero (r : Run) : Bool := r.accountingState.isPriced || isZeroDecimal r.costUsd

/-- Every check of `runs`. -/
def wellFormed (r : Run) : Bool :=
  r.endedAtIffTerminal && r.endedAfterStarted && r.costNonNegative && r.currencyUsd &&
    r.priceVersionMatches && r.unpricedCostZero && r.pendingWhenAwaiting && r.deadlineWhenAwaiting

/-- `durationMs`: "`null` until both `startedAt` and `endedAt` exist", and never stored. -/
@[aw_spec (ts := "packages/contracts/src/runs.ts#RunResourceSchema")
  (ts := "apps/web/server/runs/api.ts#renderRun")
  (doc := "docs/sdk/site/resources/runs.mdx#the-run-record")]
def durationMs (r : Run) : Option Nat :=
  match r.startedAt, r.endedAt with
  | some s, some e => some (e - s)
  | _, _ => none

/-- A new run as both stores create it: `queued`, no timestamps but `createdAt`, zero usage,
zero cost in USD, no price, accounting `pending`. -/
@[aw_spec (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")
  (ts := "packages/core/src/db/schema/runs.ts#runs")]
def create (id : RunId) (workspace : WorkspaceId) (session : SessionId) (now : Nat) : Run :=
  { id, workspace, session, status := .queued, model := none, provider := none,
    modelConnection := none, startedAt := none, endedAt := none, counters := Counters.zero,
    costUsd := zeroCost, costCurrency := settlementCurrency, priceTableVersion := none,
    error := none, accountingState := .pending, accountingError := none, createdAt := now,
    updatedAt := now }

/-- What a store writes with a status change at instant `now`: `running` stamps `startedAt`; a
terminal status stamps `endedAt`, and a `startedAt` if the run never had one ("a run that is
finished without ever having been marked running still gets a start"). -/
@[aw_spec (ts := "apps/web/server/runs/store.ts#RunStore")
  (ts := "apps/web/server/runs/memory-store.ts#InMemoryRunStore")
  (ts := "packages/core/src/db/repositories/runs.ts#finish")
  (ts := "packages/core/src/db/repositories/runs.ts#markRunning")]
def stamp (r : Run) (next : RunStatus) (now : Nat) : Run :=
  if next.isTerminal then
    { r with status := next, startedAt := some (r.startedAt.getD now), endedAt := some now }
  else if next = .running then { r with status := next, startedAt := some now }
  else { r with status := next }

/-- The latest instant the run records: a store's clock never runs behind it. -/
def lastStamp (r : Run) : Nat := max r.createdAt (max (r.startedAt.getD 0) (r.endedAt.getD 0))

/-- The run's agent, reached through its session (`runs` has no `agent_id`). -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
def agentVia (r : Run) (s : Session) : Option AgentId :=
  if s.id = r.session ∧ s.workspace = r.workspace then some s.agent else none

/-- The run's owning principal, reached through its session (`runs` has no
`owner_principal_id`; `RunRecord.ownerPrincipalId` is "the exact workspace principal that owns
the session"). -/
@[aw_spec (ts := "apps/web/server/runs/store.ts#ownerPrincipalId")
  (doc := "docs/sdk/04-api-specification.md#2-resource-model")]
def ownerVia (r : Run) (s : Session) : Option PrincipalId :=
  if s.id = r.session ∧ s.workspace = r.workspace then some s.ownerPrincipal else none

end Run

/-- A gateway token minted for one run (`run_tokens`): only a digest is retained. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-tokens.ts#runTokens")]
structure RunToken where
  id : RunTokenId
  run : RunId
  workspace : WorkspaceId
  tokenHash : String
  expiresAt : Nat
  revokedAt : Option Nat
  createdAt : Nat
  deriving DecidableEq, Repr, Inhabited

namespace RunToken

/-- `run_tokens_expiry_after_created`. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-tokens.ts#run_tokens_expiry_after_created")]
def expiryAfterCreated (t : RunToken) : Bool := t.createdAt < t.expiresAt

/-- `run_tokens_revoked_after_created`. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-tokens.ts#run_tokens_revoked_after_created")]
def revokedAfterCreated (t : RunToken) : Bool := t.revokedAt.all (t.createdAt ≤ ·)

/-- Both checks. -/
def wellFormed (t : RunToken) : Bool := t.expiryAfterCreated && t.revokedAfterCreated

end RunToken

end AgentWorkspace.Concepts.Run
