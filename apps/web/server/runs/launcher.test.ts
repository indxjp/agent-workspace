import { RUNTIME_CAPACITY_EXHAUSTED, parseRunFailure } from '@indx-workspace/contracts/runs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerLauncher, RUN_STATUS_EVENT } from './launcher';
import type { LaunchContext } from './environment';
import { resetLiveRuns, signalLiveRun } from './interrupt';
import { InMemoryRunStore, type RunRecord } from './store';

const RUN = '11111111-1111-4111-8111-111111111111';
const AGENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

async function newRun(store: InMemoryRunStore): Promise<RunRecord> {
  return store.create({
    engine: 'claude-agent-sdk',
    id: RUN,
    workspaceId: '22222222-2222-4222-8222-222222222222',
    agentId: AGENT,
    sessionId: SESSION,
  });
}

function context(run: RunRecord): LaunchContext {
  return {
    run,
    agent: { id: AGENT, workspaceId: run.workspaceId, engine: 'claude-agent-sdk' },
    session: { id: SESSION, agentId: AGENT, engine: null },
    principal: {
      principalId: '77777777-7777-4777-8777-777777777777',
      ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
      userId: '66666666-6666-4666-8666-666666666666',
      workspaceId: run.workspaceId,
      scope: null,
    },
    prompt: 'hello',
  };
}

/**
 * The §14.3 body these tests send. Deliberately a fixture rather than the real compilation:
 * `buildRunRequest` is `createRunnerLauncher`'s one required argument precisely because this
 * module does not know how to build one, so a test that built a real `RunRequest` here would be
 * asserting the composer's work through the launcher. What is asserted below is that whatever
 * the composer returns is what reaches `POST {base}/run`, unchanged.
 */
const RUN_REQUEST_FIXTURE = { runId: RUN, sessionId: SESSION, marker: 'from the composer' };

function buildRunRequest(): unknown {
  return RUN_REQUEST_FIXTURE;
}

