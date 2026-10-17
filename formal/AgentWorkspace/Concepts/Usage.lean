import AgentWorkspace.Prelude.Json
import AgentWorkspace.Prelude.Ids

/-!
# Usage: token counters, cost and the accounting state

The money-and-tokens half of a run, as three places know it:

* the run's aggregate (`runs.input_tokens` … `runs.cost_usd`, `runs.accounting_state`), which is
  the fast read model and what `RunResource.usage` / `.cost` / `.accountingState` render;
* the per-response ledger `run_usage_records`, "the authoritative reconciliation ledger"
  (`packages/core/src/db/schema/run-usage-records.ts`), one row per provider response so a
  retried usage frame is never charged twice;
* the wire (`RunUsageSchema`, `RunCostSchema`, `ACCOUNTING_STATES` in
  `packages/contracts/src/runs.ts`).

Money is kept as the decimal text PostgreSQL's `numeric(14, 6)` renders and the wire carries
(`RunCost.amount` is "a decimal string, never a float"), so the model never passes it through a
number. Only the two facts the checks read are modelled: whether the text is a non-negative
decimal and whether it is zero. Counters are natural numbers; a negative counter is a row the
`*_counters_non_negative` checks refuse, which `Er/Current/Work.lean` states at the row level.

The accounting state is **deliberately separate** from the run status (`runs.ts`, issue #134):
`ledgerAccounting` is how the repository recomputes it from the ledger after every settlement.
-/

namespace AgentWorkspace.Concepts.Usage

open AgentWorkspace

/-! ## Decimal text -/

/-- A non-empty run of ASCII digits. -/
def isDigits (cs : List Char) : Bool := !cs.isEmpty && cs.all Char.isDigit

/-- The part of `cs` before the first `.`, and the part after it (if there is a `.`). -/
def splitDot : List Char → List Char × Option (List Char)
  | [] => ([], none)
  | '.' :: rest => ([], some rest)
  | c :: rest => let (i, f) := splitDot rest; (c :: i, f)

/-- An unsigned decimal as PostgreSQL renders `numeric`: digits, optionally `.` and digits. -/
def isUnsignedDecimal (cs : List Char) : Bool :=
  match splitDot cs with
  | (i, none) => isDigits i
  | (i, some f) => isDigits i && isDigits f

/-- A decimal as PostgreSQL renders `numeric`: an optional `-`, then an unsigned decimal. -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#costUsd")]
def isDecimal (s : String) : Bool :=
  match s.toList with
  | '-' :: rest => isUnsignedDecimal rest
  | cs => isUnsignedDecimal cs

/-- The decimal is zero: every digit is `0` (so `0`, `0.000000` and `-0.0` are all zero). -/
def isZeroDecimal (s : String) : Bool :=
  isDecimal s && s.toList.all fun c => c == '0' || c == '.' || c == '-'

/-- The decimal is `≥ 0`: it carries no minus sign, or it is zero. -/
def isNonNegDecimal (s : String) : Bool :=
  isDecimal s && (s.toList.head? != some '-' || isZeroDecimal s)

/-- The amount a run or a ledger row carries before anything is priced (`'0.000000'`, the
default `InMemoryRunStore.create` writes and `renderRun` falls back to). -/
@[aw_spec (ts := "apps/web/server/runs/api.ts#renderRun")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
def zeroCost : String := "0.000000"

/-- The one settlement currency: "0.1.0 pricing is USD-only and says so explicitly". -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#costCurrency")]
def settlementCurrency : String := "USD"

/-! ## Counters -/

/-- The five usage counters a run and each ledger row carry (`RunUsageSchema` without the
derived total). -/
@[aw_spec (ts := "packages/contracts/src/runs.ts#RunUsageSchema")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")]
structure Counters where
  inputTokens : Nat
  outputTokens : Nat
  cacheReadInputTokens : Nat
  cacheCreationInputTokens : Nat
  toolCalls : Nat
  deriving DecidableEq, Repr, Inhabited

namespace Counters

/-- All counters zero: a new run (`runs.*_tokens … default(0)`). -/
def zero : Counters := ⟨0, 0, 0, 0, 0⟩

/-- Counter-wise sum: what a settlement adds to the run's aggregate. -/
def add (a b : Counters) : Counters :=
  ⟨a.inputTokens + b.inputTokens, a.outputTokens + b.outputTokens,
    a.cacheReadInputTokens + b.cacheReadInputTokens,
    a.cacheCreationInputTokens + b.cacheCreationInputTokens, a.toolCalls + b.toolCalls⟩

/-- `totalTokens`: "Derived by the server: the sum of the four counters above". -/
@[aw_spec (ts := "packages/contracts/src/runs.ts#RunUsageSchema")
  (ts := "apps/web/server/runs/api.ts#renderRun")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
def totalTokens (c : Counters) : Nat :=
  c.inputTokens + c.outputTokens + c.cacheReadInputTokens + c.cacheCreationInputTokens

/-- The sum of a list of counters. -/
def sum (cs : List Counters) : Counters := cs.foldl add zero

end Counters

/-! ## The accounting state -/

/-- `ACCOUNTING_STATES`: how far usage accounting for a run has progressed. -/
@[aw_spec (ts := "packages/contracts/src/runs.ts#ACCOUNTING_STATES")
  (ts := "packages/core/src/db/schema/runs.ts#accountingStates")
  (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")]
inductive AccountingState where
  | pending
  | complete
  | «partial»
  | failed
  | unavailable
  deriving DecidableEq, Repr, Inhabited

namespace AccountingState

/-- The wire spelling, as `ACCOUNTING_STATES` lists it. -/
def toWire : AccountingState → String
  | pending => "pending"
  | complete => "complete"
  | «partial» => "partial"
  | failed => "failed"
  | unavailable => "unavailable"

instance : WireEnum AccountingState where
  all := [pending, complete, «partial», failed, unavailable]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

/-- At least one ledger row is priced, so the run carries a price table version
(`accounting_state in ('complete', 'partial')`). -/
@[aw_spec (ts := "packages/core/src/db/schema/runs.ts#runs_price_version_matches_accounting_state")]
def isPriced : AccountingState → Bool
  | complete | «partial» => true
  | pending | failed | unavailable => false

/-- "Only `'complete'` is a settled answer." -/
@[aw_spec (doc := "docs/sdk/site/concepts/run-lifecycle.mdx#usage-cost-and-accounting")
  (ts := "packages/contracts/src/runs.ts#ACCOUNTING_STATES")]
def isSettled : AccountingState → Bool
  | complete => true
  | pending | «partial» | failed | unavailable => false

end AccountingState

/-! ## The wire protocol -/

/-- `wireProtocols`: which gateway dialect served the response a ledger row settles. Three values,
one usage extractor each, and the closed set is carried by this type as well as by the column's
check constraint. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-usage-records.ts#wireProtocols")
  (ts := "packages/gateway/src/types.ts#WireProtocol")
  (doc := "docs/adr/0068-openai-wire-protocols-are-passthrough-ingress.md#d5--metering-is-per-protocol-incremental-and-corrects-two-openai-conventions")]
inductive WireProtocol where
  | anthropicMessages
  | openaiResponses
  | openaiChatCompletions
  deriving DecidableEq, Repr, Inhabited

namespace WireProtocol

/-- The wire spelling, as `wireProtocols` lists it. -/
def toWire : WireProtocol → String
  | anthropicMessages => "anthropic-messages"
  | openaiResponses => "openai-responses"
  | openaiChatCompletions => "openai-chat-completions"

instance : WireEnum WireProtocol where
  all := [anthropicMessages, openaiResponses, openaiChatCompletions]
  toWire := toWire
  complete := by intro a; cases a <;> decide
  nodup := by decide
  toWire_injective := by intro a b; cases a <;> cases b <;> decide

/-- The column's default, which is what lets a gateway pod from the release before the column
existed keep inserting rows while `migrate` runs at container start. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-usage-records.ts#wireProtocol")]
def columnDefault : WireProtocol := anthropicMessages

/-- The dialect is relayed to an OpenAI-family upstream rather than translated (ADR-0068 D1). -/
def isRelayed : WireProtocol → Bool
  | anthropicMessages => false
  | openaiResponses | openaiChatCompletions => true

end WireProtocol

/-! ## The ledger -/

/-- One row of `run_usage_records`: one provider response's usage, keyed for idempotence by
`(run_id, provider_response_id)`. `priceTableVersion` is `none` when the response was captured
with no price catalogue entry for its model; the row is then recorded at zero cost. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")]
structure UsageRecord where
  id : RunUsageRecordId
  workspace : WorkspaceId
  run : RunId
  providerResponseId : String
  provider : String
  model : String
  counters : Counters
  wireProtocol : WireProtocol
  costUsd : String
  costCurrency : String
  priceTableVersion : Option String
  createdAt : Nat
  deriving DecidableEq, Repr, Inhabited

namespace UsageRecord

/-- The row is priced. -/
def isPriced (u : UsageRecord) : Bool := u.priceTableVersion.isSome

/-- The two checks of `run_usage_records`: a non-negative cost (the counters are natural numbers
already) and the settlement currency. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_counters_non_negative")
  (ts := "packages/core/src/db/schema/run-usage-records.ts#run_usage_records_currency_usd")]
def wellFormed (u : UsageRecord) : Bool :=
  isNonNegDecimal u.costUsd && u.costCurrency == settlementCurrency

/-- An unpriced response is "recorded, at `cost_usd = '0'`, rather than dropped": the
repository's invariant, which no database check enforces. -/
@[aw_spec (ts := "packages/core/src/db/schema/run-usage-records.ts#runUsageRecords")]
def unpricedIsZero (u : UsageRecord) : Bool := u.isPriced || isZeroDecimal u.costUsd

end UsageRecord

/-- The accounting state the repository recomputes from a run's ledger after a settlement: no
priced row is `unavailable`, every row priced is `complete`, otherwise `partial`. An empty
ledger has had no settlement, which is the column default `pending`. (`failed` is written by a
settlement that could not produce ledger data at all, so the ledger never derives it.) -/
@[aw_spec (ts := "packages/core/src/db/repositories/runs.ts#pricedCount")
  (ts := "packages/core/src/db/schema/runs.ts#accountingStates")]
def ledgerAccounting (records : List UsageRecord) : AccountingState :=
  if records.isEmpty then .pending
  else
    let priced := (records.filter UsageRecord.isPriced).length
    if priced == 0 then .unavailable
    else if priced == records.length then .complete
    else .«partial»

end AgentWorkspace.Concepts.Usage
