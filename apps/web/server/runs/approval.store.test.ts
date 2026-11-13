import { describe, expect, it } from 'vitest';

import { CALL, OTHER_WORKSPACE, newRun, pausedRun } from './approval.test-support';
import { InMemoryRunStore } from './memory-store';
import { ApprovalDecisionError } from './store';

describe('InMemoryRunStore: a decision is a compare-and-set (ADR-0145 D2.1)', () => {
  const continuation = (decides: string) => ({
    ...newRun(),
    approvedToolCalls: [CALL],
    decides,
  });

  it('lets exactly one of two decisions create a continuation', async () => {
    const store = new InMemoryRunStore();
    const paused = await pausedRun(store);
    const first = await store.create(continuation(paused.id));
    expect(first.approvedToolCalls).toEqual([CALL]);
    await expect(store.create(continuation(paused.id))).rejects.toMatchObject({
      constructor: ApprovalDecisionError,
      reason: 'already-decided',
    });
  });

  it('refuses a decision on a run that is not paused, or is in another workspace', async () => {
    const store = new InMemoryRunStore();
    const other = await pausedRun(store, { workspaceId: OTHER_WORKSPACE });
    await expect(store.create(continuation(other.id))).rejects.toBeInstanceOf(
      ApprovalDecisionError,
    );
    await expect(store.create(continuation(crypto.randomUUID()))).rejects.toBeInstanceOf(
      ApprovalDecisionError,
    );
  });

  it('awaitApproval pauses only a running run, and records the call it waits on', async () => {
    const store = new InMemoryRunStore();
    const queued = await store.create(newRun());
    await store.awaitApproval(queued.id, CALL);
    expect((await store.get(queued.id))?.status).toBe('queued');
    const paused = await pausedRun(store);
    expect(paused.status).toBe('awaiting_approval');
    expect(paused.pendingApproval).toEqual(CALL);
    expect(paused.endedAt).not.toBeNull();
  });
});
