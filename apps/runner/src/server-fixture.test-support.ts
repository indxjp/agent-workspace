import { type EngineFrame } from '@agent-workspace/engine';
import { toAgentFrames, type ClassifiedSdkEvent } from '@agent-workspace/run-protocol';
import { expect } from 'vitest';
import type { RunnerAgentConnection } from './runtime.js';
import { createRunnerServer } from './server.js';
/** A `RunRequest` known to satisfy the real schema — the exact shape a live probe validated. */
export function runRequestBody(runId: string, sessionId: string): unknown {
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

/** A connection that yields the given events, then ends — successfully or not. */
export function fakeConnection(
  events: readonly ClassifiedSdkEvent[],
  options: { readonly fails?: boolean } = {},
): RunnerAgentConnection {
  return {
    frames: (async function* (): AsyncGenerator<EngineFrame> {
      // A microtask tick, so this is genuinely async rather than a sync generator wearing an
      // `AsyncIterable` type — real events arrive after awaits too.
      await Promise.resolve();
      for (const event of events) for (const frame of toAgentFrames(event)) yield frame;
      if (options.fails === true) throw new Error('the fixture SDK run failed');
    })(),
    sessionId: Promise.resolve('99999999-9999-4999-8999-999999999999'),
    interrupt: (): Promise<void> => Promise.resolve(),
    sessionDurability: () => ({ durable: false, reason: 'test fixture' }),
    engineVersion: '0.0.0-test',
  };
}

/** Start a server backed by `connection` on an ephemeral port, POST one run, return the frames. */
export async function runOnce(
  connection: RunnerAgentConnection,
): Promise<{ readonly names: string[]; readonly body: string }> {
  const server = createRunnerServer({
    startAgent: () => Promise.resolve({ ok: true, connection }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    const runId = '11111111-1111-4111-8111-111111111111';
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runRequestBody(runId, '22222222-2222-4222-8222-222222222222')),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    const names = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1] ?? '');
    return { names, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * A connection whose `events` generator ends **cleanly** — no throw — once cancelled. This is the
 * conformant shape `packages/runtime/src/driver.ts`'s `AgentConnection` allows: `interrupt()` is
 * `AbortController.abort()` (see `runtime.ts`), and nothing in that contract requires the
 * generator to throw on abort rather than simply returning. W1-RN-03's bug reached only the
 * connections that *do* throw, because the old code nested the `run.interrupted` check inside
 * `failure === null ? … : …` — a connection like this one, whose stream ends with `failure` still
 * `null`, was reported `run-done` even though it was cancelled out from under it.
 */
export function fakeCleanlyCancellingConnection(): RunnerAgentConnection {
  const controller = new AbortController();
  return {
    frames: (async function* (): AsyncGenerator<EngineFrame> {
      await Promise.resolve();
      yield* toAgentFrames({ kind: 'malformed', reason: 'fixture event', event: {} });
      // Wait for `interrupt()` to fire, then end the iterable cleanly — no throw — rather than
      // yielding another event or raising an error.
      if (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    })(),
    sessionId: Promise.resolve('99999999-9999-4999-8999-999999999999'),
    interrupt: (): Promise<void> => {
      controller.abort();
      return Promise.resolve();
    },
    sessionDurability: () => ({ durable: false, reason: 'test fixture' }),
    engineVersion: '0.0.0-test',
  };
}

/**
 * Start a server backed by `connection`, POST one run, POST /interrupt once it is under way, and
 * return the frames of the (now-cancelled) run's own SSE stream.
 */
export async function runThenInterrupt(
  connection: RunnerAgentConnection,
): Promise<{ readonly names: string[]; readonly body: string }> {
  const server = createRunnerServer({
    startAgent: () => Promise.resolve({ ok: true, connection }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    const runId = '33333333-3333-4333-8333-333333333333';
    const runPromise = fetch(`http://127.0.0.1:${String(address.port)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runRequestBody(runId, '44444444-4444-4444-8444-444444444444')),
    });
    // Give the run a moment to be accepted and emit its first event before interrupting it —
    // `POST /interrupt` requires a `state.current` run to already be recorded.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const interruptResponse = await fetch(`http://127.0.0.1:${String(address.port)}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    });
    expect(interruptResponse.status).toBe(202);
    const response = await runPromise;
    expect(response.status).toBe(200);
    const body = await response.text();
    const names = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1] ?? '');
    return { names, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
