/** The `records` topic of the run store conformance suite (see `store.conformance.ts`). */
import { describe, expect, it } from 'vitest';

import { parseRunFailure } from '@indx-workspace/contracts/runs';

import {
  ApprovalDecisionError,
  IdempotencyKeyTakenError,
  type ApprovalCall,
  type RunStore,
} from './store';
import type { ConformanceHarness } from './store.test-support';

export function describeRecords(harness: ConformanceHarness): void {
  describeCreation(harness);
  describeStartKeys(harness);
  describeKeyConflicts(harness);
  describeApprovalsConsumed(harness);
  describeTerminalStamps(harness);
  describeFinishRules(harness);
  describeModelSnapshots(harness);
}

function describeCreation({ make, started }: ConformanceHarness): void {
  describe('records', () => {
    it('creates a queued run with no timestamps and refuses a duplicate id', async () => {
      const { store, run } = await started();
      const record = await store.get(run.id);
      expect(record?.status).toBe('queued');
      expect(record?.startedAt).toBeNull();
      expect(record?.endedAt).toBeNull();
      await expect(store.create(run)).rejects.toThrow(/already exists/);
    });

    it('echoes the workspace, agent and session the run was created for', async () => {
      const { store, run } = await started();
      const record = await store.get(run.id);
      expect(record?.workspaceId).toBe(run.workspaceId);
      expect(record?.agentId).toBe(run.agentId);
      expect(record?.sessionId).toBe(run.sessionId);
    });

    // ADR-0151: a paused run takes exactly one continuation; a second decision is refused and
    // creates nothing.
    it('gives a paused run one continuation and refuses a second decision', async () => {
      const { store, run, fixture } = await started();
      await store.markRunning(run.id);
      await store.awaitApproval(run.id, { toolName: 'send_email', canonicalCall: '{}' });
      const continuation = { ...fixture.nextRun(), decides: run.id };
      await store.create(continuation);
      const second = { ...fixture.nextRun(), decides: run.id };

      await expect(store.create(second)).rejects.toMatchObject({
        constructor: ApprovalDecisionError,
        runId: run.id,
        reason: 'already-decided',
      });
      expect(await store.get(second.id)).toBeNull();
      expect((await store.get(run.id))?.status).toBe('completed');
      expect((await store.get(continuation.id))?.status).toBe('queued');
    });

    it('returns null for a run it has never seen', async () => {
      const fixture = await make({});
      expect(await fixture.store.get(fixture.nextRun().id)).toBeNull();
    });
  });
}

function describeStartKeys({ make }: ConformanceHarness): void {
  describe('records', () => {
    // ADR-0151, #250: one run per start key, per workspace and principal.
    it('finds a run by its start key, scoped to its principal, and never frees the key', async () => {
      const fixture = await make({});
      const principalId = crypto.randomUUID();
      const idempotency = { principalId, key: 'retry-1', requestHash: 'h1' };
      const first = { ...fixture.nextRun(), idempotency };
      await fixture.store.create(first);
      const { workspaceId } = first;

      const found = await fixture.store.findByIdempotencyKey(workspaceId, principalId, 'retry-1');
      expect({ id: found?.run.id, requestHash: found?.requestHash }).toEqual({
        id: first.id,
        requestHash: 'h1',
      });
      await expect(
        fixture.store.findByIdempotencyKey(workspaceId, crypto.randomUUID(), 'retry-1'),
      ).resolves.toBeNull();
      await expect(
        fixture.store.findByIdempotencyKey(workspaceId, principalId, 'retry-2'),
      ).resolves.toBeNull();

      // Not even a finished run frees its key.
      await fixture.store.finish(first.id, 'completed', null);
      await expect(fixture.store.create({ ...fixture.nextRun(), idempotency })).rejects.toThrow(
        IdempotencyKeyTakenError,
      );
      const other = { ...fixture.nextRun(), idempotency: { ...idempotency, principalId: 'p2' } };
      await expect(fixture.store.create(other)).resolves.toMatchObject({ id: other.id });
    });

    // #1440: both stores give one answer when a held key meets a `decides` that cannot be
    // decided. The decision is judged first, so the caller hears why the decision failed.
    it('answers already-decided, not key-taken, for a held key with a decided `decides`', async () => {
      const fixture = await make({});
      const idempotency = { principalId: crypto.randomUUID(), key: 'k', requestHash: 'h' };
      const first = { ...fixture.nextRun(), idempotency };
      await fixture.store.create(first);
      await fixture.store.finish(first.id, 'completed', null);

      const refused = await fixture.store
        .create({ ...fixture.nextRun(), idempotency, decides: first.id })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ApprovalDecisionError);
      expect((refused as ApprovalDecisionError).reason).toBe('already-decided');
    });
  });
}

