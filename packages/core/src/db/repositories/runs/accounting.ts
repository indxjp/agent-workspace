import { eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../client.js';
import type { RecordRunUsageInput } from './types.js';
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

import { auditEvents } from '../../schema/audit-events.js';

import { modelProviders } from '../../schema/model-connections.js';

import { runUsageRecords, wireProtocols } from '../../schema/run-usage-records.js';

import { runs, type AccountingState } from '../../schema/runs.js';
import { shareRunCharges } from '../../schema/share-run-charges.js';
import { shares } from '../../schema/shares.js';

import type { RunContext } from './context.js';
import { every } from './rows.js';
import type { RecordRunUsageOutcome, RunRepository, RunTransitionOutcome } from './types.js';

export function createRunAccounting({
  db,
  checked,
  tenant,
  read,
}: RunContext): Pick<RunRepository, 'recordUsage' | 'markAccountingFailed'> {
  return {
    async recordUsage(runId, input): Promise<RecordRunUsageOutcome> {
      validateUsage(input);
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`);
        const current = await tx
          .select({ id: runs.id, priceTableVersion: runs.priceTableVersion })
          .from(runs)
          .where(every(tenant, eq(runs.id, runId)))
          .limit(1);
        const existingRun = current[0];
        if (existingRun === undefined) return { kind: 'not-found' } as const;
        // Two catalogue versions may only disagree when both settlements actually priced
        // something. An unpriced attempt (this one, or the one already on the row) carries no
        // catalogue opinion, so it can never conflict with a real one.
        if (
          input.priceTableVersion !== null &&
          existingRun.priceTableVersion !== null &&
          existingRun.priceTableVersion !== input.priceTableVersion
        ) {
          return {
            kind: 'price-version-conflict',
            existingVersion: existingRun.priceTableVersion,
          } as const;
        }

        // Same lock covers this read: a concurrent retry of the identical response id cannot
        // observe a state between the two statements below.
        const ledger = await settleUsageLedger(tx, checked.workspaceId, runId, input);
        if (ledger.kind === 'duplicate') return ledger;
        const { addTokens, costDelta } = ledger;
        const ledgerRows = await tx
          .select({ priceTableVersion: runUsageRecords.priceTableVersion })
          .from(runUsageRecords)
          .where(
            every(
              eq(runUsageRecords.workspaceId, checked.workspaceId),
              eq(runUsageRecords.runId, runId),
            ),
          );
        const pricedCount = ledgerRows.filter((row) => row.priceTableVersion !== null).length;
        const accountingState: AccountingState =
          pricedCount === 0
            ? 'unavailable'
            : pricedCount === ledgerRows.length
              ? 'complete'
              : 'partial';

        await tx
          .update(runs)
          .set({
            provider: input.provider,
            model: input.model,
            ...(addTokens
              ? {
                  inputTokens: sql`${runs.inputTokens} + ${input.inputTokens}`,
                  outputTokens: sql`${runs.outputTokens} + ${input.outputTokens}`,
                  cacheReadInputTokens: sql`${runs.cacheReadInputTokens} + ${input.cacheReadInputTokens}`,
                  cacheCreationInputTokens: sql`${runs.cacheCreationInputTokens} + ${input.cacheCreationInputTokens}`,
                  toolCalls: sql`${runs.toolCalls} + ${input.toolCalls}`,
                }
              : {}),
            costUsd: sql`${runs.costUsd} + ${costDelta}`,
            costCurrency: input.costCurrency,
            // A priced attempt sets the run's catalogue version; an unpriced one leaves
            // whatever was already there rather than blanking out a prior priced value.
            priceTableVersion: input.priceTableVersion ?? sql`${runs.priceTableVersion}`,
            accountingState,
            accountingError: null,
          })
          .where(every(tenant, eq(runs.id, runId)));

        // A public run is linked before it is launched. Advancing its charge beside the run
        // aggregate makes the provider-response ledger the single accounting source: a
        // duplicate response returns above, while a late priced response contributes only
        // its delta. Different responses for this run share the advisory lock.
        await settlePublicCharge(tx, checked.workspaceId, runId, costDelta);
        return { kind: 'recorded' } as const;
      });
      if (outcome.kind === 'not-found' || outcome.kind === 'price-version-conflict') {
        return outcome;
      }
      const run = await read(runId);
      if (run === null) throw new Error(`run ${runId} vanished after usage settlement`);
      return { kind: outcome.kind, run };
    },
    async markAccountingFailed(runId, reason): Promise<RunTransitionOutcome> {
      const moved = await db
        .update(runs)
        // Only from `pending`: a run with any settled usage already (`complete` / `partial` /
        // `unavailable`) is not regressed by one later, separately unmeasurable response.
        .set({ accountingState: 'failed', accountingError: reason })
        .where(every(tenant, eq(runs.id, runId), eq(runs.accountingState, 'pending')))
        .returning({ id: runs.id });
      if (moved.length > 0) {
        const run = await read(runId);
        if (run === null) throw new Error(`run ${runId} vanished between update and read`);
        return { kind: 'moved', run };
      }
      const existing = await read(runId);
      return existing === null ? { kind: 'not-found' } : { kind: 'no-op' };
    },
  };
}

function validateUsage(input: RecordRunUsageInput): void {
  const counters = [
    input.inputTokens,
    input.outputTokens,
    input.cacheReadInputTokens,
    input.cacheCreationInputTokens,
    input.toolCalls,
  ];
  if (counters.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('run usage counters must be non-negative safe integers');
  }
  if (!/^\d{1,8}\.\d{6}$/u.test(input.costUsd)) {
    throw new Error('run usage costUsd must be a non-negative decimal with six places');
  }
  if (
    input.providerResponseId.length === 0 ||
    !(modelProviders as readonly string[]).includes(input.provider) ||
    !(wireProtocols as readonly string[]).includes(input.wireProtocol) ||
    input.model.length === 0 ||
    (input.priceTableVersion !== null && input.priceTableVersion.length === 0)
  ) {
    throw new Error(
      'run usage identity, provider, wire protocol and model are required, and a price version must not be empty when present',
    );
  }
}

async function settlePublicCharge(
  tx: Transaction,
  workspaceId: string,
  runId: string,
  costDelta: SQL,
): Promise<void> {
  const linkedCharges = await tx
    .update(shareRunCharges)
    .set({ chargedUsd: sql`${shareRunCharges.chargedUsd} + ${costDelta}` })
    .where(every(eq(shareRunCharges.workspaceId, workspaceId), eq(shareRunCharges.runId, runId)))
    .returning({ shareId: shareRunCharges.shareId });
  const linkedCharge = linkedCharges[0];
  if (linkedCharge !== undefined) {
    await tx
      .update(shares)
      .set({ spentUsd: sql`${shares.spentUsd} + ${costDelta}` })
      .where(every(eq(shares.workspaceId, workspaceId), eq(shares.id, linkedCharge.shareId)));
    // The spend update locks the share row. Exactly one concurrent settlement can
    // move `stopped` from false to true and therefore exactly one audit row is written.
    const stopped = await tx
      .update(shares)
      .set({ stopped: true })
      .where(
        every(
          eq(shares.workspaceId, workspaceId),
          eq(shares.id, linkedCharge.shareId),
          eq(shares.stopped, false),
          sql`${shares.budgetCapUsd} is not null`,
          sql`${shares.spentUsd} >= ${shares.budgetCapUsd}`,
        ),
      )
      .returning({ id: shares.id, subjectLabel: shares.subjectLabel });
    const stoppedShare = stopped[0];
    if (stoppedShare !== undefined) {
      await tx.insert(auditEvents).values({
        workspaceId: workspaceId,
        actorUserId: null,
        actorLabel: 'Budget guard',
        action: 'runnable-link-stopped',
        subjectId: stoppedShare.id,
        subjectLabel: stoppedShare.subjectLabel,
      });
    }
  }
}

async function settleUsageLedger(
  tx: Transaction,
  workspaceId: string,
  runId: string,
  input: RecordRunUsageInput,
) {
  const existingLedgerRows = await tx
    .select({
      id: runUsageRecords.id,
      priceTableVersion: runUsageRecords.priceTableVersion,
      costUsd: runUsageRecords.costUsd,
    })
    .from(runUsageRecords)
    .where(
      every(
        eq(runUsageRecords.runId, runId),
        eq(runUsageRecords.providerResponseId, input.providerResponseId),
      ),
    )
    .limit(1);
  const existingLedgerRow = existingLedgerRows[0];

  // Token counts are added only for a response this ledger has never seen. A "late
  // arrival" — the same response id, now priced, that first landed unpriced — updates
  // the existing row's price and cost in place rather than adding a second copy of
  // tokens that were already counted.
  let addTokens = false;
  let costDelta: SQL;
  if (existingLedgerRow === undefined) {
    await tx.insert(runUsageRecords).values({
      workspaceId: workspaceId,
      runId,
      providerResponseId: input.providerResponseId,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadInputTokens: input.cacheReadInputTokens,
      cacheCreationInputTokens: input.cacheCreationInputTokens,
      toolCalls: input.toolCalls,
      wireProtocol: input.wireProtocol,
      costUsd: input.costUsd,
      costCurrency: input.costCurrency,
      priceTableVersion: input.priceTableVersion,
    });
    addTokens = true;
    costDelta = sql`${input.costUsd}::numeric`;
  } else if (existingLedgerRow.priceTableVersion !== null || input.priceTableVersion === null) {
    // Already priced (a genuine retry — nothing new to contribute), or this attempt has
    // no price to offer an already-unpriced row. Either way, a no-op duplicate.
    return { kind: 'duplicate' } as const;
  } else {
    await tx
      .update(runUsageRecords)
      .set({ priceTableVersion: input.priceTableVersion, costUsd: input.costUsd })
      .where(eq(runUsageRecords.id, existingLedgerRow.id));
    costDelta = sql`(${input.costUsd}::numeric - ${existingLedgerRow.costUsd}::numeric)`;
  }

  return { kind: 'settled', addTokens, costDelta } as const;
}
