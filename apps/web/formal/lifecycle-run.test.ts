import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';
import { InMemoryRunStore } from '../server/runs/memory-store';
import { isTerminalRunStatus, type RunStatus } from '../server/runs/store';

const vectors = loadVectors('lifecycle-run', 'run-sequences.json');
function status(value: unknown, context: string): RunStatus {
  const wire = asString(value, context);
  switch (wire) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return wire;
    default:
      throw new Error(`${context}: invalid status ${wire}`);
  }
}

function nat(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context}: expected a natural number`);
  }
  return value;
}

describe('lifecycle sequences against InMemoryRunStore', () => {
  it.each(vectors.map((vector) => [vector.id, vector] as const))('%s', async (_id, vector) => {
    if (!Array.isArray(vector.input)) throw new Error(`${vector.id}: actions must be an array`);
    const actions = vector.input.map((value) => asRecord(value, vector.id));
    const expected = asRecord(vector.expected, vector.id);
    let logicalTime = 0;
    let requestedTime = 0;
    const store = new InMemoryRunStore({ now: () => new Date(requestedTime) });
    const runId = `lifecycle-${vector.id}`;
    await store.create({
      engine: 'claude-agent-sdk',
      id: runId,
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
    });

    for (const action of actions) {
      const op = asString(action['op'], `${vector.id} op`);
      if (op === 'appendTerminal') {
        const target = status(action['target'], `${vector.id} target`);
        await store.appendPlatformEvent(runId, {
          type: 'run.status',
          data: { status: target, error: null },
        });
      } else if (op === 'appendRunning') {
        await store.appendPlatformEvent(runId, {
          type: 'run.status',
          data: { status: 'running', error: null },
        });
      } else if (op === 'markRunning') {
        const elapsed = nat(action['elapsed'], `${vector.id} elapsed`);
        requestedTime = logicalTime + elapsed;
        if (await store.markRunning(runId)) logicalTime = requestedTime;
      } else if (op === 'finish' || op === 'finishWithStatusEvent') {
        const target = status(action['target'], `${vector.id} target`);
        const elapsed = nat(action['elapsed'], `${vector.id} elapsed`);
        requestedTime = logicalTime + elapsed;
        if (!isTerminalRunStatus(target)) {
          await expect(store.finish(runId, target, null)).rejects.toThrow(
            /not a terminal run status/u,
          );
        } else {
          const before = await store.get(runId);
          await store.finish(runId, target, null, op === 'finishWithStatusEvent');
          if (before !== null && !isTerminalRunStatus(before.status)) logicalTime = requestedTime;
        }
      } else if (op !== 'revokeBrowserTokens' && op !== 'signalRuntime') {
        throw new Error(`${vector.id}: unknown action ${op}`);
      }
    }

    const record = await store.get(runId);
    expect(record?.status).toBe(expected['status']);
    expect(record?.startedAt?.getTime() ?? null).toBe(expected['startedAt']);
    expect(record?.endedAt?.getTime() ?? null).toBe(expected['endedAt']);

    if (expected['logClosed'] === true) {
      expect(record?.accountingState).toBe('pending');
      const after = await store.appendPlatformEvent(runId, {
        type: 'run.status',
        data: { status: 'completed', error: null },
      });
      expect(after.kind).toBe('rejected');
      const stream = await store.openStream(runId, null);
      expect(stream).not.toBeNull();
      if (stream === null) throw new Error(`${vector.id}: expected event stream`);
      const terminalEvents: string[] = [];
      const statusEvents: string[] = [];
      for await (const event of stream.events) {
        if (event.type === 'run.status') {
          const eventStatus = asString(asRecord(event.data, vector.id)['status'], vector.id);
          statusEvents.push(eventStatus);
          if (eventStatus !== 'running') terminalEvents.push(eventStatus);
        }
      }
      expect(statusEvents).toEqual(expected['statusEvents']);
      expect(terminalEvents).toEqual(expected['terminalEvents']);
    } else {
      const after = await store.appendPlatformEvent(runId, {
        type: 'run.status',
        data: { status: 'running', error: null },
      });
      expect(after.kind).toBe('appended');
    }
  });
});
