import { createJsonLogger } from '@agent-workspace/core/telemetry';
import { EngineRefusalError } from '@agent-workspace/engine';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeConnection, runRequestBody } from './server-fixture.test-support.js';
import { createRunnerServer } from './server.js';

export function registerRunFailuresTests(): void {
  describe('run admission log (F-04)', () => {
    it('writes one JSON line joined to the caller trace', async () => {
      const lines: Record<string, unknown>[] = [];
      const server = createRunnerServer({
        startAgent: () => Promise.resolve({ ok: true, connection: fakeConnection([]) }),
        logger: createJsonLogger({
          service: 'runner',
          write: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
        }),
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      try {
        const runId = '55555555-5555-4555-8555-555555555555';
        const response = await fetch(`http://127.0.0.1:${String(address.port)}/run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          },
          body: JSON.stringify(runRequestBody(runId, '66666666-6666-4666-8666-666666666666')),
        });
        await response.text();
        expect(lines).toEqual([
          expect.objectContaining({
            level: 'info',
            service: 'runner',
            msg: 'run admitted',
            runId,
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          }),
        ]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('a start that throws', () => {
    it('[US-STO-06][contract][run] answers 422 run_rejected without the host path and logs the cause', async () => {
      const lines: Record<string, unknown>[] = [];
      const hostPath = path.join(tmpdir(), `aw-host-${randomUUID()}`, '.claude');
      const server = createRunnerServer({
        startAgent: () =>
          Promise.reject(new Error(`EACCES: permission denied, mkdir '${hostPath}'`)),
        logger: createJsonLogger({
          service: 'runner',
          write: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
        }),
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      try {
        const response = await fetch(`http://127.0.0.1:${String(address.port)}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            runRequestBody(
              '77777777-7777-4777-8777-777777777777',
              '88888888-8888-4888-8888-888888888888',
            ),
          ),
        });
        const text = await response.text();
        expect(response.status).toBe(422);
        expect(JSON.parse(text)).toEqual({
          error: 'run_rejected',
          message: 'the runtime could not start this run',
        });
        expect(text).not.toContain(hostPath);
        expect(lines).toContainEqual(
          expect.objectContaining({ level: 'error', msg: 'run start failed' }),
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('a start the engine refuses', () => {
    it('[US-STO-06][contract][run] answers the refusal code and message before any frame, not run_rejected', async () => {
      const message = 'the compiled options carry a `tools` value this boundary cannot translate.';
      const server = createRunnerServer({
        startAgent: () => Promise.reject(new EngineRefusalError('engine_policy_invalid', message)),
        logger: createJsonLogger({ service: 'runner', write: () => undefined }),
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      try {
        const response = await fetch(`http://127.0.0.1:${String(address.port)}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            runRequestBody(
              '77777777-7777-4777-8777-777777777777',
              '88888888-8888-4888-8888-888888888888',
            ),
          ),
        });
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).not.toContain('run_rejected');
        const data = text.split('event: run-error')[1] ?? '';
        const payload = JSON.parse(data.slice(data.indexOf('{'), data.lastIndexOf('}') + 1)) as {
          code: string;
          message: string;
          events: number;
        };
        expect(payload).toMatchObject({ code: 'engine_policy_invalid', message, events: 0 });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
}
