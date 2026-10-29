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
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createJsonLogger, type Logger } from '@agent-workspace/core/telemetry';
import { SpanKind, startTracing } from '@agent-workspace/core/tracing';
import { toAgentFrames, type ClassifiedSdkEvent } from '@agent-workspace/run-protocol';
import { EngineRefusalError, type EngineFrame } from '@agent-workspace/engine';
import {
  decodeUstar,
  encodeUstar,
  encodeUstarStream,
  RUN_FILES_MAX_BYTES,
} from '@agent-workspace/runtime/transfer';

import { generatedBody, MiB, peakRssGrowth } from '../../../tests/load/flat-memory.js';
import { createRunnerServer, parseMaxConcurrentRuns } from './server.js';
import { collectWorkspace } from './files.js';
import { installedEngines } from './engines.js';
import type { EngineStartOutcome, RunnerAgentConnection } from './runtime.js';

// The real verifier, held at a gate a test can close, so "interrupted while hashing" is not a race;
// `after` runs once it has answered, so "changed after verification" is not a race either.
const verifyGate = vi.hoisted(
  (): { hold: Promise<void>; after: (cwd: string) => Promise<void> } => ({
    hold: Promise.resolve(),
    after: () => Promise.resolve(),
  }),
);
vi.mock('./verify-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verify-files.js')>();
  return {
    ...actual,
    verifyReferencedFiles: async (
      ...args: Parameters<typeof actual.verifyReferencedFiles>
    ): ReturnType<typeof actual.verifyReferencedFiles> => {
      await verifyGate.hold;
      const verification = await actual.verifyReferencedFiles(...args);
      await verifyGate.after(args[0]);
      return verification;
    },
  };
});

// Set to make the skill inbox removal throw, as a filesystem fault would, naming the host path.
const inboxRemoval = vi.hoisted((): { fail: boolean } => ({ fail: false }));
vi.mock('./resources.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resources.js')>();
  return {
    ...actual,
    removeSkillInbox: (...args: Parameters<typeof actual.removeSkillInbox>): void => {
      if (inboxRemoval.fail) throw new Error(`EACCES: permission denied, rmdir '${args[0]}'`);
      actual.removeSkillInbox(...args);
    },
  };
});

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

