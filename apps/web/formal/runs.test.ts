/**
 * Differential conformance for the runs family: the Lean model's run status enumeration and
 * status machine (formal/AgentWorkspace/Contracts/Runs.lean, Lifecycle/Run.lean), replayed
 * against the contracts package, the Zod resource schema and the in-memory run store.
 */
import {
  isTerminalRunStatus,
  RUN_STATUSES,
  RunResourceSchema,
  TERMINAL_RUN_STATUSES,
  type RunStatus,
} from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';

import { InMemoryRunStore } from '../server/runs/memory-store';
import { runStatuses } from '../server/runs/store';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const statusVectors = loadVectors('runs', 'run-status.json');
const transitionVectors = loadVectors('runs', 'run-transitions.json');
const statusSchema = RunResourceSchema.unwrap().shape.status;

function asRunStatus(value: unknown, what: string): RunStatus {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${what}: ${JSON.stringify(value)} is not a run status`);
  return parsed.data;
}

describe('run status enumeration', () => {
  const modelMembers = statusVectors
    .filter((v) => asRecord(v.expected, v.id)['valid'] === true)
    .map((v) => asString(v.input, v.id));

  it('the model lists exactly RUN_STATUSES, in order, and the store restates the same list', () => {
    expect(modelMembers).toEqual([...RUN_STATUSES]);
    expect([...runStatuses]).toEqual([...RUN_STATUSES]);
  });

  it.each(statusVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const expected = asRecord(vector.expected, vector.id);
    const parsed = statusSchema.safeParse(vector.input);
    expect(parsed.success).toBe(expected['valid']);
    if (parsed.success) {
      expect(isTerminalRunStatus(parsed.data)).toBe(expected['terminal']);
      expect((TERMINAL_RUN_STATUSES as readonly string[]).includes(parsed.data)).toBe(
        expected['terminal'],
      );
    }
  });
});

const RUN = {
  id: 'run-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  engine: 'claude-agent-sdk',
} as const;

/** A store holding one run that has been driven to `status` through the public operations. */
async function storeWithRunIn(status: RunStatus): Promise<InMemoryRunStore> {
  const store = new InMemoryRunStore();
  await store.create(RUN);
  if (status === 'running' || status === 'awaiting_approval') await store.markRunning(RUN.id);
  if (status === 'awaiting_approval') {
    await store.awaitApproval(RUN.id, { toolName: 'Bash', canonicalCall: 'Bash(ls)' });
  }
  if (isTerminalRunStatus(status)) await store.finish(RUN.id, status, null);
  const reached = await store.get(RUN.id);
  expect(reached?.status).toBe(status);
  return store;
}

describe('run status machine', () => {
  it.each(transitionVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const operation = asRecord(input['operation'], `${vector.id} operation`);
    const expected = asRecord(vector.expected, vector.id);
    const from = asRunStatus(input['from'], `${vector.id} from`);
    const store = await storeWithRunIn(from);

    if (operation['op'] === 'markRunning') {
      const moved = await store.markRunning(RUN.id);
      expect(moved).toBe(expected['kind'] === 'moved');
    } else if (operation['op'] === 'finish') {
      const target = asRunStatus(operation['target'], `${vector.id} target`);
      const call = store.finish(RUN.id, target, null);
      if (expected['kind'] === 'invalidCall') {
        await expect(call).rejects.toThrow(/not a terminal run status/u);
      } else {
        await call;
      }
    } else {
      throw new Error(`${vector.id}: unknown operation ${JSON.stringify(operation)}`);
    }

    const after = await store.get(RUN.id);
    const expectedStatus = expected['kind'] === 'moved' ? expected['status'] : from;
    expect(after?.status).toBe(expectedStatus);
  });
});
