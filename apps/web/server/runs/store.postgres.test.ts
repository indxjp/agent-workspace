/**
 * The run store over a real PostgreSQL: restart replay, legacy-log upgrade, the terminal tail, and
 * the shared conformance suite (`store.conformance.ts`). The `listRuns` suites are in
 * `store.postgres-list*.test.ts` and `store.postgres-differential.test.ts`.
 *
 * Runs whenever `TEST_DATABASE_URL` names a database; skipped as a block otherwise.
 */
import { describe, expect, it } from 'vitest';

import { AgentFrameSchema } from '@indx-workspace/contracts/run-events';
import { classifySdkEvent, toAgentFrames } from '@agent-workspace/run-protocol';

import { upgradeEventStream } from './agent-frames';
import { InMemoryRunStore } from './memory-store';
import type { createRepositoryRunStore } from './repository-store';
import type { CreateRunInput, RunStore } from './store';
import { describeRunStoreConformance } from './store.conformance.test-support';
import { databaseConfigured, useRunDatabase, type RunChain } from './store.postgres.test-support';
import type { SseEvent, SseWireEvent } from './sse';

const hasDatabase = databaseConfigured(process.env);

if (!hasDatabase) {
  console.warn(
    '[runs/store.postgres.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half ' +
      'of this conformance suite did NOT run. A green result without it says nothing about ' +
      'whether run records reach the database at all.',
  );
}

type RunEvents = Parameters<typeof createRepositoryRunStore>[0]['events'];

const runInput = (chain: RunChain, id: string): CreateRunInput => ({
  engine: 'claude-agent-sdk',
  id,
  workspaceId: chain.workspaceId,
  agentId: chain.agentId,
  sessionId: chain.sessionId,
});

