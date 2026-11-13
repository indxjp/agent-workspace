import crypto from 'node:crypto';

import { expect, it } from 'vitest';

import { runs } from '../schema/runs.js';
import { usage, type RunUsageFixture } from './run-usage.fixture.test-support.js';

async function settlesOnceUnderRetries(fixture: RunUsageFixture) {
  const { workspaceId, runId, repositoryFor } = fixture;
  const repository = await repositoryFor(workspaceId);
  const [first, second] = await Promise.all([
    repository.recordUsage(runId, usage('msg_same')),
    repository.recordUsage(runId, usage('msg_same')),
  ]);
  expect([first.kind, second.kind].sort()).toEqual(['duplicate', 'recorded']);
  const run = await repository.get(runId);
  expect(run).toMatchObject({
    provider: 'anthropic',
    model: 'claude-fixture',
    inputTokens: 10,
    outputTokens: 4,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 2,
    toolCalls: 1,
    costUsd: '0.000123',
    costCurrency: 'USD',
    priceTableVersion: 'prices-v1',
    accountingState: 'complete',
    accountingError: null,
  });
}

async function rejectsLegacyAccountingState(fixture: RunUsageFixture) {
  const { workspaceId, sessionId } = fixture;
  await expect(
    fixture.isolated.db.insert(runs).values({
      id: crypto.randomUUID(),
      workspaceId,
      sessionId,
      accountingState: 'unavailable',
      costUsd: '0.010000',
      priceTableVersion: 'prices-v1',
    }),
  ).rejects.toThrow();
}

async function accumulatesDistinctResponses(fixture: RunUsageFixture) {
  const { workspaceId, runId, repositoryFor } = fixture;
  const repository = await repositoryFor(workspaceId);
  await expect(repository.recordUsage(runId, usage('msg_second'))).resolves.toMatchObject({
    kind: 'recorded',
  });
  await expect(
    repository.recordUsage(runId, {
      ...usage('msg_new_prices'),
      priceTableVersion: 'prices-v2',
    }),
  ).resolves.toEqual({ kind: 'price-version-conflict', existingVersion: 'prices-v1' });
  await expect(repository.get(runId)).resolves.toMatchObject({
    inputTokens: 20,
    outputTokens: 8,
    toolCalls: 2,
    costUsd: '0.000246',
    accountingState: 'complete',
  });
}

async function reconcilesUnpricedUsage(fixture: RunUsageFixture) {
  const { workspaceId, unpricedRunId, repositoryFor } = fixture;
  const repository = await repositoryFor(workspaceId);

  const unpriced = {
    ...usage('msg_unpriced'),
    inputTokens: 7,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    toolCalls: 0,
    costUsd: '0.000000',
    priceTableVersion: null,
  };
  await expect(repository.recordUsage(unpricedRunId, unpriced)).resolves.toMatchObject({
    kind: 'recorded',
  });
  await expect(repository.get(unpricedRunId)).resolves.toMatchObject({
    inputTokens: 7,
    outputTokens: 5,
    costUsd: '0.000000',
    priceTableVersion: null,
    accountingState: 'unavailable',
    accountingError: null,
  });

  // A price becomes available and the same response is resettled — this is what "re-run
  // reconciliation" means at the repository layer: replay the captured response through
  // settlement now that pricing exists.
  await expect(
    repository.recordUsage(unpricedRunId, {
      ...unpriced,
      costUsd: '0.000042',
      priceTableVersion: 'prices-v1',
    }),
  ).resolves.toMatchObject({ kind: 'recorded' });
  await expect(repository.get(unpricedRunId)).resolves.toMatchObject({
    // Token counts are unchanged — the late arrival prices the existing row, it does not add a
    // second copy of usage that was already captured.
    inputTokens: 7,
    outputTokens: 5,
    costUsd: '0.000042',
    priceTableVersion: 'prices-v1',
    accountingState: 'complete',
  });

  // Replaying the now-priced response again is a genuine duplicate: no further change.
  await expect(
    repository.recordUsage(unpricedRunId, {
      ...unpriced,
      costUsd: '0.000042',
      priceTableVersion: 'prices-v1',
    }),
  ).resolves.toMatchObject({ kind: 'duplicate' });
  await expect(repository.get(unpricedRunId)).resolves.toMatchObject({
    inputTokens: 7,
    costUsd: '0.000042',
  });
}

async function marksAccountingFailed(fixture: RunUsageFixture) {
  const { workspaceId, failureRunId, repositoryFor } = fixture;
  const repository = await repositoryFor(workspaceId);

  await expect(repository.get(failureRunId)).resolves.toMatchObject({
    accountingState: 'pending',
  });
  await expect(
    repository.markAccountingFailed(failureRunId, 'no authoritative usage fields'),
  ).resolves.toMatchObject({ kind: 'moved' });
  await expect(repository.get(failureRunId)).resolves.toMatchObject({
    accountingState: 'failed',
    accountingError: 'no authoritative usage fields',
  });

  // A second failure while already `failed` (not `pending`) is a no-op: it does not overwrite
  // the first reason, and it must not be mistaken for a fresh transition.
  await expect(
    repository.markAccountingFailed(failureRunId, 'a different reason'),
  ).resolves.toMatchObject({ kind: 'no-op' });
  await expect(repository.get(failureRunId)).resolves.toMatchObject({
    accountingError: 'no authoritative usage fields',
  });

  // A real settlement arriving afterward supersedes the failure mark entirely.
  await expect(
    repository.recordUsage(failureRunId, {
      ...usage('msg_after_failure'),
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      toolCalls: 0,
      costUsd: '0.000010',
    }),
  ).resolves.toMatchObject({ kind: 'recorded' });
  await expect(repository.get(failureRunId)).resolves.toMatchObject({
    accountingState: 'complete',
    accountingError: null,
  });

  // And now that the run has real settled usage, a later unrelated failure must not regress it.
  await expect(
    repository.markAccountingFailed(failureRunId, 'a later unrelated failure'),
  ).resolves.toMatchObject({ kind: 'no-op' });
  await expect(repository.get(failureRunId)).resolves.toMatchObject({
    accountingState: 'complete',
    accountingError: null,
  });
}

export function registerSettlementCases(fixture: RunUsageFixture) {
  it('settles a provider response exactly once under concurrent retries', () =>
    settlesOnceUnderRetries(fixture));

  it('rejects the legacy accounting state that made the Runs API unreadable', () =>
    rejectsLegacyAccountingState(fixture));
}

export function registerLateSettlementCases(fixture: RunUsageFixture) {
  it('atomically accumulates distinct responses and refuses mixed price versions', () =>
    accumulatesDistinctResponses(fixture));

  it('records unpriced usage as unavailable, then a priced late arrival for the same response reconciles it to complete', () =>
    reconcilesUnpricedUsage(fixture));

  it('marks a run failed only while accounting is still pending, and a real settlement supersedes it', () =>
    marksAccountingFailed(fixture));
}