function sse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Wait until the run reaches a terminal status, or fail loudly rather than hang. */
async function settle(store: InMemoryRunStore): Promise<RunRecord> {
  for (let i = 0; i < 200; i += 1) {
    const run = await store.get(RUN);
    if (run !== null && run.endedAt !== null) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the run never reached a terminal status');
}

async function transcript(store: InMemoryRunStore): Promise<{ type: string; data: unknown }[]> {
  const handle = await store.openStream(RUN, null);
  if (handle === null) throw new Error('no handle');
  const out: { type: string; data: unknown }[] = [];
  for await (const event of handle.events) out.push({ type: event.type, data: event.data });
  return out;
}

describe('createRunnerLauncher', () => {
  it('hydrates before execution and durably promotes declared outputs afterward', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const order: string[] = [];
    const inputArchive = new Uint8Array([1, 2, 3]);
    const outputArchive = new Uint8Array([4, 5, 6]);
    let promoted: Uint8Array | null = null;
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () =>
          Promise.resolve({
            runtimeProfileId: 'profile-docker',
            driver: 'docker',
            networkPolicy: 'none',
            filesystem: 'read-write',
            persistPaths: ['/workspace/output', 'report.txt'],
            runnerUrl: 'http://runtime:8080',
            workspaceRoot: '/workspace',
          }),
      },
      buildRunRequest,
      workspaceLifecycle: {
        inputArchive: () => Promise.resolve(inputArchive),
        promoteOutputs: (_context, _runtime, archive) => {
          order.push('promote');
          promoted = archive;
          return Promise.resolve();
        },
      },
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/files') && init?.method === 'POST') {
          order.push('hydrate');
          expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(inputArchive);
          return Promise.resolve(Response.json({ hydrated: ['input.txt'] }));
        }
        if (url.endsWith('/run')) {
          order.push('run');
          return Promise.resolve(sse('event: run-done\ndata: {}\n\n'));
        }
        expect(url).toBe('http://runtime:8080/files?path=output&path=report.txt');
        order.push('collect');
        return Promise.resolve(
          new Response(outputArchive, {
            headers: { 'content-type': 'application/x-tar', 'content-length': '3' },
          }),
        );
      },
    });

    launch(context(run));
    expect((await settle(store)).status).toBe('completed');
    expect(order).toEqual(['hydrate', 'run', 'collect', 'promote']);
    expect(promoted).toEqual(outputArchive);
  });

  // Issue #881: the in-process runner materialises `resources.files` itself; POST /files is not
  // session-scoped there and failed with EACCES.
  it('never hydrates a local target, and the run still completes', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const urls: string[] = [];
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () =>
          Promise.resolve({
            runtimeProfileId: 'profile-local',
            driver: 'local',
            networkPolicy: 'none',
            filesystem: 'read-write',
            persistPaths: [],
            runnerUrl: 'http://runtime:8080',
            workspaceRoot: '/workspace',
          }),
      },
      buildRunRequest,
      workspaceLifecycle: {
        inputArchive: () => Promise.resolve(new Uint8Array([1, 2, 3])),
        promoteOutputs: () => Promise.resolve(),
      },
      fetch: (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        return Promise.resolve(sse('event: run-done\ndata: {}\n\n'));
      },
    });

    launch(context(run));
    expect((await settle(store)).status).toBe('completed');
    expect(urls).toEqual(['http://runtime:8080/run']);
  });

  it('preserves the run failure while also reporting output-promotion failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () =>
          Promise.resolve({
            runtimeProfileId: 'profile-docker',
            driver: 'docker',
            networkPolicy: 'none',
            filesystem: 'read-write',
            persistPaths: ['output'],
            runnerUrl: 'http://runtime:8080',
            workspaceRoot: '/workspace',
          }),
      },
      buildRunRequest,
      workspaceLifecycle: {
        inputArchive: () => Promise.resolve(null),
        promoteOutputs: () => Promise.reject(new Error('object store unavailable')),
      },
      fetch: (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(
          url.endsWith('/run')
            ? sse('event: run-error\ndata: {"message":"sdk failed"}\n\n')
            : new Response(new Uint8Array([1]), {
                headers: { 'content-type': 'application/x-tar' },
              }),
        );
      },
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(settled.error).toContain('The runtime reported a run failure.');
    expect(settled.error).not.toContain('sdk failed');
    expect(settled.error).toContain('Run output could not be saved.');
    expect(settled.error).not.toContain('object store unavailable');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("logs the runner's own reason when hydration is refused, and keeps it off the run", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () =>
          Promise.resolve({
            runtimeProfileId: 'profile-docker',
            driver: 'docker',
            networkPolicy: 'none',
            filesystem: 'read-write',
            persistPaths: [],
            runnerUrl: 'http://runtime:8080',
            workspaceRoot: '/workspace',
          }),
      },
      buildRunRequest,
      workspaceLifecycle: {
        inputArchive: () => Promise.resolve(new Uint8Array([1])),
        promoteOutputs: () => Promise.resolve(),
      },
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: 'invalid_archive', message: "EACCES: mkdir '/workspace'" },
            { status: 400 },
          ),
        ),
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.error).toContain('The workspace could not be prepared.');
    expect(settled.error).not.toContain('EACCES');
    const causes = log.mock.calls.map(([, error]) => String((error as Error | undefined)?.cause));
    expect(causes.join('\n')).toContain('runtime returned HTTP 400');
    expect(causes.join('\n')).toContain('invalid_archive');
    expect(causes.join('\n')).toContain("EACCES: mkdir '/workspace'");
    log.mockRestore();
  });

  // PR #403 review: per-launch state is released however the launch ends.
  it('calls onLaunchSettled once, after the terminal status, for a completed and a failed launch', async () => {
    for (const fails of [false, true]) {
      const store = new InMemoryRunStore();
      const run = await newRun(store);
      const settledFor: string[] = [];
      const launch = createRunnerLauncher({
        baseUrl: 'http://runner:8080',
        store,
        buildRunRequest: fails
          ? () => {
              throw new Error('compose failed');
            }
          : buildRunRequest,
        onLaunchSettled: (launched) => {
          settledFor.push(launched.run.id);
        },
        fetch: () => Promise.resolve(sse('event: run-done\ndata: {}\n\n')),
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      launch(context(run));
      const settled = await settle(store);
      await vi.waitFor(() => expect(settledFor).toEqual([RUN]));
      expect(settled.status).toBe(fails ? 'failed' : 'completed');
      log.mockRestore();
    }
  });

  // PR #403 review: the composition root names a runtime failure it recognises with a code.
  it('stores the coded message codeRuntimeFailure returns instead of the generic one', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const seen: string[] = [];
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      codeRuntimeFailure: (_context, reason) => {
        seen.push(reason);
        return 'model_unavailable: model "gone" is not available.';
      },
      fetch: () =>
        Promise.resolve(
          sse('event: run-error\ndata: {"message":"not_found_error: model: gone"}\n\n'),
        ),
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe('model_unavailable: model "gone" is not available.');
    expect(seen).toHaveLength(1);
  });

  it('keeps untrusted runtime failure text out of the run record and replayable status', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = new InMemoryRunStore();
      const run = await newRun(store);
      const launch = createRunnerLauncher({
        baseUrl: 'http://runner:8080',
        store,
        buildRunRequest,
        fetch: () =>
          Promise.resolve(sse('event: run-error\ndata: {"message":"private runtime detail"}\n\n')),
      });
      launch(context(run));
      const settled = await settle(store);
      expect(settled.status).toBe('failed');
      expect(settled.error).toBe('The runtime reported a run failure.');
      expect(JSON.stringify(await transcript(store))).not.toContain('private runtime detail');
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('resolves the selected profile before composing and posting the run', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const calls: string[] = [];
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () =>
          Promise.resolve({
            runtimeProfileId: 'profile-1',
            driver: 'local',
            networkPolicy: 'open',
            filesystem: 'read-write',
            timeoutSeconds: 60,
            runnerUrl: 'http://selected-runner:9090',
            workspaceRoot: '/selected-workspace',
          }),
      },
      buildRunRequest: (_context, target) => ({ profile: target?.runtimeProfileId }),
      fetch: (input, init) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        const body = typeof init?.body === 'string' ? init.body : '';
        calls.push(`${url} ${body}`);
        return Promise.resolve(
          sse('event: assistant\ndata: {"text":"hi"}\n\nevent: run-done\ndata: {}\n\n'),
        );
      },
    });
    launch(context(run));
    expect((await settle(store)).status).toBe('completed');
    expect(calls).toEqual(['http://selected-runner:9090/run {"profile":"profile-1"}']);
  });

  it('posts to {base}/run per §14.3 and relays the stream into the store', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const calls: { url: string; body: unknown }[] = [];
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080/',
      store,
      buildRunRequest,
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const raw = typeof init?.body === 'string' ? init.body : 'null';
        calls.push({ url, body: JSON.parse(raw) as unknown });
        return Promise.resolve(
          sse('event: assistant\ndata: {"text":"hi"}\n\nevent: run-done\ndata: {}\n\n'),
        );
      },
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('completed');
    expect(settled.error).toBeNull();
    expect(calls[0]?.url).toBe('http://runner:8080/run');
    // Exactly what `buildRunRequest` returned, and nothing this module added. The body used to
    // be built here, out of the four fields `LaunchContext` happens to carry, and the real
    // `apps/runner` answered it 400 `invalid_run_request`; see the field's documentation.
    expect(calls[0]?.body).toEqual(RUN_REQUEST_FIXTURE);

    expect(await transcript(store)).toEqual([
      { type: RUN_STATUS_EVENT, data: { status: 'running', error: null } },
      { type: 'assistant', data: { text: 'hi' } },
      { type: RUN_STATUS_EVENT, data: { status: 'completed', error: null } },
    ]);
  });

  it('records the failure on the run when the runtime cannot be reached', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe('The runtime could not be reached.');
    expect(settled.error).not.toContain('ECONNREFUSED');
    // The failure is also in the event log, so a client that reconnects after it learns about it
    // by replay rather than by having to poll the run record.
    const events = await transcript(store);
    const last = events.at(-1);
    expect(last?.type).toBe(RUN_STATUS_EVENT);
    const data = last?.data as { status: string; error: string };
    expect(data.status).toBe('failed');
    expect(data.error).toBe('The runtime could not be reached.');
    const loggedFailure = log.mock.calls[0]?.[1] as unknown;
    expect(loggedFailure).toMatchObject({ operation: 'start-runtime-run' });
    expect((loggedFailure as Error | undefined)?.cause).toEqual(new Error('ECONNREFUSED'));
    log.mockRestore();
  });

  it('fails the run when the runtime answers with something that is not an SSE stream', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      fetch: () => Promise.resolve(new Response('<html>502</html>', { status: 502 })),
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe('The runtime reported a run failure.');
  });

  it('never leaves a run at "running" when a frame is malformed', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      fetch: () => Promise.resolve(sse('event: assistant\ndata: {oops\n\n')),
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe('The runtime reported a run failure.');
  });

  it('applies the timeout to the connect, never to the stream that follows', async () => {
    // Regression, found by the acceptance run: the first version passed
    // `AbortSignal.timeout(ms)` straight into `fetch`, and that signal stays attached to the
    // response body — so a healthy stream was aborted `ms` after it began. Here the connect
    // deadline is 40 ms and the runtime keeps streaming for ten times that; the run must
    // complete.
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 1; i <= 4; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          controller.enqueue(encoder.encode(`event: assistant\ndata: ${String(i)}\n\n`));
        }
        controller.enqueue(encoder.encode('event: run-done\ndata: {}\n\n'));
        controller.close();
      },
    });
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      connectTimeoutMs: 40,
      fetch: () =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        ),
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.error).toBeNull();
    expect(settled.status).toBe('completed');
    expect(await transcript(store)).toHaveLength(6); // running + 4 events + completed
  });

  it('concludes `cancelled`, not `failed`, when the runner alone reports run-interrupted (issue #235)', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      fetch: () => Promise.resolve(sse('event: run-interrupted\ndata: {"interrupted":true}\n\n')),
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('cancelled');
    expect(settled.error).toContain('interrupted');
    const events = await transcript(store);
    const statuses = events
      .filter((event) => event.type === RUN_STATUS_EVENT)
      .map((event) => (event.data as { status: string }).status);
    expect(statuses).toEqual(['running', 'cancelled']);
  });

  it('registers this run in the live-run registry while it holds the runtime connection, and releases it once settled', async () => {
    resetLiveRuns();
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const encoder = new TextEncoder();
    let closeStream: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStream = () => {
          controller.enqueue(encoder.encode('event: run-done\ndata: {}\n\n'));
          controller.close();
        };
      },
    });
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      fetch: () =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        ),
    });
    launch(context(run));

    // While the stream is still open, this process is holding the run: a signal reaches the
    // registered base URL.
    let signalledUrl: string | null = null;
    for (let i = 0; i < 200 && signalledUrl === null; i += 1) {
      await signalLiveRun(RUN, (input) => {
        signalledUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(Response.json({}, { status: 202 }));
      });
      if (signalledUrl === null) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(signalledUrl).toBe('http://runner:8080/interrupt');

    closeStream?.();
    await settle(store);

    // Settled: the registry entry is released, so a later signal for this run id does nothing.
    let signalledAfterSettling = false;
    await signalLiveRun(RUN, () => {
      signalledAfterSettling = true;
      return Promise.reject(new Error('should not be called'));
    });
    expect(signalledAfterSettling).toBe(false);
  });

  it('fails the run when the runtime does not answer within the connect timeout', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      connectTimeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted by the connect deadline'));
          });
        }),
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe('The runtime could not be reached.');
    expect(settled.error).not.toContain('aborted by the connect deadline');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('interrupts and fails a run before its fixed gateway credential can expire', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let interrupts = 0;
    let interruptBody: unknown;
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      connectTimeoutMs: 1_000,
      maxRunDurationMs: 25,
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/interrupt')) {
          interrupts += 1;
          if (typeof init?.body !== 'string') throw new Error('expected a JSON interrupt body');
          interruptBody = JSON.parse(init.body);
          return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('lifetime abort')));
        });
      },
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(settled.error).toContain('credential-bounded lifetime');
    expect(interrupts).toBe(1);
    expect(interruptBody).toEqual({ runId: run.id });
  });

  it('fails the run, and posts nothing, when the run request cannot be built', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let posted = 0;
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest: () => {
        throw new Error('agent 3333 is gone');
      },
      preparationSecrets: () => Promise.resolve([]),
      fetch: () => {
        posted += 1;
        return Promise.resolve(sse(''));
      },
    });

    launch(context(run));
    const settled = await settle(store);
    expect(posted).toBe(0);
    expect(settled.status).toBe('failed');
    const stored =
      'run_preparation_failed: The run request could not be prepared at the compose step (Error).';
    expect(settled.error).toBe(stored);
    expect(settled.error).not.toContain('agent 3333');
    expect(log).toHaveBeenCalledWith(
      '[runs] run preparation failed at the compose step (Error): agent 3333 is gone',
    );
    // The failure is replayable: a client that reconnects learns about it from the log, not
    // only from the record. Same rule as every other terminal status here.
    expect(await transcript(store)).toEqual([
      { type: RUN_STATUS_EVENT, data: { status: 'running', error: null } },
      {
        type: RUN_STATUS_EVENT,
        data: {
          status: 'failed',
          error: stored,
        },
      },
    ]);
    log.mockRestore();
  });

  it("redacts the run's short declared secret from the preparation log and keeps it out of the problem (issue #827)", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'shortsecret1';
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest: () => {
        throw new Error(`tool host refused key ${secret} for agent 3333`);
      },
      preparationSecrets: () => Promise.resolve([secret]),
      fetch: () => Promise.resolve(sse('')),
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.error).not.toContain(secret);
    expect(log).toHaveBeenCalledWith(
      '[runs] run preparation failed at the compose step (Error): tool host refused key [redacted] for agent 3333',
    );
    expect(log.mock.calls.flat().join(' ')).not.toContain(secret);
    log.mockRestore();
  });

  it('withholds the preparation log message when the run secrets cannot be read (issue #827)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest: () => {
        throw new Error('key shortsecret1 refused');
      },
      preparationSecrets: () => Promise.reject(new Error('secrets store down')),
      fetch: () => Promise.resolve(sse('')),
    });

    launch(context(run));
    await settle(store);
    expect(log).toHaveBeenCalledWith(
      '[runs] run preparation failed at the compose step (Error): [withheld]',
    );
    log.mockRestore();
  });

  it('posts nothing and leaves no active token when an interrupt lands while the run is still queued (issue #235)', async () => {
    resetLiveRuns();
    const store = new InMemoryRunStore();
    const run = await newRun(store);

    // The run's gateway token row does not exist until `buildRunRequest` mints it (register.ts's
    // `gateway.issue` callback registers it there), so an interrupt that lands before that point
    // revokes nothing at all. This is that table.
    const tokens: { id: string; runId: string; revoked: boolean }[] = [];
    function revokeForRun(runId: string): number {
      let revoked = 0;
      for (const token of tokens) {
        if (token.runId === runId && !token.revoked) {
          token.revoked = true;
          revoked += 1;
        }
      }
      return revoked;
    }

    // Every request this launch makes, whatever its purpose: the assertion below is that it makes
    // none — neither `POST {base}/run` nor a runtime interrupt signal.
    const urls: string[] = [];
    const record: typeof globalThis.fetch = (input) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(sse('event: run-done\ndata: {}\n\n'));
    };

    // The launcher's work outlives the run's terminal status here — the interrupt writes that
    // status — so `settle` cannot tell when the launch is over. The terminal telemetry call can.
    let launchFinished: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      launchFinished = resolve;
    });

    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest: async () => {
        tokens.push({ id: 'token-1', runId: RUN, revoked: false });
        // …and the interrupt lands exactly here, performed the way `interruptRun` in
        // `composition/register.ts` performs it: terminal status, then revocation (which finds the
        // row above only because this fixture mints it first — in production `buildRunRequest` has
        // not returned yet), then the best-effort runtime signal, which finds no registry entry
        // because `registerLiveRun` runs after this callback.
        await store.appendPlatformEvent(RUN, {
          type: RUN_STATUS_EVENT,
          data: { status: 'cancelled', error: 'the run was interrupted by request' },
        });
        await store.finish(RUN, 'cancelled', 'the run was interrupted by request');
        await signalLiveRun(RUN, record);
        return RUN_REQUEST_FIXTURE;
      },
      revokeRunTokens: (launched) => {
        revokeForRun(launched.run.id);
        return Promise.resolve();
      },
      fetch: record,
      onRunFinished: () => {
        launchFinished();
      },
    });

    launch(context(run));
    await finished;

    // (a) the runtime never receives the request …
    expect(urls).toEqual([]);
    // … (b) and no active token survives the launch that minted one.
    expect(tokens).toEqual([{ id: 'token-1', runId: RUN, revoked: true }]);
    const settled = await settle(store);
    expect(settled.status).toBe('cancelled');
    expect(settled.error).toBe('the run was interrupted by request');
    // The run never started, so the log carries the interrupt's `cancelled` and no `running`.
    expect(await transcript(store)).toEqual([
      {
        type: RUN_STATUS_EVENT,
        data: { status: 'cancelled', error: 'the run was interrupted by request' },
      },
    ]);
  });

  it('revokes the token it minted when an interrupt lands and then preparation fails', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let revoked = 0;
    let launchFinished: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      launchFinished = resolve;
    });
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest: async () => {
        // The token is minted here; the interrupt then ends the queued run, and the step after
        // composing fails, so the launch's own `finish` is a no-op that revokes nothing.
        await store.finish(RUN, 'cancelled', 'the run was interrupted by request');
        throw new Error('hydrate failed');
      },
      revokeRunTokens: () => {
        revoked += 1;
        return Promise.resolve();
      },
      onRunFinished: () => {
        launchFinished();
      },
    });
    launch(context(run));
    await finished;
    expect(revoked).toBe(1);
    expect((await settle(store)).status).toBe('cancelled');
  });

  it('reports the run store’s settled cost on the terminal telemetry measurement, not a hardcoded null', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const measurements: { status: string; costUsd: number | null }[] = [];
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      fetch: () => Promise.resolve(sse('event: run-done\ndata: {}\n\n')),
      onRunFinished: (measurement) => {
        measurements.push({ status: measurement.status, costUsd: measurement.costUsd });
      },
    });
    launch(context(run));
    await settle(store);
    // The in-memory store's own default is an actual, measured zero (issue #134's distinction is
    // between the store having a real number and the launcher fabricating `null`) — asserting the
    // exact value, not just non-null, is what a regression to the hardcoded `costUsd: null` fails.
    expect(measurements).toEqual([{ status: 'completed', costUsd: 0 }]);
  });

  it('returns synchronously — the HTTP response that starts a run never waits for it', () => {
    const store = new InMemoryRunStore();
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      fetch: () => new Promise(() => undefined),
    });
    void newRun(store).then((run) => {
      expect(launch(context(run))).toBeUndefined();
    });
  });
});

