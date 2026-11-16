/**
 * The `transitions` topic of the run store conformance suite (see `store.conformance.ts`):
 * every run status, put through every lifecycle method the port has, on both stores.
 *
 * Each cell builds one run, brings it to a status through the port alone, applies one method,
 * and reads back where the run ended up. The table below is written out by hand on purpose: it
 * is the expected behaviour, not a copy of the rule under test, so a change to the rule shows up
 * as a failing cell rather than as a test that agrees with itself.
 */
import { RUN_STATUSES } from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';

import type { ApprovalCall, RunStatus, RunStore } from './store';
import type { ConformanceHarness, RunStoreFixture } from './store.test-support';

/** Every run status; each can be reached through the port. */
const FROM_STATUSES = RUN_STATUSES;
type FromStatus = (typeof FROM_STATUSES)[number];

/** A lifecycle method of the port, with the status a `finish` asks for. */
const LIFECYCLE_CALLS = [
  'markRunning',
  'awaitApproval',
  'finish completed',
  'finish failed',
  'finish cancelled',
] as const;
type LifecycleCall = (typeof LIFECYCLE_CALLS)[number];

const CALL: ApprovalCall = { toolName: 'send_email', canonicalCall: '{"to":"a@b.c"}' };

/** Bring a freshly created run to `from` through the port, the way the launcher would. */
async function reach(store: RunStore, runId: string, from: FromStatus): Promise<void> {
  if (from === 'queued') return;
  await store.markRunning(runId);
  if (from === 'running') return;
  if (from === 'awaiting_approval') {
    await store.awaitApproval(runId, CALL);
    return;
  }
  await store.finish(runId, from, from === 'completed' ? null : `ended ${from}`);
}

/** Apply one lifecycle method. `markRunning` reports whether it moved the run; the others do not. */
async function apply(store: RunStore, runId: string, call: LifecycleCall): Promise<boolean | null> {
  switch (call) {
    case 'markRunning':
      return store.markRunning(runId);
    case 'awaitApproval':
      await store.awaitApproval(runId, CALL);
      return null;
    case 'finish completed':
      await store.finish(runId, 'completed', null);
      return null;
    case 'finish failed':
      await store.finish(runId, 'failed', 'failed by the transition table');
      return null;
    case 'finish cancelled':
      await store.finish(runId, 'cancelled', 'cancelled by the transition table');
      return null;
  }
}

/** What one cell observed. */
interface TransitionOutcome {
  readonly status: RunStatus;
  /** `markRunning`'s answer; `null` for the methods that return nothing. */
  readonly moved: boolean | null;
  /** Whether `endedAt` is the same instant it was before the call (`null` if it was unset). */
  readonly endedAtKept: boolean | null;
}

/** Run one cell against a fresh fixture. */
async function transitionOutcome(
  fixture: RunStoreFixture,
  from: FromStatus,
  call: LifecycleCall,
): Promise<TransitionOutcome> {
  const run = fixture.nextRun();
  await fixture.store.create(run);
  await reach(fixture.store, run.id, from);
  const before = await fixture.store.get(run.id);
  expect(before?.status).toBe(from);
  // A pause's end time and a later decision's must be distinguishable instants.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const moved = await apply(fixture.store, run.id, call);
  const after = await fixture.store.get(run.id);
  if (after === null || before === null) throw new Error(`run ${run.id} disappeared`);
  return {
    status: after.status,
    moved,
    endedAtKept:
      before.endedAt === null ? null : before.endedAt.getTime() === after.endedAt?.getTime(),
  };
}

/**
 * Where each call takes a run from each status, as PostgreSQL decides it
 * (`runStatusesThatMayMoveTo`). A row the call may not move stays where it was.
 */
const EXPECTED_STATUS: Readonly<Record<FromStatus, Readonly<Record<LifecycleCall, RunStatus>>>> = {
  queued: {
    markRunning: 'running',
    awaitApproval: 'queued',
    'finish completed': 'completed',
    'finish failed': 'failed',
    'finish cancelled': 'cancelled',
  },
  running: {
    markRunning: 'running',
    awaitApproval: 'awaiting_approval',
    'finish completed': 'completed',
    'finish failed': 'failed',
    'finish cancelled': 'cancelled',
  },
  awaiting_approval: {
    markRunning: 'awaiting_approval',
    awaitApproval: 'awaiting_approval',
    'finish completed': 'completed',
    // A decision resolves a pause to `completed` or `cancelled`, never `failed` (ADR-0145).
    'finish failed': 'awaiting_approval',
    'finish cancelled': 'cancelled',
  },
  completed: {
    markRunning: 'completed',
    awaitApproval: 'completed',
    'finish completed': 'completed',
    'finish failed': 'completed',
    'finish cancelled': 'completed',
  },
  failed: {
    markRunning: 'failed',
    awaitApproval: 'failed',
    'finish completed': 'failed',
    'finish failed': 'failed',
    'finish cancelled': 'failed',
  },
  cancelled: {
    markRunning: 'cancelled',
    awaitApproval: 'cancelled',
    'finish completed': 'cancelled',
    'finish failed': 'cancelled',
    'finish cancelled': 'cancelled',
  },
};

export function describeTransitions({ make }: ConformanceHarness): void {
  describe('transitions', () => {
    for (const from of FROM_STATUSES) {
      for (const call of LIFECYCLE_CALLS) {
        const expected = EXPECTED_STATUS[from][call];
        it(`${call} on a ${from} run leaves it ${expected}`, async () => {
          const outcome = await transitionOutcome(await make({}), from, call);
          expect(outcome.status).toBe(expected);
          if (call === 'markRunning') expect(outcome.moved).toBe(from === 'queued');
          // A run that stopped keeps the instant it stopped, whatever is called on it later; a
          // paused run that a decision finishes keeps its pause's end time (ADR-0145 D2.4).
          if (outcome.endedAtKept !== null) expect(outcome.endedAtKept).toBe(true);
        });
      }
    }
  });
}