describe('a run that stopped for want of approval (ADR-0145 D5)', () => {
  const asked = {
    toolName: 'Write',
    toolUseId: 'toolu_9',
    canonicalCall: '{"input":{"path":"SECRET-ARGUMENT"},"name":"Write"}',
  };

  it('ends as run-error carrying awaiting_approval and the call, with a message that omits its arguments', async () => {
    const { names, body } = await runOnce({ ...fakeConnection([]), approvalRequest: () => asked });
    expect(names.at(-1)).toBe('run-error');
    const data = body.split('event: run-error')[1] ?? '';
    const frame = JSON.parse(data.slice(data.indexOf('data: ') + 6).split('\n')[0] ?? '{}') as {
      code: string;
      outcome: string;
      message: string;
      approvalRequest: unknown;
    };
    expect(frame).toMatchObject({
      code: 'awaiting_approval',
      outcome: 'awaiting_approval',
      approvalRequest: asked,
    });
    expect(frame.message).toMatch(/^awaiting_approval: /u);
    expect(frame.message).not.toContain('SECRET-ARGUMENT');
  });

  it('is still run-done when the connection reports no request', async () => {
    const { names } = await runOnce({ ...fakeConnection([]), approvalRequest: () => null });
    expect(names.at(-1)).toBe('run-done');
  });

  it('is still run-error without the approval code when the stream also failed', async () => {
    const { names, body } = await runOnce({
      ...fakeConnection([], { fails: true }),
      approvalRequest: () => asked,
    });
    expect(names.at(-1)).toBe('run-error');
    expect(body).not.toContain('awaiting_approval');
  });

  it('is still run-interrupted when the run was interrupted (W1-RN-03)', async () => {
    const { names, body } = await runThenInterrupt({
      ...fakeCleanlyCancellingConnection(),
      approvalRequest: () => asked,
    });
    expect(names.at(-1)).toBe('run-interrupted');
    expect(body).not.toContain('awaiting_approval');
  });
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

describe('POST /files streaming', () => {
  // @story US-STO-06
  it(
    '[US-STO-06][contract][run] POST /files streams a 128 MiB archive with flat memory',
    { timeout: 120_000 },
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-files-flat-'));
      const workspace = path.join(root, 'workspace');
      const runner = createRunnerServer({ workspacePath: workspace });
      // A plain sink that drains and answers 204, bypassing /files.
      const sink = createServer((req, res) => {
        req.resume();
        req.on('end', () => res.writeHead(204).end());
      });
      const listen = async (server: typeof sink): Promise<string> => {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('no address');
        return `http://127.0.0.1:${String(address.port)}`;
      };
      const post = (url: string, body: ReadableStream<Uint8Array>): Promise<Response> =>
        fetch(url, { method: 'POST', body, duplex: 'half' });
      const archiveOf = (name: string, size: number) => {
        const generated = generatedBody(size);
        const archive = encodeUstarStream(
          [
            {
              path: name,
              type: 'file',
              mode: 0o644,
              size,
              open: () => Promise.resolve(generated.body),
            },
          ],
          { maxBytes: RUN_FILES_MAX_BYTES },
        );
        return { archive, sha256: generated.sha256 };
      };
      try {
        const runnerUrl = `${await listen(runner)}/files`;
        const sinkUrl = await listen(sink);
        // The first large upload in a process grows RSS once by native cost that has nothing to do
        // with the code under test (PR #1757): pay it with 32 MiB sent straight to the sink, then
        // load /files itself with 1 MiB before the baseline.
        await (await post(sinkUrl, generatedBody(32 * MiB).body)).arrayBuffer();
        expect((await post(runnerUrl, archiveOf('warm.bin', MiB).archive)).status).toBe(200);
        await rm(path.join(workspace, 'warm.bin'));

        const { archive, sha256 } = archiveOf('big.bin', RUN_FILES_MAX_BYTES);
        let sent = 0;
        let nextSample = 4 * MiB;
        let allSent: () => void = () => undefined;
        const arrived = new Promise<void>((resolve) => {
          allSent = resolve;
        });
        let answer: Promise<Response> | undefined;
        const growth = await peakRssGrowth(async (sample) => {
          const sampled = archive.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                sent += chunk.byteLength;
                // The archive's 512-byte header offsets every chunk, so sample on crossing a step.
                if (sent >= nextSample) {
                  sample();
                  nextSample += 4 * MiB;
                }
                controller.enqueue(chunk);
              },
              flush: () => allSent(),
            }),
          );
          answer = post(runnerUrl, sampled);
          await Promise.race([arrived, answer]);
        });
        expect(growth).toBeLessThan(64 * MiB);
        const response = await answer;
        expect(response?.status).toBe(200);
        expect(await response?.json()).toEqual({ hydrated: ['big.bin'] });
        const onDisk = createHash('sha256');
        for await (const chunk of createReadStream(path.join(workspace, 'big.bin'))) {
          onDisk.update(chunk as Buffer);
        }
        expect(onDisk.digest('hex')).toBe(await sha256);
      } finally {
        sink.closeAllConnections();
        runner.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) => sink.close(() => resolve())),
          new Promise<void>((resolve) => runner.close(() => resolve())),
        ]);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('the section 14.3 file endpoint failures', () => {
  async function withFilesServer(
    options: {
      maxFileArchiveBytes?: number;
      maxFileArchiveMembers?: number;
      workspaceIsFile?: boolean;
      logger?: Logger;
    },
    body: (url: string, workspace: string) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-files-fail-'));
    const workspace = path.join(root, 'workspace');
    if (options.workspaceIsFile === true) await writeFile(workspace, 'not a directory');
    else await mkdir(workspace);
    const server = createRunnerServer({
      workspacePath: workspace,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.maxFileArchiveBytes === undefined
        ? {}
        : { maxFileArchiveBytes: options.maxFileArchiveBytes }),
      ...(options.maxFileArchiveMembers === undefined
        ? {}
        : { maxFileArchiveMembers: options.maxFileArchiveMembers }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    try {
      await body(`http://127.0.0.1:${String(address.port)}/files`, workspace);
    } finally {
      // A refused upload leaves its request open until the client stops sending.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }

  it('answers a missing path with a 404 that does not carry the workspace root', async () => {
    await withFilesServer({}, async (url, workspace) => {
      const response = await fetch(`${url}?path=missing.txt`);
      const text = await response.text();
      expect(response.status).toBe(404);
      expect(JSON.parse(text)).toMatchObject({ error: 'file_not_found' });
      expect(text).not.toContain(workspace);
    });
  });

  it('answers a traversal request and a missing path parameter with a 400', async () => {
    await withFilesServer({}, async (url) => {
      const traversal = await fetch(`${url}?path=%252e%252e/x`);
      expect(traversal.status).toBe(400);
      expect(await traversal.json()).toMatchObject({ error: 'invalid_file_request' });

      const missing = await fetch(url);
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({
        error: 'invalid_file_request',
        message: 'at least one path query parameter is required',
      });
    });
  });

  it('answers a body that is not a tar archive with a 400', async () => {
    await withFilesServer({}, async (url) => {
      const response = await fetch(url, { method: 'POST', body: 'garbage' });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_archive' });
    });
  });

  it('refuses a collection over the size cap with a 413', async () => {
    await withFilesServer({ maxFileArchiveBytes: 4 }, async (url, workspace) => {
      await writeFile(path.join(workspace, 'five.txt'), '12345');
      const response = await fetch(`${url}?path=five.txt`);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: 'archive_too_large' });
    });
  });

  it('[US-STO-06][contract][run] POST /files refuses an archive whose files exceed the cap with a 413', async () => {
    await withFilesServer({ maxFileArchiveBytes: MiB }, async (url, workspace) => {
      const archive = encodeUstar([
        { path: 'big.bin', type: 'file', mode: 0o644, data: new Uint8Array(2 * MiB) },
      ]);
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= archive.byteLength) controller.close();
          else controller.enqueue(archive.subarray(offset, (offset += 64 * 1024)));
        },
      });
      const response = await fetch(url, { method: 'POST', body, duplex: 'half' });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: 'archive_too_large' });
      await expect(readFile(path.join(workspace, 'big.bin'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('[US-STO-06][contract][run] POST /files refuses a headers-only archive over the member cap with a 413', async () => {
    await withFilesServer({ maxFileArchiveMembers: 2 }, async (url, workspace) => {
      const archive = encodeUstar(
        ['a.txt', 'b.txt', 'c.txt'].map((name) => ({
          path: name,
          type: 'file' as const,
          mode: 0o644,
          data: new Uint8Array(0),
        })),
      );
      const response = await fetch(url, { method: 'POST', body: archive });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: 'archive_too_large' });
      await expect(readFile(path.join(workspace, 'c.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it.each([
    [
      'joins a valid traceparent',
      `00-${'4bf92f3577b34da6a3ce929d0e0e4736'}-00f067aa0ba902b7-01`,
      true,
    ],
    ['ignores a malformed traceparent', 'not-a-traceparent', false],
  ])(
    'answers a server fault with a fixed 500 and logs a JSON line (%s)',
    async (_name, traceparent, joined) => {
      const lines: Record<string, unknown>[] = [];
      const logger = createJsonLogger({
        service: 'runner',
        write: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      });
      await withFilesServer({ workspaceIsFile: true, logger }, async (url, workspace) => {
        const archive = encodeUstar([
          { path: 'a.txt', type: 'file', mode: 0o600, data: Buffer.from('a') },
        ]);
        const response = await fetch(url, {
          method: 'POST',
          headers: { traceparent },
          body: Buffer.from(archive),
        });
        const text = await response.text();
        expect(response.status).toBe(500);
        expect(JSON.parse(text)).toEqual({
          error: 'internal_error',
          message: 'the workspace files could not be processed.',
        });
        expect(text).not.toContain(workspace);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ level: 'error', service: 'runner', msg: '/files failed' });
        expect(lines[0]?.['traceId']).toBe(joined ? '4bf92f3577b34da6a3ce929d0e0e4736' : undefined);
        expect(JSON.stringify(lines)).not.toContain('not-a-traceparent');
      });
    },
  );
});

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
      startAgent: () => Promise.reject(new Error(`EACCES: permission denied, mkdir '${hostPath}'`)),
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

describe('trace forwarding to the model gateway (F-04)', () => {
  const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  /** The `env` the engine was started with for one `POST /run` carrying `headers`. */
  async function engineEnv(
    headers: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>> = {},
  ): Promise<Readonly<Record<string, string>>> {
    let started: Readonly<Record<string, string>> | undefined;
    const server = createRunnerServer({
      startAgent: (request) => {
        started = request.env;
        return Promise.resolve({ ok: true, connection: fakeConnection([]) });
      },
      logger: createJsonLogger({ service: 'runner', write: () => undefined }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    try {
      const body = {
        ...(runRequestBody(
          '77777777-7777-4777-8777-777777777777',
          '88888888-8888-4888-8888-888888888888',
        ) as Record<string, unknown>),
        env,
      };
      const response = await fetch(`http://127.0.0.1:${String(address.port)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      await response.text();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (started === undefined) throw new Error('the engine was not started');
    return started;
  }

  it("hands the engine the caller's traceparent and tracestate for its gateway calls", async () => {
    const env = await engineEnv({ traceparent: TRACEPARENT, tracestate: 'aw=1' });
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe(`traceparent: ${TRACEPARENT}\ntracestate: aw=1`);
  });

  it('keeps custom headers the run already sets', async () => {
    const env = await engineEnv(
      { traceparent: TRACEPARENT },
      { ANTHROPIC_CUSTOM_HEADERS: 'x-team: core' },
    );
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe(`x-team: core\ntraceparent: ${TRACEPARENT}`);
  });

  it('extends a differently cased custom-headers key instead of adding a second one', async () => {
    const env = await engineEnv(
      { traceparent: TRACEPARENT },
      { anthropic_custom_headers: 'x-team: core' },
    );
    expect(env).toEqual({ anthropic_custom_headers: `x-team: core\ntraceparent: ${TRACEPARENT}` });
  });

  it.each([
    ['absent', {}],
    ['malformed', { traceparent: 'not-a-traceparent', tracestate: 'aw=1' }],
  ])('forwards nothing for an %s traceparent', async (_name, headers) => {
    expect(await engineEnv(headers)).toEqual({});
  });

  it('records a server span in the adopted trace and hands the engine that span as parent', async () => {
    type Exporter = NonNullable<Parameters<typeof startTracing>[3]>;
    const spans: Parameters<Exporter['export']>[0][number][] = [];
    const exporter: Exporter = {
      export: (batch, done) => {
        spans.push(...batch);
        done({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
    };
    const tracing = await startTracing(
      'runner',
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel' },
      createJsonLogger({ service: 'runner', write: () => undefined }),
      exporter,
    );
    let env: Readonly<Record<string, string>>;
    try {
      env = await engineEnv({
        traceparent: TRACEPARENT,
        authorization: 'Bearer not-a-span-attribute',
      });
    } finally {
      await tracing?.shutdown();
    }

    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.name).toBe('POST /run');
    expect(span?.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(span?.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(span?.attributes).toEqual({
      'http.request.method': 'POST',
      'http.route': '/run',
      'http.response.status_code': 200,
    });
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toContain(
      `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-${span?.spanContext().spanId ?? ''}-01`,
    );
    expect(JSON.stringify([span?.attributes, span?.events])).not.toContain('not-a-span-attribute');
  });
});

describe('granted file references at /run', () => {
  // @story US-STO-06
  const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

  /** POST one `/run` that grants `reports/q3.txt` by reference; report the answer and any start. */
  async function runWithReference(
    onDisk: string | null,
    reference: { readonly size: number; readonly sha256: string },
  ): Promise<{ readonly status: number; readonly body: unknown; readonly started: number }> {
    const cwd = await mkdtemp(path.join(tmpdir(), 'w3-runner-reference-'));
    if (onDisk !== null) {
      await mkdir(path.join(cwd, 'reports'));
      await writeFile(path.join(cwd, 'reports', 'q3.txt'), onDisk);
    }
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
            'aaaaaaaa-1111-4111-8111-111111111111',
            'bbbbbbbb-2222-4222-8222-222222222222',
          ) as Record<string, unknown>),
          cwd,
          resources: {
            files: [{ kind: 'file', path: 'reports/q3.txt', access: 'read', ...reference }],
            skills: [],
          },
        }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: response.status === 200 ? text : (JSON.parse(text) as unknown),
        started,
      };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  }

  /** POST one `/run` that grants skill `support` by reference; report the answer, start and inbox. */
  async function runWithSkillReference(
    onDisk: string | null,
    reference: { readonly size: number; readonly sha256: string },
  ) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'w3-runner-skill-reference-'));
    if (onDisk !== null) {
      await mkdir(path.join(cwd, '.aw-inbox', 'skills', 'support'), { recursive: true });
      await writeFile(path.join(cwd, '.aw-inbox', 'skills', 'support', 'SKILL.md'), onDisk);
    }
    const started: unknown[] = [];
    const server = createRunnerServer({
      startAgent: (request) => {
        started.push(request.resources?.skills);
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
            'aaaaaaaa-1111-4111-8111-111111111111',
            'bbbbbbbb-2222-4222-8222-222222222222',
          ) as Record<string, unknown>),
          cwd,
          resources: {
            files: [],
            skills: [{ name: 'support', files: [{ path: 'SKILL.md', ...reference }] }],
          },
        }),
      });
      const text = await response.text();
      return {
        status: response.status,
        text,
        started,
        inboxLeft: await stat(path.join(cwd, '.aw-inbox')).then(
          () => true,
          () => false,
        ),
        cwd,
      };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  }

  /**
   * POST one `/run` whose resources carry inline bytes; report the answer and whether an engine started.
   * `granted` is written under `cwd` first, so the reference itself is valid and only the inline bytes can refuse it.
   */
  async function runWithInlineBytes(
    granted: { readonly at: string; readonly body: string },
    resources: unknown,
  ) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'w3-runner-inline-'));
    await mkdir(path.dirname(path.join(cwd, granted.at)), { recursive: true });
    await writeFile(path.join(cwd, granted.at), granted.body);
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
            'aaaaaaaa-1111-4111-8111-111111111111',
            'bbbbbbbb-2222-4222-8222-222222222222',
          ) as Record<string, unknown>),
          cwd,
          resources,
        }),
      });
      return { status: response.status, text: await response.text(), started };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  }

  it('[US-STO-06][contract][run] /run refuses a file resource with contentBase64 with 400 and does not echo it', async () => {
    const secret = `payload-${randomUUID()}`;
    const answer = await runWithInlineBytes(
      { at: 'notes.txt', body: secret },
      {
        files: [
          {
            kind: 'file',
            path: 'notes.txt',
            access: 'read',
            size: secret.length,
            sha256: sha256(secret),
            contentBase64: Buffer.from(secret).toString('base64'),
          },
        ],
        skills: [],
      },
    );
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.text)).toMatchObject({ error: 'invalid_run_request' });
    expect(answer.text).not.toContain(Buffer.from(secret).toString('base64'));
    expect(answer.text).not.toContain(secret);
    expect(answer.started).toBe(0);
  });

  it('[US-STO-06][contract][run] /run refuses a skill file with contentBase64 with 400 and does not echo it', async () => {
    const secret = `payload-${randomUUID()}`;
    const answer = await runWithInlineBytes(
      { at: '.aw-inbox/skills/support/SKILL.md', body: secret },
      {
        files: [],
        skills: [
          {
            name: 'support',
            files: [
              {
                path: 'SKILL.md',
                size: secret.length,
                sha256: sha256(secret),
                contentBase64: Buffer.from(secret).toString('base64'),
              },
            ],
          },
        ],
      },
    );
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.text)).toMatchObject({ error: 'invalid_run_request' });
    expect(answer.text).not.toContain(Buffer.from(secret).toString('base64'));
    expect(answer.text).not.toContain(secret);
    expect(answer.started).toBe(0);
  });

  it('[US-STO-06][contract][run] a skill reference whose sha256 does not match the inbox file answers 422 run_file_checksum_mismatch and never starts the engine', async () => {
    const answer = await runWithSkillReference('what arrived', {
      size: 'what arrived'.length,
      sha256: sha256('what was granted'),
    });
    expect(answer.status).toBe(422);
    expect(JSON.parse(answer.text)).toEqual({
      error: 'run_file_checksum_mismatch',
      message: 'granted file ".aw-inbox/skills/support/SKILL.md" did not arrive intact',
    });
    expect(answer.text).not.toContain(answer.cwd);
    expect(answer.started).toEqual([]);
    expect(answer.inboxLeft).toBe(false);
  });

  it('[US-STO-06][contract][run] a skill reference whose file did not arrive answers 422 run_file_missing and never starts the engine', async () => {
    const answer = await runWithSkillReference(null, { size: 4, sha256: sha256('gone') });
    expect(answer.status).toBe(422);
    expect(JSON.parse(answer.text)).toMatchObject({ error: 'run_file_missing' });
    expect(answer.started).toEqual([]);
  });

  it('[US-STO-06][contract][run] a skill file removed after verification answers 422 run_file_missing without a host path and never starts the engine', async () => {
    verifyGate.after = (cwd) => rm(path.join(cwd, '.aw-inbox', 'skills', 'support', 'SKILL.md'));
    try {
      const answer = await runWithSkillReference('# support', {
        size: '# support'.length,
        sha256: sha256('# support'),
      });
      expect(answer.status).toBe(422);
      expect(JSON.parse(answer.text)).toEqual({
        error: 'run_file_missing',
        message: 'a granted skill file did not arrive intact',
      });
      expect(answer.text).not.toContain(answer.cwd);
      expect(answer.started).toEqual([]);
      expect(answer.inboxLeft).toBe(false);
    } finally {
      verifyGate.after = () => Promise.resolve();
    }
  });

  it('[US-STO-06][contract][run] a skill file changed after verification answers 422 run_file_checksum_mismatch and never starts the engine', async () => {
    // Same size, other bytes: only the bytes the runner reads are hashed again.
    verifyGate.after = (cwd) =>
      writeFile(path.join(cwd, '.aw-inbox', 'skills', 'support', 'SKILL.md'), '# swapped');
    try {
      const answer = await runWithSkillReference('# support', {
        size: '# support'.length,
        sha256: sha256('# support'),
      });
      expect(answer.status).toBe(422);
      expect(JSON.parse(answer.text)).toEqual({
        error: 'run_file_checksum_mismatch',
        message: 'a granted skill file did not arrive intact',
      });
      expect(answer.started).toEqual([]);
      expect(answer.inboxLeft).toBe(false);
    } finally {
      verifyGate.after = () => Promise.resolve();
    }
  });

  it('[US-STO-06][contract][run] a skill inbox that cannot be removed answers 500 without a host path and never starts the engine', async () => {
    inboxRemoval.fail = true;
    try {
      const answer = await runWithSkillReference('# support', {
        size: '# support'.length,
        sha256: sha256('# support'),
      });
      expect(answer.status).toBe(500);
      expect(JSON.parse(answer.text)).toEqual({
        error: 'internal_error',
        message: 'the granted skill files could not be cleared',
      });
      expect(answer.text).not.toContain(answer.cwd);
      expect(answer.started).toEqual([]);
    } finally {
      inboxRemoval.fail = false;
    }
  });

  it('[US-STO-06][contract][run] a matching skill reference starts the engine with the inbox bytes inline and removes the inbox', async () => {
    const answer = await runWithSkillReference('# support', {
      size: '# support'.length,
      sha256: sha256('# support'),
    });
    expect(answer.status).toBe(200);
    expect(answer.started).toEqual([
      [
        {
          name: 'support',
          files: [{ path: 'SKILL.md', contentBase64: Buffer.from('# support').toString('base64') }],
        },
      ],
    ]);
    expect(answer.inboxLeft).toBe(false);
  });

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
});
