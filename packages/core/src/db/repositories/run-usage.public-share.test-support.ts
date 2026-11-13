import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { auditEvents } from '../schema/audit-events.js';
import { runs } from '../schema/runs.js';
import { shareRunCharges } from '../schema/share-run-charges.js';
import { shares } from '../schema/shares.js';
import { usage, type RunUsageFixture } from './run-usage.fixture.test-support.js';
import { createDatabaseShareRepositoryProvider } from './shares.js';

const shareRepositoryFor = async (fixture: RunUsageFixture, workspaceId: string) =>
  createDatabaseShareRepositoryProvider(fixture.isolated.db).forScope(
    await fixture.scopeFor(workspaceId),
  );

async function attributesSettlementToShare(fixture: RunUsageFixture) {
  const { workspaceId, shareId, publicRunId, secondPublicRunId, repositoryFor } = fixture;
  const shareRepository = await shareRepositoryFor(fixture, workspaceId);
  await expect(shareRepository.linkRun(shareId, publicRunId, new Date())).resolves.toEqual({
    kind: 'linked',
  });
  await expect(shareRepository.linkRun(shareId, secondPublicRunId, new Date())).resolves.toEqual({
    kind: 'linked',
  });
  await expect(shareRepository.linkRun(shareId, publicRunId, new Date())).resolves.toEqual({
    kind: 'existing',
  });

  const repository = await repositoryFor(workspaceId);
  const firstSettlements = await Promise.all([
    repository.recordUsage(publicRunId, usage('msg_public_a')),
    repository.recordUsage(secondPublicRunId, usage('msg_public_b')),
  ]);
  expect(firstSettlements.every((outcome) => outcome.kind === 'recorded')).toBe(true);

  const duplicateSettlements = await Promise.all([
    repository.recordUsage(publicRunId, usage('msg_public_a')),
    repository.recordUsage(secondPublicRunId, usage('msg_public_b')),
  ]);
  expect(duplicateSettlements.every((outcome) => outcome.kind === 'duplicate')).toBe(true);
  await expect(shareRepository.get(shareId)).resolves.toMatchObject({
    spentUsd: '0.000246',
    stopped: true,
  });
  await expect(
    fixture.isolated.db
      .select({ chargedUsd: shareRunCharges.chargedUsd })
      .from(shareRunCharges)
      .where(eq(shareRunCharges.shareId, shareId)),
  ).resolves.toEqual([{ chargedUsd: '0.000123' }, { chargedUsd: '0.000123' }]);
  await expect(
    fixture.isolated.db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, shareId)),
  ).resolves.toHaveLength(1);
}

async function capsInFlightShareRuns(fixture: RunUsageFixture) {
  const { workspaceId, userId, principalId, agentId, sessionId } = fixture;
  const { db } = fixture.isolated;
  const shareRepository = await shareRepositoryFor(fixture, workspaceId);
  const busyShareId = crypto.randomUUID();
  await db.insert(shares).values({
    id: busyShareId,
    workspaceId,
    tokenHash: `pub_${busyShareId}`,
    subjectType: 'agent',
    subjectId: agentId,
    subjectLabel: 'Usage agent',
    visibility: 'public',
    mode: 'runnable',
    include: {},
    budgetCapUsd: '5.0000',
    publisherPrincipalId: principalId,
    createdBy: userId,
  });
  const runIds = Array.from({ length: 4 }, () => crypto.randomUUID());
  for (const id of runIds) await db.insert(runs).values({ id, workspaceId, sessionId });
  const [first, second, third, fourth] = runIds as [string, string, string, string];
  for (const id of [first, second, third]) {
    await expect(shareRepository.linkRun(busyShareId, id, new Date())).resolves.toEqual({
      kind: 'linked',
    });
  }

  await expect(shareRepository.linkRun(busyShareId, fourth, new Date())).resolves.toEqual({
    kind: 'unavailable',
  });
  const now = new Date();
  await expect(
    shareRepository.reserveVisitorMessage({
      id: busyShareId,
      visitorKey: 'v1_busy_visitor',
      windowStartedAt: new Date(now.getTime() - 3_600_000),
      now,
      limit: 5,
    }),
  ).resolves.toEqual({ kind: 'busy' });

  await db
    .update(runs)
    .set({ status: 'completed', startedAt: now, endedAt: now })
    .where(eq(runs.id, first));
  await expect(shareRepository.linkRun(busyShareId, fourth, new Date())).resolves.toEqual({
    kind: 'linked',
  });
}

export function registerPublicShareCases(fixture: RunUsageFixture) {
  it('attributes concurrent settlement deltas to a public share exactly once', () =>
    attributesSettlementToShare(fixture));

  it('admits at most three in-flight runs per public share, so concurrent visitors cannot overshoot the cap', () =>
    capsInFlightShareRuns(fixture));
}
