import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { fakeConnection, runRequestBody } from './server-fixture.test-support.js';
import { runWithReference, sha256 } from './server-reference-fixture.test-support.js';
import { createRunnerServer } from './server.js';

import type { ReferenceGates } from './server-reference-fixture.test-support.js';
export function registerFileReferencesTests(gates: ReferenceGates): void {
  const { verifyGate } = gates;
  it('[US-STO-06][contract][run] a reference whose sha256 does not match the hydrated file answers 422 run_file_checksum_mismatch and never starts the engine', async () => {
    const answer = await runWithReference('what arrived', {
      size: 'what arrived'.length,
      sha256: sha256('what was granted'),
    });
    expect(answer.status).toBe(422);
    expect(answer.body).toEqual({
      error: 'run_file_checksum_mismatch',
      message: 'granted file "reports/q3.txt" did not arrive intact',
    });
    expect(answer.started).toBe(0);
  });

  it('[US-STO-06][contract][run] a reference to a file that did not arrive answers 422 run_file_missing and never starts the engine', async () => {
    const answer = await runWithReference(null, { size: 4, sha256: sha256('gone') });
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: 'run_file_missing' });
    expect(answer.started).toBe(0);
  });

  it('[US-STO-06][contract][run] a matching reference starts the engine', async () => {
    const answer = await runWithReference('as granted', {
      size: 'as granted'.length,
      sha256: sha256('as granted'),
    });
    expect(answer.status).toBe(200);
    expect(answer.started).toBe(1);
  });

  it('[US-STO-06][contract][run] an interrupt that arrives while references are verified ends the run without starting the engine', async () => {
    let release: () => void = () => undefined;
    verifyGate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const server = createRunnerServer({
      startAgent: () => {
        started += 1;
        return Promise.resolve({ ok: true, connection: fakeConnection([]) });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const base = `http://127.0.0.1:${String(address.port)}`;
    const runId = 'cccccccc-3333-4333-8333-333333333333';
    const cwd = await mkdtemp(path.join(tmpdir(), 'w3-runner-reference-'));
    await writeFile(path.join(cwd, 'notes.txt'), 'granted');
    try {
      const response = fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(runRequestBody(runId, 'dddddddd-4444-4444-8444-444444444444') as Record<
            string,
            unknown
          >),
          cwd,
          resources: {
            files: [
              {
                kind: 'file',
                path: 'notes.txt',
                access: 'read',
                size: 'granted'.length,
                sha256: sha256('granted'),
              },
            ],
            skills: [],
          },
        }),
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

      release();
      const body = await (await response).text();
      expect([...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1])).toEqual(['run-interrupted']);
      expect(started).toBe(0);
    } finally {
      release();
      verifyGate.hold = Promise.resolve();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('[US-STO-06][contract][run] a reference into the engine protected config directory answers 422 run_file_missing even when its bytes match', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'w3-runner-reference-'));
    await mkdir(path.join(cwd, '.claude'));
    await writeFile(path.join(cwd, '.claude', 'settings.json'), 'private');
    let started = 0;
    const server = createRunnerServer({
      startAgent: () => {
        started += 1;
        return Promise.resolve({ ok: true, connection: fakeConnection([]) });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    try {
      const response = await fetch(`http://127.0.0.1:${String(address.port)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(runRequestBody(
            'eeeeeeee-5555-4555-8555-555555555555',
            'ffffffff-6666-4666-8666-666666666666',
          ) as Record<string, unknown>),
          cwd,
          resources: {
            files: [
              {
                kind: 'file',
                path: '.claude/settings.json',
                access: 'read',
                size: 'private'.length,
                sha256: sha256('private'),
              },
            ],
            skills: [],
          },
        }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: 'run_file_missing' });
      expect(started).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
