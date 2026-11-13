import crypto from 'node:crypto';

import { expect, it } from 'vitest';

import { runUsageRecords } from '../schema/run-usage-records.js';
import { runs } from '../schema/runs.js';
import { workspaces } from '../schema/workspaces.js';
import { seedTenant, type RunUsageFixture } from './run-usage.fixture.test-support.js';
import { listRunsNeedingAccountingReconciliation, listStaleRunIds } from './runs.js';

interface LedgerRow {
  readonly workspace: string;
  readonly run: string;
  readonly responseId: string;
  readonly costUsd: string;
  readonly createdAt: string;
}

const row = ({ workspace, run, responseId, costUsd, createdAt }: LedgerRow) => ({
  workspaceId: workspace,
  runId: run,
  providerResponseId: responseId,
  provider: 'anthropic',
  model: 'claude-fixture',
  inputTokens: 1,
  outputTokens: 1,
  costUsd,
  createdAt: new Date(createdAt),
});

/** A second workspace, owned by the fixture's user, with one still-`pending` run. */
async function seedOtherWorkspace(fixture: RunUsageFixture) {
  const { db } = fixture.isolated;
  const otherWorkspaceId = crypto.randomUUID();
  const otherSessionId = crypto.randomUUID();
  const otherRunId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' });
  await seedTenant(db, {
    workspaceId: otherWorkspaceId,
    userId: fixture.userId,
    membershipId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    agentName: 'Other agent',
    sessionId: otherSessionId,
  });
  await db
    .insert(runs)
    .values({ id: otherRunId, workspaceId: otherWorkspaceId, sessionId: otherSessionId });
  return { otherWorkspaceId, otherRunId };
}

/**
 * Two runs of this test's own, so their accounting state does not depend on the other tests:
 * one settled (`complete`, so priced) and one whose response had no price (`unavailable`), with
 * ledger rows in a window in 2001 that no other test in this file writes to.
 */
async function seedLedgerWindow(
  fixture: RunUsageFixture,
  other: { otherWorkspaceId: string; otherRunId: string },
) {
  const { db } = fixture.isolated;
  const { workspaceId, sessionId } = fixture;
  const pricedRunId = crypto.randomUUID();
  const unavailableRunId = crypto.randomUUID();
  await db.insert(runs).values({
    id: pricedRunId,
    workspaceId,
    sessionId,
    accountingState: 'complete',
    priceTableVersion: 'test-prices',
  });
  await db
    .insert(runs)
    .values({ id: unavailableRunId, workspaceId, sessionId, accountingState: 'unavailable' });
  const priced = { workspace: workspaceId, run: pricedRunId };
  await db.insert(runUsageRecords).values([
    row({
      ...priced,
      responseId: 'day-before',
      costUsd: '9',
      createdAt: '2001-01-01T23:59:59.999Z',
    }),
    row({
      ...priced,
      responseId: 'day-start',
      costUsd: '1.5',
      createdAt: '2001-01-02T00:00:00.000Z',
    }),
    row({
      ...priced,
      responseId: 'day-late',
      costUsd: '2.25',
      createdAt: '2001-01-02T23:59:59.999Z',
    }),
    row({
      workspace: workspaceId,
      run: unavailableRunId,
      responseId: 'day-after',
      costUsd: '0',
      createdAt: '2001-01-03T00:00:00.000Z',
    }),
    row({
      workspace: other.otherWorkspaceId,
      run: other.otherRunId,
      responseId: 'other-day',
      costUsd: '40',
      createdAt: '2001-01-02T12:00:00.000Z',
    }),
  ]);
}