function describeKeyConflicts({ make }: ConformanceHarness): void {
  describe('records', () => {
    it('leaves the paused run awaiting approval when the continuation’s key is taken', async () => {
      const fixture = await make({});
      const call: ApprovalCall = { toolName: 'send_email', canonicalCall: '{"to":"a@b.c"}' };
      const idempotency = { principalId: crypto.randomUUID(), key: 'k', requestHash: 'h' };
      const holder = { ...fixture.nextRun(), idempotency };
      await fixture.store.create(holder);
      await fixture.store.finish(holder.id, 'completed', null);
      const paused = fixture.nextRun();
      await fixture.store.create(paused);
      await fixture.store.markRunning(paused.id);
      await fixture.store.awaitApproval(paused.id, call);

      await expect(
        fixture.store.create({
          ...fixture.nextRun(),
          idempotency,
          decides: paused.id,
          approvedToolCalls: [call],
        }),
      ).rejects.toThrow(IdempotencyKeyTakenError);
      expect((await fixture.store.get(paused.id))?.status).toBe('awaiting_approval');
    });

    // #1440: two starts with one key on one session race. The loser hears the key is taken, so
    // the route replays the winner, rather than `session_busy`.
    it('answers a concurrent start with the same key on one session with key-taken', async () => {
      const fixture = await make({});
      const idempotency = { principalId: crypto.randomUUID(), key: 'k', requestHash: 'h' };
      const results = await Promise.allSettled([
        fixture.store.create({ ...fixture.nextRun(), idempotency }),
        fixture.store.create({ ...fixture.nextRun(), idempotency }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const [lost] = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      expect(lost).toBeInstanceOf(IdempotencyKeyTakenError);
    });
  });
}

function describeApprovalsConsumed({ make }: ConformanceHarness): void {
  describe('records', () => {
    // ADR-0151: approved calls are consumed when the run leaves `queued`, once.
    it('stamps approvalsConsumedAt on markRunning only for a run with approved calls', async () => {
      const fixture = await make({});
      const call: ApprovalCall = { toolName: 'send_email', canonicalCall: '{"to":"a@b.c"}' };
      const plain = fixture.nextRun();
      await fixture.store.create(plain);
      await fixture.store.markRunning(plain.id);
      expect((await fixture.store.get(plain.id))?.approvalsConsumedAt).toBeNull();
      await fixture.store.finish(plain.id, 'completed', null);

      const approved = { ...fixture.nextRun(), approvedToolCalls: [call] };
      await fixture.store.create(approved);
      expect((await fixture.store.get(approved.id))?.approvalsConsumedAt).toBeNull();
      await fixture.store.markRunning(approved.id);
      const consumed = await fixture.store.get(approved.id);
      expect(consumed?.approvalsConsumedAt).toBeInstanceOf(Date);
      expect(consumed?.approvalsConsumedAt).toEqual(consumed?.startedAt);
    });
  });
}

/** Reads a run's stream to its end and returns every `run.status` payload on it. */
async function terminalStatusEvents(store: RunStore, runId: string): Promise<unknown[]> {
  const handle = await store.openStream(runId, null);
  if (handle === null) throw new Error('run had no event stream');
  const terminal: unknown[] = [];
  for await (const event of handle.events) {
    if (event.type === 'run.status') terminal.push(event.data);
  }
  return terminal;
}

function describeTerminalStamps({ started }: ConformanceHarness): void {
  describe('records', () => {
    it('stamps startedAt once and endedAt once, and the first terminal status wins', async () => {
      const { store, run } = await started();
      // Only the call that actually moves the run out of `queued` reports `true` (issue #235:
      // the launcher starts a runtime on that answer alone).
      expect(await store.markRunning(run.id)).toBe(true);
      const startedAt = (await store.get(run.id))?.startedAt;
      expect(startedAt).toBeInstanceOf(Date);
      expect(await store.markRunning(run.id)).toBe(false);
      expect((await store.get(run.id))?.startedAt).toEqual(startedAt);

      await store.finish(run.id, 'completed', null);
      await store.finish(run.id, 'failed', 'too late');
      const record = await store.get(run.id);
      expect(record?.status).toBe('completed');
      expect(record?.error).toBeNull();
      expect(record?.endedAt).toBeInstanceOf(Date);
    });

    it('commits one matching terminal status event when finishes race', async () => {
      const { store, run } = await started();
      await store.markRunning(run.id);
      await Promise.all([
        store.finish(run.id, 'cancelled', 'interrupted', true),
        store.finish(run.id, 'completed', null, true),
      ]);
      const settled = await store.get(run.id);
      if (settled === null) throw new Error('run was lost');
      const terminal = await terminalStatusEvents(store, run.id);
      expect(terminal).toEqual([{ status: settled.status, error: settled.error }]);
    });

    it('never leaves a terminal run without an endedAt, which the database check forbids', async () => {
      const { store, run } = await started();
      await store.finish(run.id, 'failed', 'the runtime never answered');
      const record = await store.get(run.id);
      expect(record?.endedAt).toBeInstanceOf(Date);
      // `runs_ended_at_iff_terminal` also needs a coherent start; a run that failed before it
      // ever started still gets one rather than a NULL that renders as "NaN s".
      expect(record?.startedAt).toBeInstanceOf(Date);
      expect(record?.error).toBe('the runtime never answered');
    });
  });
}

function describeFinishRules({ make, started }: ConformanceHarness): void {
  describe('records', () => {
    it('keeps the daily cost cap reason the gateway ended a run with, over the engine’s later text (issue #1851)', async () => {
      const { store, run } = await started();
      const reason =
        'daily_cost_cap_reached: The workspace has reached its daily model cost cap; capUsd: 5, resetsAt: 2026-10-28T00:00:00.000Z';
      await store.finish(run.id, 'failed', reason, true);
      // The engine fails on the refused call and the launcher concludes with its own text.
      await store.finish(run.id, 'failed', '429 Too Many Requests', true);

      const record = await store.get(run.id);
      expect(record?.status).toBe('failed');
      expect(record?.error).toBe(reason);
      expect(parseRunFailure(record?.error ?? null)?.code).toBe('daily_cost_cap_reached');
      // The stream, too, ends with the gateway's reason and only once.
      const terminal = await terminalStatusEvents(store, run.id);
      expect(terminal).toEqual([{ status: 'failed', error: reason }]);
    });

    it('keeps a completed run’s output, and refuses an output on any other ending (ADR-0143)', async () => {
      const { store, run } = await started();
      expect((await store.get(run.id))?.output).toBeNull();
      const output = { text: '{"a":1}', structured: { a: 1 } };
      await expect(store.finish(run.id, 'failed', 'boom', false, output)).rejects.toThrow(
        /cannot carry an output/,
      );
      expect((await store.get(run.id))?.output).toBeNull();
      await store.finish(run.id, 'completed', null, false, output);
      expect((await store.get(run.id))?.output).toEqual(output);
    });

    it('refuses to "finish" a run into a non-terminal status', async () => {
      const { store, run } = await started();
      await expect(store.finish(run.id, 'running', null)).rejects.toThrow(/not a terminal/);
    });

    it('treats a lifecycle transition on an unknown run as a no-op, not a failure', async () => {
      const fixture = await make({});
      const absent = fixture.nextRun().id;
      // …and it reports that it did not transition anything, which is how the launcher tells a
      // run it may start from one that is already gone or already terminal (issue #235).
      await expect(fixture.store.markRunning(absent)).resolves.toBe(false);
      await expect(fixture.store.finish(absent, 'completed', null)).resolves.toBeUndefined();
    });
  });
}

function describeModelSnapshots({ make, started }: ConformanceHarness): void {
  describe('records', () => {
    // issue #129: written once, before launch, so a queued or failed run still says what it
    // attempted. Distinct from usage settlement (`run-usage.test.ts`, `packages/core`), which
    // this method never touches.
    it('snapshotModel writes model, provider and connection id, and leaves counters untouched', async () => {
      const { store, run, fixture } = await started();
      await store.snapshotModel(run.id, {
        connectionId: fixture.modelConnectionId,
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
      });
      const record = await store.get(run.id);
      expect(record).toMatchObject({
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        modelConnectionId: fixture.modelConnectionId,
        inputTokens: 0,
        outputTokens: 0,
      });
    });

    it('snapshotModel overwrites a previous snapshot rather than accumulating', async () => {
      const { store, run, fixture } = await started();
      const snapshot = (model: string): Promise<void> =>
        store.snapshotModel(run.id, {
          connectionId: fixture.modelConnectionId,
          model,
          provider: 'anthropic',
        });
      await snapshot('claude-sonnet-4-5');
      await snapshot('claude-opus-4-5');
      expect((await store.get(run.id))?.model).toBe('claude-opus-4-5');
    });

    it('snapshotModel on an unknown run is a no-op, not a failure', async () => {
      const fixture = await make({});
      const absent = fixture.nextRun().id;
      await expect(
        fixture.store.snapshotModel(absent, {
          connectionId: fixture.modelConnectionId,
          model: 'claude-sonnet-4-5',
          provider: 'anthropic',
        }),
      ).resolves.toBeUndefined();
    });
  });
}
