import { describe, expect, it } from 'vitest';
import type { EngineStartOutcome } from './runtime.js';
import { fakeCleanlyCancellingConnection, runRequestBody } from './server-fixture.test-support.js';
import { createRunnerServer, parseMaxConcurrentRuns } from './server.js';

export function registerAdmissionTests(): void {
  describe('admission while the engine is still starting (ENG-04 review)', () => {
    it('holds the slot across the awaited start, so overlapping runs cannot both pass admission', async () => {
      // The engine load is asynchronous: `startAgent` is held open on a promise this test controls,
      // so the first run is admitted but has not started when the next two requests arrive. Before
      // the reservation, both passed every check because the first was not yet in the map.
      let releaseStart: (outcome: EngineStartOutcome) => void = () => undefined;
      const started: string[] = [];
      const server = createRunnerServer({
        startAgent: (request) => {
          started.push(request.runId);
          return new Promise<EngineStartOutcome>((resolve) => {
            releaseStart = resolve;
          });
        },
        maxConcurrentRuns: 1,
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const base = `http://127.0.0.1:${String(address.port)}`;
      const sessionId = 'cccccccc-3333-4ccc-8ccc-333333333333';
      const first = 'dddddddd-4444-4ddd-8ddd-444444444444';
      const post = (runId: string, session: string): Promise<Response> =>
        fetch(`${base}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(runRequestBody(runId, session)),
        });
      try {
        const firstResponse = post(first, sessionId);
        while (started.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 5));

        const sameSession = await post('eeeeeeee-5555-4eee-8eee-555555555555', sessionId);
        expect(sameSession.status).toBe(409);
        expect(await sameSession.json()).toMatchObject({ error: 'session_in_flight' });

        const overCapacity = await post(
          'ffffffff-6666-4fff-8fff-666666666666',
          '12121212-7777-4121-8121-777777777777',
        );
        expect(overCapacity.status).toBe(429);
        expect(await overCapacity.json()).toMatchObject({ error: 'runner_capacity_exhausted' });

        const duplicate = await post(first, '34343434-8888-4343-8343-888888888888');
        expect(duplicate.status).toBe(409);
        expect(await duplicate.json()).toMatchObject({ error: 'run_in_flight' });

        expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ activeRuns: 1 });
        expect(started).toEqual([first]);

        releaseStart({ ok: false, code: 'engine_not_installed', reason: 'released by the test' });
        await (await firstResponse).text();
        // The refusal path released the reservation, so the slot is free again.
        expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ activeRuns: 0 });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
    it('applies an interrupt that arrives while the engine is still starting', async () => {
      let releaseStart: (outcome: EngineStartOutcome) => void = () => undefined;
      const server = createRunnerServer({
        startAgent: () =>
          new Promise<EngineStartOutcome>((resolve) => {
            releaseStart = resolve;
          }),
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const base = `http://127.0.0.1:${String(address.port)}`;
      const runId = '56565656-9999-4565-8565-999999999999';
      try {
        const response = fetch(`${base}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(runRequestBody(runId, '78787878-aaaa-4787-8787-aaaaaaaaaaaa')),
        });
        const activeRuns = async (): Promise<unknown> =>
          ((await (await fetch(`${base}/healthz`)).json()) as { activeRuns: unknown }).activeRuns;
        while ((await activeRuns()) !== 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        const interrupt = await fetch(`${base}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId }),
        });
        expect(interrupt.status).toBe(202);

        releaseStart({ ok: true, connection: fakeCleanlyCancellingConnection() });
        const body = await (await response).text();
        expect([...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]).at(-1)).toBe(
          'run-interrupted',
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('MAX_CONCURRENT_RUNS', () => {
    it('uses a bounded default and accepts explicit capacity', () => {
      expect(parseMaxConcurrentRuns(undefined)).toBe(8);
      expect(parseMaxConcurrentRuns(' 16 ')).toBe(16);
    });

    it.each(['0', '-1', '1.5', '1025', 'many'])('rejects unsafe capacity %s', (value) => {
      expect(() => parseMaxConcurrentRuns(value)).toThrow(/MAX_CONCURRENT_RUNS/u);
    });
  });
}
