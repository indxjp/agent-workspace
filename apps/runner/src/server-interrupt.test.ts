/**
 * The runner raises two cancellations without awaiting them — on the client's `close`, and for an
 * interrupt that arrived while the engine was starting. An engine whose `interrupt()` rejects must
 * cost one stderr line, not the process: the runtime serves several runs, and an unhandled
 * rejection would end every one of them. The package's test target runs with
 * `--unhandled-rejections=strict`, so a regression here fails the run.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { toAgentFrames } from '@agent-workspace/core';
import type { EngineFrame } from '@agent-workspace/engine';

import { installedEngines } from './engines.js';
import { createRunnerServer } from './server.js';
import type { EngineStartOutcome, RunnerAgentConnection } from './runtime.js';

// `/healthz` lists the installed engines, so its first request imports every adapter package; pay
// that once here rather than inside a test's own budget.
beforeAll(async () => {
  await installedEngines();
}, 60_000);

const RUN_ID = '55555555-5555-4555-8555-555555555555';
const SESSION_ID = '66666666-6666-4666-8666-666666666666';

function runRequestBody(runId: string, sessionId: string): unknown {
  return {
    runId,
    sessionId,
    cwd: '/tmp/aw-server-test',
    prompt: 'irrelevant — startAgent is replaced',
    projectKey: 'server-test',
    portable: {
      name: 'General',
      instructions: '',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: 1, maxBudgetUsd: null },
    },
    policy: { tools: null, fileGrantDeny: [] },
    session: { kind: 'fresh', sessionId },
    env: {},
  };
}

/** Yields one frame, then waits until `release()`; `interrupt()` always rejects. */
function stuckConnection(): {
  readonly connection: RunnerAgentConnection;
  readonly interrupt: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly release: () => void;
} {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const interrupt = vi.fn<() => Promise<void>>(() =>
    Promise.reject(new Error('engine refused the interrupt')),
  );
  const connection: RunnerAgentConnection = {
    frames: (async function* (): AsyncGenerator<EngineFrame> {
      yield* toAgentFrames({ kind: 'malformed', reason: 'fixture event', event: {} });
      await released;
    })(),
    sessionId: Promise.resolve('99999999-9999-4999-8999-999999999999'),
    interrupt,
    sessionDurability: () => ({ durable: false, reason: 'test fixture' }),
    engineVersion: '0.0.0-test',
  };
  return { connection, interrupt, release };
}

async function withServer(
  startAgent: () => Promise<EngineStartOutcome>,
  release: () => void,
  use: (base: string) => Promise<void>,
): Promise<void> {
  const server = createRunnerServer({ startAgent });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    await use(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    release();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
}

function post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

describe('a rejecting background interrupt', () => {
  const stderr = vi.spyOn(process.stderr, 'write');
  const stderrText = (): string => stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
  const logged = `runner: interrupting run ${RUN_ID} failed: engine refused the interrupt`;

  afterEach(() => {
    stderr.mockReset();
  });

  it('keeps serving after a background interrupt rejects', async () => {
    stderr.mockImplementation(() => true);
    const { connection, interrupt, release } = stuckConnection();
    await withServer(
      () => Promise.resolve({ ok: true, connection }),
      release,
      async (base) => {
        const abort = new AbortController();
        const response = await post(
          `${base}/run`,
          runRequestBody(RUN_ID, SESSION_ID),
          abort.signal,
        );
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error('no body');
        await reader.read();
        abort.abort();

        await expect.poll(() => interrupt.mock.calls.length).toBe(1);
        await expect.poll(stderrText).toContain(logged);
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
      },
    );
  });

  it('keeps serving when an interrupt that arrived during start rejects', async () => {
    stderr.mockImplementation(() => true);
    const { connection, interrupt, release } = stuckConnection();
    let started: (outcome: EngineStartOutcome) => void = () => undefined;
    const start = new Promise<EngineStartOutcome>((resolve) => {
      started = resolve;
    });
    await withServer(
      () => start,
      release,
      async (base) => {
        const abort = new AbortController();
        const running = post(`${base}/run`, runRequestBody(RUN_ID, SESSION_ID), abort.signal);
        await expect
          .poll(async () => {
            const health = (await (await fetch(`${base}/healthz`)).json()) as {
              activeRuns: number;
            };
            return health.activeRuns;
          })
          .toBe(1);

        const interrupted = await post(`${base}/interrupt`, { runId: RUN_ID });
        expect(interrupted.status).toBe(202);
        started({ ok: true, connection });

        await expect.poll(() => interrupt.mock.calls.length).toBe(1);
        await expect.poll(stderrText).toContain(logged);
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
        abort.abort();
        await running.catch(() => undefined);
      },
    );
  });
});
