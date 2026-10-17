/**
 * `apps/runner/src/server.ts` had no test file at all before W1-COMP-01. That is why the defect
 * this file exists to pin — the runner's own terminal frame colliding with the control plane's
 * reserved SSE names — survived every wave up to and including the one that built both halves:
 * `apps/web`'s relay was tested against `fake-runner.mjs`, which never sends a terminal frame,
 * and this file's own `streamRun` was never driven by a test at all. See
 * `docs/adr/W1-COMP-01-the-runners-own-terminal-frame-collided-with-the-relays-reserved-names.md`.
 *
 * These two tests exercise exactly the seam {@link RunnerServerOptions.startAgent}'s own
 * documentation names — "so the contract can be exercised end to end … without an Anthropic
 * credential" — over a real socket, with real SSE framing, and assert the two wire names a
 * consumer downstream (`apps/web/server/runs/relay.ts`) depends on by name.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { toAgentFrames, type ClassifiedSdkEvent } from '@agent-workspace/core';
import type { EngineFrame } from '@agent-workspace/engine';
import { decodeUstar } from '@agent-workspace/runtime';

import { createRunnerServer, parseMaxConcurrentRuns } from './server.js';
import { collectWorkspace } from './files.js';
import { installedEngines } from './engines.js';
import type { EngineStartOutcome, RunnerAgentConnection } from './runtime.js';

// `/healthz` lists the installed engines, so the first request imports every adapter package (four
// agent SDKs, seconds on a loaded CI runner). That import is paid once here, outside any test's own
// budget; the adapters are cached for the rest of the file.
beforeAll(async () => {
  await installedEngines();
}, 60_000);

/** A `RunRequest` known to satisfy the real schema — the exact shape a live probe validated. */
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