// Issue #557: concurrent widget conversations failed outright when the local runner answered
// `429 runner_capacity_exhausted`. The launcher now waits, bounded, for a free slot.
describe('createRunnerLauncher releases the run sandboxes (issue #832)', () => {
  const urlOf = (input: Parameters<typeof globalThis.fetch>[0]) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  /** One launch against an `external` target; `releases` records the run and its status at each release. */
  async function launchWith(
    options: Partial<Parameters<typeof createRunnerLauncher>[0]> & {
      fetch: typeof globalThis.fetch;
    },
  ) {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const releases: { runId: string; statusSeen: string | undefined }[] = [];
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () =>
          Promise.resolve({
            runtimeProfileId: 'profile-e2b',
            driver: 'external',
            networkPolicy: 'none',
            filesystem: 'read-write',
            runnerUrl: 'http://manager:8080/runtimes/sealed-1',
            workspaceRoot: '/workspace',
          }),
      },
      buildRunRequest,
      releaseRunSandboxes: async (launched) => {
        releases.push({
          runId: launched.run.id,
          statusSeen: (await store.get(RUN))?.status,
        });
      },
      ...options,
    });
    launch(context(run));
    const settled = await settle(store);
    return { store, settled, releases };
  }

  it('releases once, before the terminal status is written, when the run completes', async () => {
    const { settled, releases } = await launchWith({
      fetch: () => Promise.resolve(sse('event: run-done\ndata: {}\n\n')),
    });
    expect(settled.status).toBe('completed');
    expect(releases).toEqual([{ runId: RUN, statusSeen: 'running' }]);
  });

  // The session's runtime refuses a second run while its first is in flight. The release names
  // only the refused run, and the manager ends only the sandboxes that run started: none, since it
  // reused the first run's (apps/runner/src/tool-sandbox.test.ts holds the manager's side).
  it('releases only the refused run itself when the runtime answers 409 session_in_flight', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { settled, releases } = await launchWith({
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: 'session_in_flight', message: 'a run of this session is in flight' },
            { status: 409 },
          ),
        ),
    });
    expect(settled.status).toBe('failed');
    expect(releases).toEqual([{ runId: RUN, statusSeen: 'running' }]);
    log.mockRestore();
  });

  it('releases once when an evaluation case reaches its deadline while the run streams', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const releases: (string | undefined)[] = [];
    let endStream: (() => void) | undefined;
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () =>
          Promise.resolve({
            runtimeProfileId: 'profile-e2b',
            driver: 'external',
            networkPolicy: 'none',
            filesystem: 'read-write',
            runnerUrl: 'http://manager:8080/runtimes/sealed-1',
            workspaceRoot: '/workspace',
          }),
      },
      buildRunRequest,
      releaseRunSandboxes: async () => {
        releases.push((await store.get(RUN))?.status);
      },
      fetch: () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            endStream = () => {
              controller.enqueue(
                new TextEncoder().encode('event: run-interrupted\ndata: {"interrupted":true}\n\n'),
              );
              controller.close();
            };
          },
        });
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        );
      },
    });
    launch(context(run));
    await vi.waitFor(() => expect(endStream).toBeDefined());
    // The case deadline stops the run as `stopAbandonedRun` does: the interrupt route writes
    // `cancelled`, and the runtime then ends the stream it was serving.
    await store.finish(RUN, 'cancelled', 'deadline_exceeded');
    endStream?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const settled = await settle(store);
    expect(settled.status).toBe('cancelled');
    expect(settled.error).toBe('deadline_exceeded');
  });

  it('releases when the runtime reports a failure', async () => {
    const { settled, releases } = await launchWith({
      fetch: () => Promise.resolve(sse('event: run-failed\ndata: {"error":"boom"}\n\n')),
    });
    expect(settled.status).toBe('failed');
    expect(releases).toHaveLength(1);
  });

  it('releases when the runtime reports an interrupt, even after the interrupt route concluded the run', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const releases: (string | undefined)[] = [];
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () =>
          Promise.resolve({
            runtimeProfileId: 'profile-e2b',
            driver: 'external',
            networkPolicy: 'none',
            filesystem: 'read-write',
            runnerUrl: 'http://manager:8080/runtimes/sealed-1',
            workspaceRoot: '/workspace',
          }),
      },
      buildRunRequest,
      releaseRunSandboxes: async () => {
        releases.push((await store.get(RUN))?.status);
      },
      // An evaluation case's deadline interrupts through the same route: it writes `cancelled`
      // first, and the runner then ends the stream.
      fetch: async () => {
        await store.finish(RUN, 'cancelled', 'the case reached its deadline');
        return sse('event: run-interrupted\ndata: {"interrupted":true}\n\n');
      },
    });
    launch(context(run));
    const settled = await settle(store);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(settled.status).toBe('cancelled');
    expect(settled.error).toBe('the case reached its deadline');
  });

  it('releases when the run reaches its deadline', async () => {
    const { settled, releases } = await launchWith({
      connectTimeoutMs: 1_000,
      maxRunDurationMs: 25,
      fetch: (input, init) => {
        if (urlOf(input).endsWith('/interrupt')) {
          return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('lifetime abort')));
        });
      },
    });
    expect(settled.status).toBe('failed');
    expect(releases).toHaveLength(1);
  });

  it('releases when the runtime cannot be reached', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { settled, releases } = await launchWith({
      fetch: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });
    expect(settled.status).toBe('failed');
    expect(releases).toHaveLength(1);
    log.mockRestore();
  });

  it('releases when the workspace cannot be hydrated', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { settled, releases } = await launchWith({
      workspaceLifecycle: {
        inputArchive: () => Promise.resolve(new Uint8Array([1])),
        promoteOutputs: () => Promise.resolve(),
      },
      fetch: () => Promise.resolve(Response.json({ error: 'invalid_archive' }, { status: 400 })),
    });
    expect(settled.error).toContain('The workspace could not be prepared.');
    expect(releases).toHaveLength(1);
    log.mockRestore();
  });

  it('releases when the run request cannot be built, once the target is known', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { settled, releases } = await launchWith({
      buildRunRequest: () => {
        throw new Error('compose failed');
      },
      fetch: () => Promise.resolve(sse('event: run-done\ndata: {}\n\n')),
    });
    expect(settled.status).toBe('failed');
    expect(releases).toHaveLength(1);
    log.mockRestore();
  });

  it('releases when an interrupt landed before the run reached the runtime', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const releases: string[] = [];
    const posted: string[] = [];
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () =>
          Promise.resolve({
            runtimeProfileId: 'profile-e2b',
            driver: 'external',
            networkPolicy: 'none',
            filesystem: 'read-write',
            runnerUrl: 'http://manager:8080/runtimes/sealed-1',
            workspaceRoot: '/workspace',
          }),
      },
      buildRunRequest: async () => {
        await store.finish(RUN, 'cancelled', 'the run was interrupted by request');
        return RUN_REQUEST_FIXTURE;
      },
      releaseRunSandboxes: (_context, target) => {
        releases.push(target.runnerUrl);
        return Promise.resolve();
      },
      fetch: (input) => {
        posted.push(urlOf(input));
        return Promise.resolve(sse('event: run-done\ndata: {}\n\n'));
      },
    });
    launch(context(run));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(posted).toEqual([]);
  });

  it('still concludes the run, and keeps the failure off it, when the release fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { settled } = await launchWith({
      releaseRunSandboxes: () =>
        Promise.reject(new Error('runner manager answered HTTP 500 e2b_SECRET')),
      fetch: () => Promise.resolve(sse('event: run-done\ndata: {}\n\n')),
    });
    expect(settled.status).toBe('completed');
    expect(settled.error ?? '').not.toContain('e2b_SECRET');
    log.mockRestore();
  });

  it('releases nothing for a launch with no runtime target', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const releaseRunSandboxes = vi.fn<() => Promise<void>>(() => Promise.resolve());
    createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      releaseRunSandboxes,
      fetch: () => Promise.resolve(sse('event: run-done\ndata: {}\n\n')),
    })(context(run));
    expect((await settle(store)).status).toBe('completed');
    expect(releaseRunSandboxes).not.toHaveBeenCalled();
  });
});

