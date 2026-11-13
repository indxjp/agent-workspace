/**
 * Shared pieces of the PostgreSQL run store's event suites (`store.postgres*.test.ts`): starting a
 * run, reading its stream, the legacy pre-ENG-03 log, and a window injected between event listing
 * and the status read.
 */
import { expect } from 'vitest';

import { classifySdkEvent } from '@agent-workspace/run-protocol';

import type { createRepositoryRunStore } from './repository-store';
import type { CreateRunInput, RunStore } from './store';
import type { RunChain, RunDatabase } from './store.postgres.test-support';
import type { SseEvent } from './sse';

type RunEvents = Parameters<typeof createRepositoryRunStore>[0]['events'];

export const runInput = (chain: RunChain, id: string): CreateRunInput => ({
  engine: 'claude-agent-sdk',
  id,
  workspaceId: chain.workspaceId,
  agentId: chain.agentId,
  sessionId: chain.sessionId,
});

/** Seeds a fresh chain named after `workspace`, then creates a run on it and marks it running. */
export async function startRunningRun(
  database: RunDatabase,
  store: RunStore,
  workspace: string,
  agent: string,
): Promise<string> {
  const chain = await database.seedChain({ workspace, user: 'Runner', agent });
  const runId = crypto.randomUUID();
  await store.create(runInput(chain, runId));
  await store.markRunning(runId);
  return runId;
}

/** Reads a run's stream from `after` to its end. */
export async function readStream(
  store: RunStore,
  runId: string,
  after: bigint | null,
): Promise<SseEvent[]> {
  const stream = await store.openStream(runId, after);
  if (stream === null) throw new Error('durable run was not found');
  const seen: SseEvent[] = [];
  for await (const event of stream.events) seen.push(event);
  return seen;
}

/**
 * Wraps an event repository so that the first `list` — after reading its own snapshot — commits the
 * run's terminal status through `store`, exactly the window between event listing and the status
 * read.
 */
export function injectingTerminalTail(
  base: RunEvents,
  storeRef: { current?: RunStore },
): RunEvents {
  let inject = true;
  return {
    forScope(scope: Parameters<typeof base.forScope>[0]) {
      const repository = base.forScope(scope);
      return {
        append: (id: string, type: string, data: unknown, maxEvents: number) =>
          repository.append(id, type, data, maxEvents),
        bounds: (id: string) => repository.bounds(id),
        async list(id: string, after: bigint | null) {
          const snapshot = await repository.list(id, after);
          if (inject) {
            inject = false;
            const store = storeRef.current;
            if (store === undefined) throw new Error('run store missing');
            await store.appendPlatformEvent(id, {
              type: 'run.status',
              data: { status: 'completed' },
            });
            await store.finish(id, 'completed', null);
          }
          return snapshot;
        },
      };
    },
  };
}

/** Exactly what `relay.ts` wrote before ENG-03: the runner's classification envelope. */
export const LEGACY_MESSAGES: readonly unknown[] = [
  { type: 'system', subtype: 'init', session_id: 'sess_legacy', model: 'claude-opus-5' },
  {
    type: 'assistant',
    message: {
      id: 'msg_1',
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: '/a' } },
      ],
    },
  },
  { type: 'result', subtype: 'success', total_cost_usd: 0.25 },
];

/** The event name `relay.ts` gave each of `LEGACY_MESSAGES`, in order. */
const LEGACY_EVENT_TYPES = ['system', 'sdk-event', 'result'] as const;

/** Writes the legacy messages under their relayed names, through the public `append`. */
export async function appendLegacyRows(store: RunStore, runId: string): Promise<void> {
  for (const [index, message] of LEGACY_MESSAGES.entries()) {
    const classified = classifySdkEvent(message);
    const appended = await store.append(runId, {
      type: LEGACY_EVENT_TYPES[index] ?? 'result',
      data: { ...classified, event: message },
    });
    expect(appended.kind).toBe('appended');
  }
}
