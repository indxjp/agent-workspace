/**
 * Differential conformance for the `concept-work` family, application side: the Lean run and
 * session concepts (formal/AgentWorkspace/Concepts/{Run,Session}.lean, and the store operations
 * of formal/AgentWorkspace/Theorems/Invariants/ConceptWork.lean) replayed against the REAL web
 * server code.
 *
 *   - `run-store.json`: every sequence of at most two store operations (`markRunning`, `finish`
 *     with each status) on an `InMemoryRunStore` whose clock the vector sets. The stored status,
 *     `startedAt` and `endedAt`, what `renderRun` derives from them, and that the result satisfies
 *     `runs_ended_at_iff_terminal` and `runs_ended_after_started`, are the model's.
 *   - `run-render.json`: `renderRun`'s derived `usage.totalTokens` and `durationMs`.
 *   - `session-launch.json`: `sessionForLaunch` launches fresh until the SDK has reported an id,
 *     and `recordReportedSessionIdentity` records a reported id exactly when it is the platform id.
 *
 * The package side (tables, checks, enumerations, transcript keys) is
 * `tests/formal/concept-work.test.ts`.
 */
import {
  isTerminalRunStatus,
  RUN_STATUSES,
  RunResourceSchema,
  type RunStatus,
} from '@indx-workspace/contracts/runs';
import type {
  SessionMutationOutcome,
  SessionRecord,
  SessionRepository,
} from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import {
  recordReportedSessionIdentity,
  sessionForLaunch,
} from '../server/composition/session-launch';
import { renderRun } from '../server/runs/api';
import { InMemoryRunStore } from '../server/runs/memory-store';
import type { RunRecord } from '../server/runs/store';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const storeVectors = loadVectors('concept-work', 'run-store.json');
const renderVectors = loadVectors('concept-work', 'run-render.json');
const sessionVectors = loadVectors('concept-work', 'session-launch.json');

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`);
  return value;
}

function asNullableNumber(value: unknown, what: string): number | null {
  return value === null ? null : asNumber(value, what);
}

function asNullableString(value: unknown, what: string): string | null {
  return value === null ? null : asString(value, what);
}

function asRunStatus(value: unknown, what: string): RunStatus {
  const status = RUN_STATUSES.find((s) => s === value);
  if (status === undefined) throw new Error(`${what}: ${JSON.stringify(value)} is not a status`);
  return status;
}

function instant(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

const RUN = {
  id: 'run-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  engine: 'claude-agent-sdk',
} as const;

describe('run store operations', () => {
  it.each(storeVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    let clock = asNumber(input['createdAt'], vector.id);
    const store = new InMemoryRunStore({ now: () => new Date(clock) });
    await store.create(RUN);
    for (const raw of asArray(input['operations'], vector.id)) {
      const op = asRecord(raw, vector.id);
      clock = asNumber(op['at'], vector.id);
      if (op['op'] === 'markRunning') {
        await store.markRunning(RUN.id);
      } else {
        const target = asRunStatus(op['target'], vector.id);
        // A live target is a programming error both stores throw on; the model leaves the run.
        if (isTerminalRunStatus(target)) await store.finish(RUN.id, target, null);
        else await expect(store.finish(RUN.id, target, null)).rejects.toThrow();
      }
    }
    const record = await store.get(RUN.id);
    if (record === null) throw new Error(`${vector.id}: the run disappeared`);
    expect(record.status).toBe(asRunStatus(expected['status'], vector.id));
    expect(instant(record.startedAt)).toBe(asNullableNumber(expected['startedAt'], vector.id));
    expect(instant(record.endedAt)).toBe(asNullableNumber(expected['endedAt'], vector.id));
    const rendered = asRecord(renderRun(record), vector.id);
    expect(rendered['durationMs']).toBe(expected['durationMs']);
    expect(asRecord(rendered['usage'], vector.id)['totalTokens']).toBe(expected['totalTokens']);
    expect(asRecord(rendered['cost'], vector.id)['amount']).toBe(expected['costUsd']);
    expect(rendered['accountingState']).toBe(expected['accountingState']);
    expect(RunResourceSchema.safeParse(rendered).success).toBe(true);
    const endedIffTerminal = isTerminalRunStatus(record.status) === (record.endedAt !== null);
    const endedAfterStarted =
      record.startedAt === null ||
      record.endedAt === null ||
      record.endedAt.getTime() >= record.startedAt.getTime();
    expect(endedIffTerminal && endedAfterStarted).toBe(expected['wellFormed']);
  });
});

describe('renderRun derivations', () => {
  it.each(renderVectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const startedAt = asNullableNumber(input['startedAt'], vector.id);
    const endedAt = asNullableNumber(input['endedAt'], vector.id);
    const record: RunRecord = {
      ...RUN,
      status: endedAt === null ? 'running' : 'completed',
      createdAt: new Date(0),
      startedAt: startedAt === null ? null : new Date(startedAt),
      endedAt: endedAt === null ? null : new Date(endedAt),
      inputTokens: asNumber(input['inputTokens'], vector.id),
      outputTokens: asNumber(input['outputTokens'], vector.id),
      cacheReadInputTokens: asNumber(input['cacheReadInputTokens'], vector.id),
      cacheCreationInputTokens: asNumber(input['cacheCreationInputTokens'], vector.id),
      toolCalls: asNumber(input['toolCalls'], vector.id),
      error: null,
    };
    const rendered = asRecord(renderRun(record), vector.id);
    const usage = asRecord(rendered['usage'], vector.id);
    expect(usage['totalTokens']).toBe(expected['totalTokens']);
    expect(usage['toolCalls']).toBe(expected['toolCalls']);
    expect(rendered['durationMs']).toBe(expected['durationMs']);
  });
});

/**
 * A session repository that records `update` calls and answers nothing else.
 *
 * The recorded tuple is `(sessionId, engineSessionId, engine)`: ADR-0065 requires the engine to be
 * written in the same update as the id it belongs to, so a replay that only watched the id could
 * not tell a conforming writer from one that leaves `sessions.engine` NULL.
 */
function recordingRepository(
  updates: [string, string | null | undefined, string | null | undefined][],
): SessionRepository {
  const unused = (): Promise<never> => Promise.reject(new Error('not used by this suite'));
  return {
    ensure: unused,
    get: unused,
    getByEngineSessionId: unused,
    list: unused,
    archive: unused,
    restore: unused,
    discardIfUnused: () => Promise.resolve(false),
    update(sessionId, input): Promise<SessionMutationOutcome> {
      updates.push([
        sessionId,
        input.engineIdentity?.engineSessionId,
        input.engineIdentity?.engine,
      ]);
      return Promise.resolve({ kind: 'updated', session: sessionRecord(sessionId, null) });
    },
  };
}

function sessionRecord(id: string, engineSessionId: string | null): SessionRecord {
  return {
    id,
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    userId: null,
    ownerPrincipalId: 'principal-1',
    projectId: null,
    engineSessionId,
    engine: engineSessionId === null ? null : 'claude-agent-sdk',
    agentVersionId: null,
    title: null,
    status: 'active',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('session launch identity', () => {
  it.each(sessionVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const id = asString(input['id'], vector.id);
    const agentId = asString(input['agentId'], vector.id);
    if (input['kind'] === 'launch') {
      const ref = sessionForLaunch(
        sessionRecord(id, asNullableString(input['engineSessionId'], vector.id)),
      );
      expect(ref.id).toBe(id);
      expect(ref.agentId).toBe(agentId);
      expect(ref.resume === true ? 'resume' : 'fresh').toBe(expected['mode']);
      return;
    }
    const reported = asString(input['reported'], vector.id);
    const updates: [string, string | null | undefined, string | null | undefined][] = [];
    const outcome = recordReportedSessionIdentity(
      recordingRepository(updates),
      // Unpinned until this very write: `sessions.engine` is NULL before a run reports an identity.
      { id, agentId, engine: null },
      reported,
      // #318: the engine is now the one the *run* recorded, and `claude-agent-sdk` is the only
      // engine a run in this release can record — which is what the vector's `engine` says.
      'claude-agent-sdk',
    );
    if (expected['recorded'] === true) {
      await expect(outcome).resolves.toBeUndefined();
      expect(updates).toEqual([[id, expected['engineSessionId'], expected['engine']]]);
    } else {
      await expect(outcome).rejects.toThrow();
      expect(updates).toEqual([]);
    }
  });
});