describe('createRunnerLauncher runtime capacity wait (issue #557)', () => {
  const CAPACITY_BODY = {
    error: 'runner_capacity_exhausted',
    message: 'the runner is already serving 8 runs; retry when capacity is available.',
  };
  const FAST = { initialDelayMs: 1, maxDelayMs: 5, maxWaitMs: 10_000 } as const;

  function capacity429(headers?: Record<string, string>): Response {
    return Response.json(CAPACITY_BODY, { status: 429, ...(headers ? { headers } : {}) });
  }

  function urlOf(input: Parameters<typeof globalThis.fetch>[0]): string {
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  }

  it('re-posts the same request after capacity refusals and relays the stream that follows', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const posted: unknown[] = [];
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      capacityRetry: FAST,
      fetch: (input, init) => {
        expect(urlOf(input)).toBe('http://runner:8080/run');
        posted.push(init?.body);
        return Promise.resolve(
          posted.length <= 2
            ? capacity429()
            : sse('event: assistant\ndata: {"text":"hi"}\n\nevent: run-done\ndata: {}\n\n'),
        );
      },
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('completed');
    expect(settled.error).toBeNull();
    expect(posted).toHaveLength(3);
    expect(new Set(posted)).toEqual(new Set([JSON.stringify(RUN_REQUEST_FIXTURE)]));
    const events = await transcript(store);
    expect(events.map((event) => event.type)).toContain('assistant');
  });

  it('fails with the coded, retryable capacity error once the wait budget is spent, and collects nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const calls: string[] = [];
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () =>
          Promise.resolve({
            runtimeProfileId: 'profile-docker',
            driver: 'docker',
            networkPolicy: 'none',
            filesystem: 'read-write',
            persistPaths: ['output'],
            runnerUrl: 'http://runtime:8080',
            workspaceRoot: '/workspace',
          }),
      },
      buildRunRequest,
      workspaceLifecycle: {
        inputArchive: () => Promise.resolve(null),
        promoteOutputs: () => Promise.resolve(),
      },
      capacityRetry: { initialDelayMs: 1, maxDelayMs: 5, maxWaitMs: 30 },
      fetch: (input, init) => {
        calls.push(`${init?.method ?? 'GET'} ${urlOf(input)}`);
        return Promise.resolve(capacity429());
      },
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(parseRunFailure(settled.error)).toEqual({
      code: RUNTIME_CAPACITY_EXHAUSTED,
      message:
        'The runtime is serving its maximum number of concurrent runs; send the message again in a moment.',
    });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call === 'POST http://runtime:8080/run')).toBe(true);
    expect(log).toHaveBeenCalledWith('[runs] await-runtime-capacity failed', expect.anything());
    log.mockRestore();
  });

  it.each([
    ['a 429 with another body', () => Response.json({ error: 'rate_limited' }, { status: 429 })],
    [
      'a capacity body with an unexpected key',
      () => Response.json({ ...CAPACITY_BODY, extra: true }, { status: 429 }),
    ],
    ['an HTML 429 from a proxy', () => new Response('<html>Too Many</html>', { status: 429 })],
    ['a 503', () => Response.json(CAPACITY_BODY, { status: 503 })],
  ])('does not hide a real error: %s fails after one POST, as before', async (_name, answer) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let posts = 0;
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      capacityRetry: FAST,
      fetch: () => {
        posts += 1;
        return Promise.resolve(answer());
      },
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe('The runtime reported a run failure.');
    expect(parseRunFailure(settled.error)?.code).toBeNull();
    expect(posts).toBe(1);
    log.mockRestore();
  });

  it('stops waiting, posts nothing more and revokes the run tokens when an interrupt lands during the wait', async () => {
    resetLiveRuns();
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let posts = 0;
    let revoked = 0;
    let launchSettled: () => void = () => undefined;
    const settledLaunch = new Promise<void>((resolve) => {
      launchSettled = resolve;
    });
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      capacityRetry: FAST,
      revokeRunTokens: () => {
        revoked += 1;
        return Promise.resolve();
      },
      onLaunchSettled: () => {
        launchSettled();
      },
      fetch: async (input) => {
        if (urlOf(input).endsWith('/run')) {
          posts += 1;
          // The interrupt route makes the run terminal while the runtime is still full.
          await store.finish(RUN, 'cancelled', 'the run was interrupted by request');
          return capacity429();
        }
        return Response.json({}, { status: 409 });
      },
    });
    launch(context(run));
    await settledLaunch;
    expect(posts).toBe(1);
    expect(revoked).toBe(1);
    const settled = await settle(store);
    expect(settled.status).toBe('cancelled');
    expect(settled.error).toBe('the run was interrupted by request');
    let signalled = false;
    await signalLiveRun(RUN, () => {
      signalled = true;
      return Promise.reject(new Error('should not be called'));
    });
    expect(signalled).toBe(false);
  });

  it('fails with the credential-lifetime message when the lifetime runs out during the wait', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let interrupts = 0;
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      maxRunDurationMs: 25,
      capacityRetry: FAST,
      fetch: (input) => {
        if (urlOf(input).endsWith('/interrupt')) {
          interrupts += 1;
          return Promise.resolve(Response.json({}, { status: 409 }));
        }
        return Promise.resolve(capacity429());
      },
    });
    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe('The run exceeded its credential-bounded lifetime of 25ms.');
    expect(interrupts).toBe(1);
    log.mockRestore();
  });

  it('honours a Retry-After, clamped to the largest single wait', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const postedAt: number[] = [];
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      // Without Retry-After the first wait would be at most 1ms; with `Retry-After: 60` unclamped
      // it would be a minute. Clamped, it is exactly `maxDelayMs`.
      capacityRetry: { initialDelayMs: 1, maxDelayMs: 40, maxWaitMs: 10_000 },
      fetch: () => {
        postedAt.push(performance.now());
        return Promise.resolve(
          postedAt.length === 1
            ? capacity429({ 'Retry-After': '60' })
            : sse('event: run-done\ndata: {}\n\n'),
        );
      },
    });
    launch(context(run));
    expect((await settle(store)).status).toBe('completed');
    expect(postedAt).toHaveLength(2);
    const [first = 0, second = 0] = postedAt;
    expect(second - first).toBeGreaterThanOrEqual(35);
    expect(second - first).toBeLessThan(1_000);
  });

  it('keeps the backoff when the runtime sends Retry-After: 0, so a full runtime is not hammered', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Pin the jitter to its ceiling so the backoff is deterministic: 40, 80, 100, 100, … ms.
    const random = vi.spyOn(Math, 'random').mockReturnValue(1);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const postedAt: number[] = [];
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      capacityRetry: { initialDelayMs: 40, maxDelayMs: 100, maxWaitMs: 400 },
      fetch: () => {
        postedAt.push(performance.now());
        return Promise.resolve(capacity429({ 'Retry-After': '0' }));
      },
    });
    launch(context(run));
    const settled = await settle(store);
    random.mockRestore();
    log.mockRestore();
    expect(parseRunFailure(settled.error)?.code).toBe(RUNTIME_CAPACITY_EXHAUSTED);
    // Backoff over a 400ms budget is a handful of POSTs; a zero delay would be hundreds.
    expect(postedAt.length).toBeGreaterThan(1);
    expect(postedAt.length).toBeLessThanOrEqual(8);
    const [first = 0, second = 0] = postedAt;
    expect(second - first).toBeGreaterThanOrEqual(35);
  });

  it('fails the run, revokes its tokens and posts nothing more when the store cannot be read during the wait', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failNextGet = false;
    class FlakyStore extends InMemoryRunStore {
      override get(runId: string): Promise<RunRecord | null> {
        if (failNextGet) {
          failNextGet = false;
          return Promise.reject(new Error('the run store is unavailable'));
        }
        return super.get(runId);
      }
    }
    const store = new FlakyStore();
    const run = await newRun(store);
    let posts = 0;
    let revoked = 0;
    let launchSettled: () => void = () => undefined;
    const settledLaunch = new Promise<void>((resolve) => {
      launchSettled = resolve;
    });
    const launch = createRunnerLauncher({
      baseUrl: 'http://runner:8080',
      store,
      buildRunRequest,
      capacityRetry: FAST,
      revokeRunTokens: () => {
        revoked += 1;
        return Promise.resolve();
      },
      onLaunchSettled: () => {
        launchSettled();
      },
      fetch: () => {
        posts += 1;
        // The next store read is the launcher's own "is the run still running?" after the wait.
        failNextGet = true;
        return Promise.resolve(capacity429());
      },
    });
    launch(context(run));
    await settledLaunch;
    const settled = await store.get(RUN);
    expect(settled?.status).toBe('failed');
    expect(settled?.endedAt).not.toBeNull();
    expect(settled?.error).toBe(
      'The run status could not be read while it waited for runtime capacity.',
    );
    expect(posts).toBe(1);
    expect(revoked).toBe(1);
    expect(log).toHaveBeenCalledWith('[runs] read-run-status failed', expect.anything());
    log.mockRestore();
  });
});

