/**
 * The JSON a run is served as: {@link renderRun} for every list and detail item (issue #135's
 * "list and detail cannot drift"), and {@link renderRunDetail} for `GET /api/runs/:id`. `api.ts`
 * re-exports both, so `runs/api` stays the one public import path.
 */
import { RUN_CHILDREN_MAX } from '@indx-workspace/contracts/runs';

import { maskStrings, runDirectoryMask } from './host-paths';
import { treeCostOf } from './tree-cost';
import type { RunRecord, RunStore } from './store';

/** A run's cost as `cost` renders it, and as `treeCost` sums it. */
function costOf(run: RunRecord): { readonly amount: string; readonly currency: string } {
  return { amount: run.costUsd ?? '0.000000', currency: run.costCurrency ?? 'USD' };
}

function isoOrNull(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

/**
 * Derived, never stored (issue #135): a run with either timestamp missing has no duration yet,
 * which is a fact about the run and not a zero.
 */
function durationMsOf(run: RunRecord): number | null {
  return run.startedAt === null || run.endedAt === null
    ? null
    : run.endedAt.getTime() - run.startedAt.getTime();
}

function usageOf(run: RunRecord): Record<string, number> {
  const inputTokens = run.inputTokens ?? 0;
  const outputTokens = run.outputTokens ?? 0;
  const cacheReadInputTokens = run.cacheReadInputTokens ?? 0;
  const cacheCreationInputTokens = run.cacheCreationInputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    // Derived, never stored: the sum of every persisted counter above.
    totalTokens: inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    toolCalls: run.toolCalls ?? 0,
  };
}

/**
 * UX-02 (#2086): the error and the call awaiting approval are shown as they are, so the run's
 * directory on the runtime host is masked in them as in its events. `output` is the run's result
 * for its caller and is served unchanged.
 *
 * ADR-0145: the call being waited on is rendered only while the run is paused;
 * `approvedToolCalls` is a continuation's private input and is never rendered.
 */
function maskedErrorAndApproval(run: RunRecord): {
  readonly error: RunRecord['error'];
  readonly pendingApproval: unknown;
} {
  const mask = runDirectoryMask(run.workspaceId, run.sessionId);
  const pendingApproval = run.status === 'awaiting_approval' ? (run.pendingApproval ?? null) : null;
  if (mask === null) return { error: run.error, pendingApproval };
  return {
    error: run.error === null ? run.error : mask(run.error),
    pendingApproval:
      pendingApproval === null ? pendingApproval : maskStrings(pendingApproval, mask),
  };
}

/** The JSON shape a run is rendered as. Dates are ISO 8601 strings; `bigint` never appears. */
export function renderRun(run: RunRecord): Record<string, unknown> {
  const masked = maskedErrorAndApproval(run);
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    agentId: run.agentId,
    projectId: run.projectId ?? null,
    initiatingUserId: run.initiatingUserId ?? null,
    sessionId: run.sessionId,
    // #612, ADR-0101: the version the session pins; `null` for a legacy unversioned session.
    agentVersion: run.agentVersion ?? null,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    startedAt: isoOrNull(run.startedAt),
    endedAt: isoOrNull(run.endedAt),
    durationMs: durationMsOf(run),
    model: run.model ?? null,
    provider: run.provider ?? null,
    modelConnectionId: run.modelConnectionId ?? null,
    // ADR-0065. `null` is reachable and meaningful: a run recorded before migration 0024 never
    // stored an engine, and saying `claude-agent-sdk` for it would be a guess dressed as a record.
    engine: run.engine ?? null,
    engineVersion: run.engineVersion ?? null,
    usage: usageOf(run),
    cost: { ...costOf(run), priceTableVersion: run.priceTableVersion ?? null },
    // ADR-0162: fixed at start; `null` for a run with no ceiling and every run before it.
    spendCeilingUsd: run.spendCeilingUsd ?? null,
    error: masked.error,
    // ADR-0143: `null` until the run is `completed`, and for a failed or cancelled one.
    output: run.output ?? null,
    pendingApproval: masked.pendingApproval,
    // Issue #134's ledger-recomputed aggregate. The fallback matches the column's own default;
    // both `RunStore` implementations always set it, and the field is optional on `RunRecord`
    // only because most of this interface's fields are (see that type's own comment).
    accountingState: run.accountingState ?? 'pending',
    accountingError:
      run.accountingError === undefined || run.accountingError === null
        ? null
        : 'Usage accounting could not be completed.',
    // ADR-0104 acceptance: the lead run a team's member call started this one from; `null` for a
    // root run, which is every run until U4.2c starts child runs.
    parentRunId: run.parentRunId ?? null,
  };
}

/**
 * `GET /api/runs/:id`'s body (ADR-0104 acceptance decision 7, spec 04 §5.12 "Run trees"): the run,
 * its children oldest first (one `where parent_run_id = $1` read, at most `RUN_CHILDREN_MAX`), and
 * `treeCost`, their exact decimal sum with the run's own cost. Lists render {@link renderRun} only.
 */
export async function renderRunDetail(
  store: RunStore,
  run: RunRecord,
): Promise<Record<string, unknown>> {
  const children = await store.listChildren(run.workspaceId, run.id, RUN_CHILDREN_MAX);
  return {
    ...renderRun(run),
    children: children.map(renderRun),
    treeCost: treeCostOf(
      { cost: costOf(run) },
      children.map((child) => ({ cost: costOf(child) })),
    ),
  };
}