async function sumsLedgerCostOverWindow(fixture: RunUsageFixture) {
  const { workspaceId, repositoryFor } = fixture;
  const other = await seedOtherWorkspace(fixture);
  await seedLedgerWindow(fixture, other);
  const repository = await repositoryFor(workspaceId);
  const otherRepository = await repositoryFor(other.otherWorkspaceId);
  const window = (day: string) =>
    [
      new Date(`2001-01-${day}T00:00:00Z`),
      new Date(`2001-01-0${Number(day) + 1}T00:00:00Z`),
    ] as const;

  // The settled run's day: the rows before and after it are outside the half-open window.
  await expect(repository.usageCostUsd(...window('02'))).resolves.toEqual({
    costUsd: '3.750000',
    unpricedUsage: false,
  });
  // The next day holds only the unpriced run's row: cost 0, and flagged as not measurable.
  await expect(repository.usageCostUsd(...window('03'))).resolves.toEqual({
    costUsd: '0.000000',
    unpricedUsage: true,
  });
  // The other workspace's run is still `pending` (not complete), and never leaks into ours.
  await expect(otherRepository.usageCostUsd(...window('02'))).resolves.toEqual({
    costUsd: '40.000000',
    unpricedUsage: true,
  });
  await expect(
    repository.usageCostUsd(new Date('2001-02-01T00:00:00Z'), new Date('2001-02-02T00:00:00Z')),
  ).resolves.toEqual({ costUsd: '0', unpricedUsage: false });
}

async function listsRunsNeedingReconciliation(fixture: RunUsageFixture) {
  const { workspaceId, runId, staysPendingRunId } = fixture;
  const { db } = fixture.isolated;
  const future = new Date(Date.now() + 60_000);
  const candidates = await listRunsNeedingAccountingReconciliation(db, future, 1_000);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  // Never settled by any other test in this file — must be surfaced as needing reconciliation.
  expect(byId.get(staysPendingRunId)).toMatchObject({
    workspaceId,
    accountingState: 'pending',
    accountingError: null,
  });
  // Reached `complete` in the tests above — must not appear; a query that widens past
  // `accounting_state <> 'complete'` would send an operator chasing runs that are already fine.
  expect(byId.has(runId)).toBe(false);

  // A threshold in the past excludes every run in this fixture (all created "now").
  const none = await listRunsNeedingAccountingReconciliation(
    db,
    new Date(Date.now() - 60_000),
    1_000,
  );
  expect(none.some((candidate) => candidate.id === staysPendingRunId)).toBe(false);
}

async function listsStaleRuns(fixture: RunUsageFixture) {
  const { workspaceId, sessionId } = fixture;
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  const orphanedRunning = crypto.randomUUID();
  const orphanedQueued = crypto.randomUUID();
  const live = crypto.randomUUID();
  const finished = crypto.randomUUID();
  await fixture.isolated.db.insert(runs).values([
    { id: orphanedRunning, workspaceId, sessionId, status: 'running', startedAt: hoursAgo(2) },
    { id: orphanedQueued, workspaceId, sessionId, createdAt: hoursAgo(2) },
    // Created long ago but started recently: alive by its start, not its creation.
    {
      id: live,
      workspaceId,
      sessionId,
      status: 'running',
      createdAt: hoursAgo(2),
      startedAt: new Date(),
    },
    {
      id: finished,
      workspaceId,
      sessionId,
      status: 'completed',
      createdAt: hoursAgo(2),
      startedAt: hoursAgo(2),
      endedAt: hoursAgo(2),
    },
  ]);
  const stale = await listStaleRunIds(fixture.isolated.db, hoursAgo(1), 1_000);
  expect(stale).toContain(orphanedRunning);
  expect(stale).toContain(orphanedQueued);
  expect(stale).not.toContain(live);
  expect(stale).not.toContain(finished);
}

export function registerReportingCases(fixture: RunUsageFixture) {
  it("sums the workspace's ledger cost over a half-open window, and says whether any run in it is unpriced", () =>
    sumsLedgerCostOverWindow(fixture));

  it('lists non-complete runs older than a threshold for operator reconciliation', () =>
    listsRunsNeedingReconciliation(fixture));

  it('lists runs left running or queued since before a cutoff for the stale-run sweep', () =>
    listsStaleRuns(fixture));
}
