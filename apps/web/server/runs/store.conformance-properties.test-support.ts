/**
 * The two property-based topics of the run store conformance suite (see `store.conformance.ts`):
 * the model-based lifecycle run and the start-key run.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  IdempotencyKeyTakenError,
  isTerminalRunStatus,
  terminalRunStatuses,
  type RunRecord,
  type RunStore,
} from './store';
import type { ConformanceHarness } from './store.test-support';

export function describeProperties(harness: ConformanceHarness): void {
  describeLifecycleModel(harness);
  describeStartKeyModel(harness);
}

interface Model {
  status: RunRecord['status'];
  endedAt: Date | null;
  lastId: bigint;
}
interface Real {
  readonly store: RunStore;
  readonly runId: string;
}

/** The store's record of the run agrees with the model, and a terminal `endedAt` never moves. */
const settle = async (model: Model, real: Real): Promise<void> => {
  const record = await real.store.get(real.runId);
  expect(record?.status).toBe(model.status);
  if (!isTerminalRunStatus(model.status)) return;
  expect(record?.endedAt).toBeInstanceOf(Date);
  if (model.endedAt === null) model.endedAt = record?.endedAt ?? null;
  else expect(record?.endedAt).toEqual(model.endedAt);
};

const markRunningCommand: fc.AsyncCommand<Model, Real> = {
  check: () => true,
  async run(model, real) {
    expect(await real.store.markRunning(real.runId)).toBe(model.status === 'queued');
    if (model.status === 'queued') model.status = 'running';
    await settle(model, real);
  },
  toString: () => 'markRunning',
};

const finishCommand = (
  status: (typeof terminalRunStatuses)[number],
  emit: boolean,
): fc.AsyncCommand<Model, Real> => ({
  check: () => true,
  async run(model, real) {
    await real.store.finish(real.runId, status, status === 'completed' ? null : 'stopped', emit);
    if (!isTerminalRunStatus(model.status)) model.status = status;
    await settle(model, real);
  },
  toString: () => `finish(${status}, ${String(emit)})`,
});

const appendCommand = (data: number): fc.AsyncCommand<Model, Real> => ({
  check: () => true,
  async run(model, real) {
    const result = await real.store.append(real.runId, { type: 'assistant', data });
    if (isTerminalRunStatus(model.status)) {
      expect(result.kind).toBe('rejected');
    } else {
      if (result.kind !== 'appended') throw new Error(`append refused: ${result.reason}`);
      expect(result.event.id > model.lastId).toBe(true);
      model.lastId = result.event.id;
    }
    await settle(model, real);
  },
  toString: () => `append(${String(data)})`,
});

const lifecycleCommands = fc.commands(
  [
    fc.constant(markRunningCommand),
    fc
      .tuple(fc.constantFrom(...terminalRunStatuses), fc.boolean())
      .map(([s, e]) => finishCommand(s, e)),
    fc.integer({ min: 0, max: 99 }).map(appendCommand),
  ],
  { maxCommands: 12 },
);

/** The ids on a run's retained stream, read to its end. */
async function retainedIds(store: RunStore, runId: string): Promise<bigint[]> {
  const handle = await store.openStream(runId, null);
  if (handle === null) throw new Error('run had no event stream');
  const ids: bigint[] = [];
  for await (const event of handle.events) ids.push(event.id);
  return ids;
}

/**
 * F-21 property 10: a model-based run of arbitrary `markRunning` / `finish` / `append`
 * sequences against this implementation. A terminal status is absorbing (status and `endedAt`
 * never change again, and appends are refused), every appended id is greater than the last,
 * and the retained stream is strictly increasing and never longer than `maxEventsPerRun`. The
 * one-run-per-idempotency-key clause (F-09, ADR-0151) is the property after this one. On a
 * failure fast-check prints the seed and the command sequence.
 */
function describeLifecycleModel({ started }: ConformanceHarness): void {
  describe('model-based lifecycle (property)', () => {
    it('keeps terminal absorbing, ids increasing and retention within its bound', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 4 }),
          lifecycleCommands,
          async (max, sequence) => {
            const { store, run } = await started(max);
            const real: Real = { store, runId: run.id };
            const model: Model = { status: 'queued', endedAt: null, lastId: 0n };
            await fc.asyncModelRun(() => ({ model, real }), sequence);
            if (!isTerminalRunStatus(model.status)) await store.finish(run.id, 'completed', null);
            const ids = await retainedIds(store, run.id);
            expect(ids.length).toBeLessThanOrEqual(max);
            ids.slice(1).forEach((id, index) => expect(id > (ids[index] ?? id)).toBe(true));
          },
        ),
        { numRuns: 25 },
      );
    });
  });
}

/**
 * F-09 / ADR-0151: whatever sequence of starts reuses a small pool of keys, each key names
 * exactly one run — the first start's, with the first start's request hash — and every later
 * start under it is refused. Each run is finished before the next start, so the session is free
 * and only the key decides.
 */
function describeStartKeyModel({ make }: ConformanceHarness): void {
  type Held = { runId: string; requestHash: string };

  describe('start keys (property)', () => {
    it('gives each key exactly one run, the first one', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.constantFrom('h1', 'h2')), {
            maxLength: 8,
          }),
          async (starts) => {
            const fixture = await make({});
            const principalId = crypto.randomUUID();
            const model = new Map<string, Held>();
            let workspaceId = '';
            for (const [index, requestHash] of starts) {
              const key = `key-${String(index)}`;
              const run = {
                ...fixture.nextRun(),
                idempotency: { principalId, key, requestHash },
              };
              workspaceId = run.workspaceId;
              const held = model.get(key);
              if (held !== undefined) {
                await expect(fixture.store.create(run)).rejects.toThrow(IdempotencyKeyTakenError);
                continue;
              }
              await fixture.store.create(run);
              await fixture.store.finish(run.id, 'completed', null);
              model.set(key, { runId: run.id, requestHash });
            }
            for (const [key, held] of model) {
              const found = await fixture.store.findByIdempotencyKey(workspaceId, principalId, key);
              expect({ runId: found?.run.id, requestHash: found?.requestHash }).toEqual(held);
            }
          },
        ),
        { numRuns: 20 },
      );
    });
  });
}