/** Reads a run's stream from `after` to its end. */
async function readStream(
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
function injectingTerminalTail(base: RunEvents, storeRef: { current?: RunStore }): RunEvents {
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
const LEGACY_MESSAGES: readonly unknown[] = [
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

/** Writes the legacy messages under their relayed names, through the public `append`. */
async function appendLegacyRows(store: RunStore, runId: string): Promise<void> {
  for (const [index, message] of LEGACY_MESSAGES.entries()) {
    const classified = classifySdkEvent(message);
    const appended = await store.append(runId, {
      type: index === 0 ? 'system' : index === 1 ? 'sdk-event' : 'result',
      data: { ...classified, event: message },
    });
    expect(appended.kind).toBe('appended');
  }
}

describe.skipIf(!hasDatabase)('the PostgreSQL run store', () => {
  const database = useRunDatabase();

  it('refuses by name when the workspace a run names does not exist', async () => {
    const store = database.makeStore();
    // A create against a workspace with no row is a named failure, not a run that quietly exists
    // nowhere. `get` on an id nothing has ever used stays `null`, because that one really is
    // "not found" and the route turns it into a 404.
    await expect(
      store.create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/no workspace has id/u);
    expect(await store.get(crypto.randomUUID())).toBeNull();
  });

  it('replays durable events through a newly constructed store instance', async () => {
    const chain = await database.seedChain({
      workspace: 'Restart replay',
      user: 'Runner',
      agent: 'Restart agent',
    });
    const runId = crypto.randomUUID();
    const firstProcess = database.makeStore();
    await firstProcess.create(runInput(chain, runId));
    await firstProcess.markRunning(runId);
    await firstProcess.append(runId, { type: 'assistant', data: { text: 'before restart' } });
    await firstProcess.finish(runId, 'completed', null);

    const afterRestart = database.makeStore();
    const seen = await readStream(afterRestart, runId, null);
    expect(seen).toMatchObject([{ id: 1n, type: 'assistant', data: { text: 'before restart' } }]);
    expect(seen[0]?.at).toBeInstanceOf(Date);

    // `runs.engine` round-trips through PostgreSQL (ADR-0065): the store that created the run is
    // gone, so this value can only have come from the row.
    const reread = await afterRestart.get(runId);
    expect(reread?.engine).toBe('claude-agent-sdk');
    expect(reread?.engineVersion ?? null).toBeNull();
  });

  it('upgrades pre-ENG-03 run_events rows on read, out of a real PostgreSQL log', async () => {
    const chain = await database.seedChain({
      workspace: 'Legacy upgrade',
      user: 'Runner',
      agent: 'Legacy upgrade agent',
    });
    const runId = crypto.randomUUID();
    const store = database.makeStore();
    await store.create(runInput(chain, runId));
    await store.markRunning(runId);
    await appendLegacyRows(store, runId);
    await store.finish(runId, 'completed', null);

    const handle = await store.openStream(runId, null);
    if (handle === null) throw new Error('the durable run was not found');
    const served: SseWireEvent[] = [];
    for await (const event of upgradeEventStream(handle.events, null)) served.push(event);

    // A legacy log serves only `agent.*` frames, and exactly the frames a fresh run of the same
    // messages produces — the replay refinement of `docs/formal/domains/d1-runs.md`, over rows that
    // really went through PostgreSQL rather than through an in-memory map.
    const fresh = LEGACY_MESSAGES.flatMap((message) => [
      ...toAgentFrames(classifySdkEvent(message)),
    ]);
    expect(served.map((event) => event.type)).toEqual(fresh.map((frame) => frame.frame));
    expect(served.map((event) => event.data)).toEqual(fresh);
    expect(served.map((event) => String(event.id))).toEqual(['1.0', '2.0', '2.1', '3.0']);
    for (const event of served) {
      expect(AgentFrameSchema.safeParse(event.data).success, event.type).toBe(true);
    }

    // And a resume that lands inside row 2 loses neither of its frames and repeats neither.
    const resumed = await store.openStream(runId, 1n);
    if (resumed === null) throw new Error('the durable run was not found on resume');
    const tail: SseWireEvent[] = [];
    for await (const event of upgradeEventStream(resumed.events, { sequence: 2n, subIndex: 0 })) {
      tail.push(event);
    }
    expect(tail.map((event) => String(event.id))).toEqual(['2.1', '3.0']);
  });

  it('delivers the terminal tail committed between event listing and the status read', async () => {
    const chain = await database.seedChain({
      workspace: 'Terminal tail',
      user: 'Runner',
      agent: 'Terminal tail agent',
    });
    const runId = crypto.randomUUID();
    const storeRef: { current?: RunStore } = {};
    const baseEvents = database.core.createDatabaseRunEventRepositoryProvider(database.db);
    const store = database.makeStore({ events: injectingTerminalTail(baseEvents, storeRef) });
    storeRef.current = store;
    await store.create(runInput(chain, runId));
    await store.markRunning(runId);

    const stream = await store.openStream(runId, null);
    if (stream === null) throw new Error('created run had no stream');
    const delivered: bigint[] = [];
    for await (const event of stream.events) delivered.push(event.id);
    expect(delivered).toEqual([1n]);
    expect((await store.get(runId))?.status).toBe('completed');
  });

  describeRunStoreConformance(
    'over a real PostgreSQL, against the same suite',
    async ({ maxEventsPerRun }) => {
      // The whole referential chain a `runs` row needs: workspace → user → membership → agent →
      // session. Fresh every time, so this fixture collides with nothing else on the server.
      const chain = await database.seedChain({
        workspace: 'Runs',
        user: 'Runner',
        agent: 'General',
      });

      const modelConnectionId = crypto.randomUUID();
      await database.db.insert(database.core.modelConnections).values({
        id: modelConnectionId,
        workspaceId: chain.workspaceId,
        name: 'Snapshot fixture connection',
        provider: 'anthropic',
        config: {},
      });

      return {
        store: database.makeStore(maxEventsPerRun === undefined ? {} : { maxEventsPerRun }),
        nextRun: (): CreateRunInput => runInput(chain, crypto.randomUUID()),
        modelConnectionId,
      };
    },
  );
});

// Both implementations run the same suite from this one file, which is what
// tests/store-conformance.test.ts checks for every memory store (F-13).
// ── The in-memory implementation ─────────────────────────────────────────────────────────────

describeRunStoreConformance('the in-memory run store', ({ maxEventsPerRun }) => {
  const workspaceId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  return Promise.resolve({
    store:
      maxEventsPerRun === undefined
        ? new InMemoryRunStore()
        : new InMemoryRunStore({ maxEventsPerRun }),
    nextRun: (): CreateRunInput => ({
      engine: 'claude-agent-sdk',
      id: crypto.randomUUID(),
      workspaceId,
      agentId,
      sessionId,
    }),
    // No referential integrity in this implementation, so any id will do.
    modelConnectionId: crypto.randomUUID(),
  });
});
