# ADR-W9-RUNS-134 — `accounting_state` is a recomputed ledger aggregate, not a caller-supplied value

Status: accepted
Date: 2026-09-12
Decided by: W9-RUNS-134 (implementing agent)
Scope: `packages/core/src/db/schema/runs.ts`, `packages/core/src/db/schema/run-usage-records.ts`,
`packages/core/src/db/repositories/runs.ts`

## Context

Issue #134 asks for a closed set `pending | complete | partial | failed | unavailable` on `runs`,
but neither the issue nor the wave plan's card specifies:

- **How `partial` and `unavailable` are told apart**, or what decides between them when a run has
  more than one `run_usage_records` row.
- **Whether a late-priced retry of an already-captured, unpriced response inserts a second ledger
  row or updates the first.** The card's own words — "a late arrival updates counters, cost and
  state" — rule out a second row (that would double-count tokens the ledger already has), but the
  existing `run_usage_records` schema had `price_table_version text NOT NULL`, which makes an
  unpriced row impossible to insert at all.
- **Whether a settlement failure that produces no ledger row (no measurable usage, no
  identifiable model) should ever regress a run that already has real settled usage.**

`priceFor` in `packages/gateway/src/pricing.ts` fails closed by throwing
(`pricing.test.ts`'s `refusing zero-cost` assertion), and that behaviour is kept unchanged for
every other caller — this task does not touch `pricing.ts`'s public contract.

## Decision

1. `run_usage_records.price_table_version` becomes nullable. A response captured with no
   catalogue price is still inserted, at `cost_usd = '0'` and `price_table_version = NULL`,
   instead of being dropped. `packages/gateway/src/index.ts`'s `createDatabaseUsageRecorder`
   catches `priceFor`'s throw locally and passes `null` through — `priceFor` itself is unchanged.

2. `RunRepository.recordUsage` keys a ledger write by `(runId, providerResponseId)`, the existing
   unique constraint, with three outcomes decided by what is already on that key:
   - **No existing row** → insert; token counts are added to `runs`.
   - **Existing row, already priced, or this attempt unpriced** → `duplicate`; nothing changes.
     (An unpriced retry of an already-priced or already-unpriced row contributes nothing new.)
   - **Existing row unpriced, this attempt priced** → the *same* row is updated in place
     (`price_table_version`, `cost_usd`), and only the **cost delta** — never the token counts,
     which were already added on first insert — is applied to `runs`.

3. `runs.accounting_state` is recomputed on every successful `recordUsage` call from a full scan
   of that run's `run_usage_records`: `unavailable` when zero rows are priced, `complete` when
   every row is priced, `partial` when the ledger is mixed. This is why `accounting_state` is
   never passed in by a caller — it cannot disagree with the ledger it is computed from, the same
   reasoning the schema file already gives for not storing `agent_id` a second time on `runs`.

4. `RunRepository.markAccountingFailed(runId, reason)` is a **new** method for the one case the
   ledger cannot represent — no usage data at all — and it writes `'failed'` only when the run's
   current state is still `'pending'`. A run that already has `complete` / `partial` /
   `unavailable` from real settled usage is never regressed by one later, separate,
   unmeasurable response; a later real settlement (`recordUsage` succeeding) always supersedes an
   earlier `'failed'` mark, because it recomputes the state unconditionally.

## Alternatives considered

- **A second `run_usage_records` row per late-priced attempt**, dedup on insert only
  (`onConflictDoNothing`, unchanged from before this task). Rejected: it either double-counts
  tokens (if the second row is truly separate) or requires deleting the first row (which breaks
  "immutable ledger" for every audit/debugging use of the table). Updating the existing row in
  place is the only shape that satisfies "a late arrival updates counters, cost and state"
  without inventing a second, disagreeing fact about the same provider response.
- **`accounting_state` as an input field on `RecordRunUsageInput`**, set by the caller
  (`packages/gateway`). Rejected for the same reason `agent_id` is not a column on `runs`: a
  caller-supplied state can disagree with what the ledger actually holds, and the whole point of
  issue #134 is that the state must be trustworthy.
- **`markAccountingFailed` unconditionally overwrites.** Rejected: a run with genuinely settled
  usage (`complete`/`partial`/`unavailable`) regressing to `'failed'` because of one later,
  unrelated parse failure is a worse false signal than leaving the mark out — it would say
  "nothing about this run's accounting is known" about a run that has real numbers.

## Consequences

- `run_usage_records` rows are no longer fully immutable: the one field that can change after
  insert is `price_table_version`/`cost_usd`, and only along the unpriced → priced direction.
  Every other column, and every priced row, stays write-once. A future reader of this table who
  assumes total immutability should read this ADR before relying on that for anything security- or
  audit-relevant.
- `accounting_state` cannot be set to `'failed'` from outside `RunRepository`; a caller with only
  `GatewayUsageRecord` data (a real settlement) has no way to force `'failed'` — which is correct,
  since `recordUsage` always carries more information than `markAccountingFailed` could.
- Reversing point 4 (letting a later failure regress a settled run) would need a design for which
  failure "counts" — this task deliberately does not build that; the `pending`-only guard is the
  simplest rule that has no failure mode worse than doing nothing.