/** A connection that yields the given events, then ends — successfully or not. */
function fakeConnection(
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
async function runOnce(
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
function fakeCleanlyCancellingConnection(): RunnerAgentConnection {
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
async function runThenInterrupt(
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

describe('the terminal frame createRunnerServer sends at the end of every run', () => {
  it('is named `run-done` on success — not `done`, which the control plane reserves', async () => {
    const { names, body } = await runOnce(
      fakeConnection([{ kind: 'malformed', reason: 'fixture event', event: {} }]),
    );
    expect(names).toEqual(['agent.malformed', 'run-done']);
    expect(names).not.toContain('done');
    // The summary object is still there for a direct §14.3 consumer to read.
    expect(body).toContain('"runId":"11111111-1111-4111-8111-111111111111"');
  });

  it('is named `run-error` on failure — not `run-failed`, which the control plane reserves', async () => {
    const { names, body } = await runOnce(fakeConnection([], { fails: true }));
    expect(names).toEqual(['run-error']);
    expect(names).not.toContain('run-failed');
    expect(body).toContain('the fixture SDK run failed');
  });

  // W1-RN-03: `run.interrupted` must be decided FIRST and unconditionally (ADR-0015) — from the
  // positive fact the run already holds — not nested under `failure === null ? … : …`, which only
  // reaches the interrupted check when the connection also threw. This reproduces the reviewer's
  // finding directly: an `AgentConnection` whose `events` iterable ends cleanly (no throw) on
  // cancel is a conformant shape per `packages/runtime/src/driver.ts`, and must still be reported
  // `run-interrupted`, not `run-done`.
  it(
    'is named `run-interrupted` — not `run-done` — for a run whose events end cleanly ' +
      '(no throw) after POST /interrupt',
    async () => {
      const { names, body } = await runThenInterrupt(fakeCleanlyCancellingConnection());
      expect(names).toEqual(['agent.malformed', 'run-interrupted']);
      expect(names).not.toContain('run-done');
      expect(body).toContain('"interrupted":true');
    },
  );
});

/**
 * ENG-03 (#302): the runner streams one engine-neutral vocabulary.
 *
 * What is asserted is the *acceptance criterion* rather than the mapping — the mapping's own cases
 * live with it in `packages/core/src/agent-frames.test.ts`. Here: only `agent.*` names reach the
 * wire, none of the pre-ENG-03 relayed names does, one SDK message may become several frames, and
 * every frame gets its own monotonic `id` so a resume cursor can name any of them.
 */
describe('the event vocabulary createRunnerServer streams', () => {
  const assistantWithTwoTools: ClassifiedSdkEvent = {
    kind: 'event',
    type: 'assistant',
    event: {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: '/a' } },
          { type: 'tool_use', id: 'tool_2', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
  };

  it('names every relayed frame `agent.*`, and none of the pre-ENG-03 names', async () => {
    const { names, body } = await runOnce(
      fakeConnection([
        {
          kind: 'system',
          subtype: 'init',
          event: { type: 'system', subtype: 'init', session_id: 's1' },
        },
        assistantWithTwoTools,
        {
          kind: 'result',
          subtype: 'success',
          carriesUsage: true,
          event: { type: 'result', subtype: 'success' },
        },
      ]),
    );
    expect(names).toEqual([
      'agent.session',
      'agent.message',
      'agent.tool.call',
      'agent.tool.call',
      'agent.result',
      'run-done',
    ]);
    // Stated as the grammar rather than as a list of the old names: every relayed frame is an
    // `agent.*` one, so no pre-ENG-03 name can reach the wire and nor can a future one nobody chose.
    for (const name of names.slice(0, -1)) expect(name).toMatch(/^agent\.[a-z.]+$/);
    // The neutral fields are on the wire, and the engine-native message travels with them.
    expect(body).toContain('"engineSessionId":"s1"');
    expect(body).toContain('"engine":"claude-agent-sdk"');
    expect(body).toContain('"raw":');
  });

  it('gives each frame of a multi-frame message its own monotonic id', async () => {
    const { body } = await runOnce(fakeConnection([assistantWithTwoTools]));
    const ids = [...body.matchAll(/^id: (.+)$/gm)].map((m) => Number(m[1] ?? ''));
    // Three frames from one message, then the terminal frame: ids are per frame, because `id` is
    // the resume cursor and a cursor naming a message could not resume in the middle of one.
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it('reports how many frames it wrote, which is what this server can honestly count', async () => {
    // Before ENG-04 this counted engine *messages*, because the one-to-many mapping happened in
    // this server. It happens in the adapter now, so one assistant turn with two tool calls
    // arrives here as three frames and is reported as three.
    const { body } = await runOnce(fakeConnection([assistantWithTwoTools]));
    expect(body).toContain('"events":3');
  });
});

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
        body: JSON.stringify(runRequestBody(currentRunId, '66666666-6666-4666-8666-666666666666')),
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
      expect([...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]).at(-1)).toBe('run-interrupted');
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

describe('the section 14.3 file endpoints', () => {
  it('hydrates a tar under the configured workspace and collects it back', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-files-http-'));
    const source = path.join(root, 'source');
    const workspace = path.join(root, 'workspace');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'hello.txt'), 'hello through HTTP\n');
    const archive = await collectWorkspace(source, ['hello.txt']);
    const server = createRunnerServer({ workspacePath: workspace });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    try {
      const posted = await fetch(`http://127.0.0.1:${String(address.port)}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-tar' },
        body: archive.buffer.slice(
          archive.byteOffset,
          archive.byteOffset + archive.byteLength,
        ) as ArrayBuffer,
      });
      expect(posted.status).toBe(200);
      expect(await readFile(path.join(workspace, 'hello.txt'), 'utf8')).toBe(
        'hello through HTTP\n',
      );

      const collected = await fetch(
        `http://127.0.0.1:${String(address.port)}/files?path=hello.txt`,
      );
      expect(collected.status).toBe(200);
      expect(collected.headers.get('content-type')).toBe('application/x-tar');
      const entries = decodeUstar(new Uint8Array(await collected.arrayBuffer()));
      expect(Buffer.from(entries[0]?.data ?? []).toString('utf8')).toBe('hello through HTTP\n');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
