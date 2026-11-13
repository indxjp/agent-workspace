import { type EngineFrame } from '@agent-workspace/engine';
import { toAgentFrames } from '@agent-workspace/run-protocol';
import { describe, expect, it } from 'vitest';
import type { RunnerAgentConnection } from './runtime.js';
import { fakeCleanlyCancellingConnection, runRequestBody } from './server-fixture.test-support.js';
import { createRunnerServer } from './server.js';

export function registerInterruptsTests(): void {
  describe('run-bound interrupts', () => {
    it('does not let a delayed interrupt for an old run cancel the current run', async () => {
      const controller = new AbortController();
      let interruptCalls = 0;
      const connection: RunnerAgentConnection = {
        frames: (async function* (): AsyncGenerator<EngineFrame> {
          yield* toAgentFrames({ kind: 'malformed', reason: 'fixture event', event: {} });
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        })(),
        sessionId: Promise.resolve('99999999-9999-4999-8999-999999999999'),
        interrupt: () => {
          interruptCalls += 1;
          controller.abort();
          return Promise.resolve();
        },
        sessionDurability: () => ({ durable: false, reason: 'test fixture' }),
        engineVersion: '0.0.0-test',
      };
      const server = createRunnerServer({
        startAgent: () => Promise.resolve({ ok: true, connection }),
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const base = `http://127.0.0.1:${String(address.port)}`;
      const currentRunId = '55555555-5555-4555-8555-555555555555';
      try {
        const runResponsePromise = fetch(`${base}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            runRequestBody(currentRunId, '66666666-6666-4666-8666-666666666666'),
          ),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        const stale = await fetch(`${base}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: '77777777-7777-4777-8777-777777777777' }),
        });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({ error: 'run_mismatch' });
        expect(interruptCalls).toBe(0);

        const matching = await fetch(`${base}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: currentRunId }),
        });
        expect(matching.status).toBe(202);
        expect(interruptCalls).toBe(1);
        await (await runResponsePromise).text();
      } finally {
        controller.abort();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('runs independent sessions concurrently and interrupts only the named run', async () => {
      const controllers = new Map<string, AbortController>();
      const interruptCalls: string[] = [];
      const server = createRunnerServer({
        maxConcurrentRuns: 2,
        startAgent: (request) => {
          const controller = new AbortController();
          controllers.set(request.runId, controller);
          return Promise.resolve({
            ok: true as const,
            connection: {
              frames: (async function* (): AsyncGenerator<EngineFrame> {
                yield* toAgentFrames({ kind: 'malformed', reason: request.runId, event: {} });
                if (!controller.signal.aborted) {
                  await new Promise<void>((resolve) =>
                    controller.signal.addEventListener('abort', () => resolve(), { once: true }),
                  );
                }
              })(),
              sessionId: Promise.resolve(request.sessionId),
              interrupt: () => {
                interruptCalls.push(request.runId);
                controller.abort();
                return Promise.resolve();
              },
              sessionDurability: () => ({ durable: false, reason: 'test fixture' }),
              engineVersion: '0.0.0-test',
            },
          });
        },
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const base = `http://127.0.0.1:${String(address.port)}`;
      const first = '11111111-aaaa-4111-8111-111111111111';
      const second = '22222222-bbbb-4222-8222-222222222222';
      try {
        const firstResponse = fetch(`${base}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(runRequestBody(first, '33333333-aaaa-4333-8333-333333333333')),
        });
        const secondResponse = fetch(`${base}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(runRequestBody(second, '44444444-bbbb-4444-8444-444444444444')),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        const health = await fetch(`${base}/healthz`);
        expect(await health.json()).toMatchObject({ activeRuns: 2, capacity: 2, available: 0 });

        const firstInterrupt = await fetch(`${base}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: first }),
        });
        expect(firstInterrupt.status).toBe(202);
        await (await firstResponse).text();
        expect(interruptCalls).toEqual([first]);
        expect(controllers.get(second)?.signal.aborted).toBe(false);

        const afterFirst = await fetch(`${base}/healthz`);
        expect(await afterFirst.json()).toMatchObject({ activeRuns: 1, available: 1 });
        const secondInterrupt = await fetch(`${base}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: second }),
        });
        expect(secondInterrupt.status).toBe(202);
        await (await secondResponse).text();
        expect(interruptCalls).toEqual([first, second]);
      } finally {
        for (const controller of controllers.values()) controller.abort();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('returns explicit backpressure when bounded capacity is exhausted', async () => {
      const connection = fakeCleanlyCancellingConnection();
      const server = createRunnerServer({
        startAgent: () => Promise.resolve({ ok: true, connection }),
        maxConcurrentRuns: 1,
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const base = `http://127.0.0.1:${String(address.port)}`;
      const first = '55555555-aaaa-4555-8555-555555555555';
      try {
        const firstResponse = fetch(`${base}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(runRequestBody(first, '66666666-aaaa-4666-8666-666666666666')),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        const refused = await fetch(`${base}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            runRequestBody(
              '77777777-bbbb-4777-8777-777777777777',
              '88888888-bbbb-4888-8888-888888888888',
            ),
          ),
        });
        expect(refused.status).toBe(429);
        expect(await refused.json()).toMatchObject({ error: 'runner_capacity_exhausted' });
        await fetch(`${base}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: first }),
        });
        await (await firstResponse).text();
      } finally {
        await connection.interrupt();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('refuses a second run for the same session even when capacity remains', async () => {
      const connection = fakeCleanlyCancellingConnection();
      const server = createRunnerServer({
        startAgent: () => Promise.resolve({ ok: true, connection }),
        maxConcurrentRuns: 8,
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const base = `http://127.0.0.1:${String(address.port)}`;
      const sessionId = '99999999-cccc-4999-8999-999999999999';
      const first = 'aaaaaaaa-1111-4aaa-8aaa-111111111111';
      const second = 'bbbbbbbb-2222-4bbb-8bbb-222222222222';
      try {
        const firstResponse = fetch(`${base}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(runRequestBody(first, sessionId)),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        // Same session, a different run id: this must be refused outright even though there is
        // ample spare capacity, because both runs would share the one session-scoped `cwd`.
        const refused = await fetch(`${base}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(runRequestBody(second, sessionId)),
        });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({
          error: 'session_in_flight',
          message: expect.stringContaining(first) as unknown,
        });

        const health = await fetch(`${base}/healthz`);
        expect(await health.json()).toMatchObject({ activeRuns: 1 });

        await fetch(`${base}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: first }),
        });
        await (await firstResponse).text();
      } finally {
        await connection.interrupt();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
}