// Issue #830 (ADR-0120 LC7): on Vercel Functions the launch is kept alive by `after()` and a run
// cannot outlive the function.
describe('createRunnerLauncher on a host with a function limit (issue #830)', () => {
  const HOST_LIMIT_MS = 285_000;

  // The host budget is measured with `Date.now()`; only `Date` is faked, so the elapsed time is
  // exactly what a test sets while the lifetime timers still run for real.
  afterEach(() => {
    vi.useRealTimers();
  });

  function target(
    timeoutSeconds?: number,
  ): Awaited<
    ReturnType<NonNullable<Parameters<typeof createRunnerLauncher>[0]['runtime']>['resolve']>
  > {
    return {
      runtimeProfileId: 'profile-docker',
      driver: 'docker',
      networkPolicy: 'none',
      filesystem: 'read-write',
      persistPaths: [],
      runnerUrl: 'http://runtime:8080',
      workspaceRoot: '/workspace',
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    };
  }

  it('hands the whole launch to keepAlive, and the run finishes with its events stored', async () => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const kept: Promise<void>[] = [];
    const launch = createRunnerLauncher({
      store,
      runtime: { resolve: () => Promise.resolve(target(HOST_LIMIT_MS / 1_000)) },
      buildRunRequest,
      hostMaxRunDurationMs: HOST_LIMIT_MS,
      keepAlive: (work) => {
        kept.push(work);
      },
      fetch: () =>
        Promise.resolve(
          sse(
            'event: sdk-message\ndata: {"n":1}\n\nevent: sdk-message\ndata: {"n":2}\n\nevent: run-done\ndata: {}\n\n',
          ),
        ),
    });

    launch(context(run));
    // Called once, before `launch` returned: the request that started the run is not what carries it.
    expect(kept).toHaveLength(1);
    expect((await store.get(RUN))?.status).toBe('queued');

    await kept[0];
    const finished = await store.get(RUN);
    expect(finished?.status).toBe('completed');
    expect(finished?.endedAt).not.toBeNull();
    const types = (await transcript(store)).map((event) => event.type);
    expect(types.filter((type) => type === 'sdk-message')).toHaveLength(2);
  });

  it('refuses a profile deadline longer than the host allows, before the runtime is contacted', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const fetchSpy = vi.fn(() => Promise.resolve(sse('event: run-done\ndata: {}\n\n')));
    const launch = createRunnerLauncher({
      store,
      runtime: { resolve: () => Promise.resolve(target(600)) },
      buildRunRequest,
      hostMaxRunDurationMs: HOST_LIMIT_MS,
      fetch: fetchSpy,
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(parseRunFailure(settled.error ?? '')?.code).toBe('run_deadline_exceeds_host');
    expect(fetchSpy).not.toHaveBeenCalled();
    log.mockRestore();
  });

  // Issue #831 (ADR-0127): a Cloudflare Container is a long-lived server. Its limit is the idle stop
  // less the margin, and it has no `keepAlive`: the launch outlives the request in its process.
  describe('on a Cloudflare Container (issue #831)', () => {
    const CONTAINER_LIMIT_MS = 885_000;

    it('finishes a run with no keepAlive, after the starting request has returned', async () => {
      const store = new InMemoryRunStore();
      const run = await newRun(store);
      const launch = createRunnerLauncher({
        store,
        runtime: { resolve: () => Promise.resolve(target(CONTAINER_LIMIT_MS / 1_000)) },
        buildRunRequest,
        hostMaxRunDurationMs: CONTAINER_LIMIT_MS,
        fetch: () =>
          Promise.resolve(
            sse('event: sdk-message\ndata: {"n":1}\n\nevent: run-done\ndata: {}\n\n'),
          ),
      });

      launch(context(run));
      expect((await store.get(RUN))?.status).toBe('queued');

      expect((await settle(store)).status).toBe('completed');
      const types = (await transcript(store)).map((event) => event.type);
      expect(types).toContain('sdk-message');
    });

    it('refuses a profile deadline of 886 s before the runtime is contacted', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const store = new InMemoryRunStore();
      const run = await newRun(store);
      const fetchSpy = vi.fn(() => Promise.resolve(sse('event: run-done\ndata: {}\n\n')));
      const launch = createRunnerLauncher({
        store,
        runtime: { resolve: () => Promise.resolve(target(886)) },
        buildRunRequest,
        hostMaxRunDurationMs: CONTAINER_LIMIT_MS,
        fetch: fetchSpy,
      });

      launch(context(run));
      const settled = await settle(store);
      expect(settled.status).toBe('failed');
      expect(parseRunFailure(settled.error ?? '')?.code).toBe('run_deadline_exceeds_host');
      expect(fetchSpy).not.toHaveBeenCalled();
      log.mockRestore();
    });
  });

  it('cuts off a run with no deadline at the host limit and interrupts the runtime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let interrupts = 0;
    const launch = createRunnerLauncher({
      store,
      runtime: { resolve: () => Promise.resolve(target()) },
      buildRunRequest,
      connectTimeoutMs: 1_000,
      hostMaxRunDurationMs: 25,
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/interrupt')) {
          interrupts += 1;
          return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('lifetime abort')));
        });
      },
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe(
      "The run exceeded its host-limited lifetime of 25ms (the host's function limit ended it).",
    );
    expect(interrupts).toBe(1);
  });

  it('counts the host limit from the launch, so a slow preparation shortens the run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    let interrupts = 0;
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () => {
          // A preparation that took 150ms of the host's 200ms.
          vi.setSystemTime(Date.now() + 150);
          return Promise.resolve(target());
        },
      },
      buildRunRequest,
      connectTimeoutMs: 1_000,
      hostMaxRunDurationMs: 200,
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/interrupt')) {
          interrupts += 1;
          return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('lifetime abort')));
        });
      },
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    // What was left of the 200ms after a 150ms preparation, not a fresh 200ms.
    expect(settled.error).toBe(
      "The run exceeded its host-limited lifetime of 50ms (the host's function limit ended it).",
    );
    expect(interrupts).toBe(1);
  });

  it('refuses a run whose preparation used the whole host budget, before the runtime is contacted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const fetchSpy = vi.fn(() => Promise.resolve(sse('event: run-done\ndata: {}\n\n')));
    const launch = createRunnerLauncher({
      store,
      runtime: {
        resolve: () => {
          vi.setSystemTime(Date.now() + 200);
          return Promise.resolve(target());
        },
      },
      buildRunRequest,
      hostMaxRunDurationMs: 200,
      fetch: fetchSpy,
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.status).toBe('failed');
    expect(parseRunFailure(settled.error ?? '')?.code).toBe('run_deadline_exceeds_host');
    expect(fetchSpy).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('names the credential bound, not the host, when the credential lifetime is the shorter one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const launch = createRunnerLauncher({
      store,
      runtime: { resolve: () => Promise.resolve(target()) },
      buildRunRequest,
      connectTimeoutMs: 1_000,
      maxRunDurationMs: 25,
      hostMaxRunDurationMs: HOST_LIMIT_MS,
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/interrupt')) {
          return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('lifetime abort')));
        });
      },
    });

    launch(context(run));
    const settled = await settle(store);
    expect(settled.error).toBe('The run exceeded its credential-bounded lifetime of 25ms.');
  });
});
