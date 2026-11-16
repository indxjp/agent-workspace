import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CALL, type RunsApprovalFixture } from './runs-approval.fixture.test-support.js';

const OTHER = { toolName: 'send_email', canonicalCall: '{"to":"b@example.test"}' } as const;

async function seedApproved(fixture: RunsApprovalFixture): Promise<string> {
  const runId = crypto.randomUUID();
  await fixture.repository.create({
    id: runId,
    sessionId: await fixture.seedSession(),
    engine: 'claude-agent-sdk',
    approvedToolCalls: [CALL],
  });
  expect((await fixture.repository.markRunning(runId)).kind).toBe('moved');
  return runId;
}

function oneUseCases(fixture: RunsApprovalFixture): void {
  it('consumes on first use and refuses the second', async () => {
    const { repository } = fixture;
    const runId = await seedApproved(fixture);

    await expect(repository.consumeApprovedCall(runId, CALL)).resolves.toBe('consumed');
    await expect(repository.consumeApprovedCall(runId, CALL)).resolves.toBe('already-used');

    expect((await repository.get(runId))?.consumedToolCalls).toEqual([CALL]);
  });

  it('gives exactly one of many parallel callers the approval', async () => {
    const { repository } = fixture;
    const runId = await seedApproved(fixture);

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => repository.consumeApprovedCall(runId, CALL)),
    );

    expect(outcomes.filter((outcome) => outcome === 'consumed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'already-used')).toHaveLength(7);
    expect((await repository.get(runId))?.consumedToolCalls).toEqual([CALL]);
  });

  it('refuses a call that was not approved, and consumes nothing', async () => {
    const { repository } = fixture;
    const runId = await seedApproved(fixture);

    await expect(repository.consumeApprovedCall(runId, OTHER)).resolves.toBe('not-approved');

    expect((await repository.get(runId))?.consumedToolCalls).toEqual([]);
    await expect(repository.consumeApprovedCall(runId, CALL)).resolves.toBe('consumed');
  });
}

function refusalCases(fixture: RunsApprovalFixture): void {
  it('refuses a run that is not running, or does not exist', async () => {
    const { repository } = fixture;
    const queuedId = crypto.randomUUID();
    await repository.create({
      id: queuedId,
      sessionId: await fixture.seedSession(),
      engine: 'claude-agent-sdk',
      approvedToolCalls: [CALL],
    });
    await expect(repository.consumeApprovedCall(queuedId, CALL)).resolves.toBe('not-approved');

    const doneId = await seedApproved(fixture);
    await repository.finish(doneId, 'completed', null);
    await expect(repository.consumeApprovedCall(doneId, CALL)).resolves.toBe('not-approved');

    await expect(repository.consumeApprovedCall(crypto.randomUUID(), CALL)).resolves.toBe(
      'not-approved',
    );
  });

  it('refuses another workspace’s scope', async () => {
    const runId = await seedApproved(fixture);
    const other = await fixture.otherWorkspaceRepository();

    await expect(other.repository.consumeApprovedCall(runId, CALL)).resolves.toBe('not-approved');

    expect((await fixture.repository.get(runId))?.consumedToolCalls).toEqual([]);
  });

  it('refuses a malformed call before any SQL', async () => {
    const runId = await seedApproved(fixture);
    await expect(
      fixture.repository.consumeApprovedCall(runId, { toolName: '', canonicalCall: '{}' }),
    ).rejects.toThrow(/approval call/u);
  });

  it('defaults to none consumed', async () => {
    const { runId } = await fixture.seedRunning();
    expect((await fixture.repository.get(runId))?.consumedToolCalls).toEqual([]);
  });
}

/** ADR-0145 D2.1, #1541: an approved call is good for one use, however many callers race for it. */
export function registerConsumptionCases(fixture: RunsApprovalFixture): void {
  describe('consuming an approved call', () => {
    oneUseCases(fixture);
    refusalCases(fixture);
  });
}
