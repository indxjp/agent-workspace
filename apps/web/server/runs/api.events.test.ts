import { log as webLogger } from '../telemetry/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetTestRunApi } from '../application-context-fixtures';
import { classifyRunOutcome, startRun, streamRunEvents } from './api';
import {
  AGENT,
  errorCode,
  get,
  install,
  post,
  PRINCIPAL,
  readAll,
  SESSION,
  startedRun,
  WORKSPACE,
} from './api.test-support';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './memory-store';
import { type RunRecord, type RunStatus, runStatuses } from './store';

afterEach(() => {
  resetTestRunApi();
});

function handoffFrames(reason: string): Array<Record<string, unknown> & { frame: string }> {
  const tool = 'mcp__agent-workspace__handoff_to_person';
  const turn = {
    type: 'assistant',
    message: {
      id: 'm1',
      content: [
        { type: 'text', text: 'One moment.' },
        { type: 'tool_use', id: 'call_1', name: tool, input: { reason } },
      ],
    },
  };
  const engine = 'claude-agent-sdk';
  const frames = [
    {
      frame: 'agent.message',
      engine,
      raw: turn,
      messageId: 'm1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'One moment.' }],
    },
    {
      frame: 'agent.tool.call',
      engine,
      raw: turn,
      toolCallId: 'call_1',
      name: tool,
      kind: 'mcp',
      input: { reason },
    },
    {
      frame: 'agent.tool.result',
      engine,
      raw: null,
      toolCallId: 'call_1',
      status: 'completed',
      output: `noted: ${reason}`,
      isError: false,
    },
    {
      frame: 'agent.result',
      engine,
      raw: { type: 'result', result: 'A person will take over.' },
      stopReason: 'end_turn',
      turns: 1,
      engineCostUsd: null,
    },
    { frame: 'agent.handoff', engine, raw: { type: 'result', note: reason }, reason },
  ];
  return frames;
}

describe('GET /api/runs/:id/events', () => {
  it('streams the run and closes with done when the run finishes', async () => {
    const harness = install();
    const runId = await startedRun();
    await harness.store.append(runId, { type: 'assistant', data: { text: 'hello' } });

    const response = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const text = readAll(response);
    await harness.store.finish(runId, 'completed', null);
    const body = await text;
    expect(body).toContain('retry: 3000');
    expect(body).toMatch(
      /event: assistant\nid: 1\nat: \d{4}-\d\d-\d\dT[\d:.]+Z\ndata: \{"text":"hello"\}\n/u,
    );
    expect(body.endsWith('event: done\ndata: {}\n\n')).toBe(true);
  });
  it('lets an Admin stream another member’s transcript where a Viewer is refused — `events` inherits its parent’s grants, issue #165', async () => {
    const harness = install();
    const runId = await startedRun();
    await harness.store.append(runId, { type: 'assistant', data: { text: 'hello' } });
    await harness.store.finish(runId, 'completed', null);

    install({
      store: harness.store,
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'admin' }),
      ownsRun: () => Promise.resolve(false),
    });
    const admin = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    expect(admin.status).toBe(200);
    // The transcript itself, not merely the status code: run events carry prompt and response
    // text, so this is the real privacy surface the widening opens, and
    // docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md says so rather than leaving it to
    // be discovered.
    expect(await readAll(admin)).toContain('"hello"');

    install({
      store: harness.store,
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
      ownsRun: () => Promise.resolve(false),
    });
    const viewer = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    expect(viewer.status).toBe(403);
  });
});

describe('GET /api/runs/:id/events', () => {
  it('serves a visitor no frame that carries the operator-only handoff reason (ADR-0145 D4)', async () => {
    const harness = install();
    const runId = await startedRun();
    const reason = 'Wants a refund over the "limit".';
    const frames = handoffFrames(reason);
    for (const data of frames) await harness.store.append(runId, { type: data.frame, data });
    await harness.store.finish(runId, 'completed', null);
    const run = await harness.store.get(runId);
    if (run?.sessionId == null) throw new Error('the started run has no session');
    const onWire = JSON.stringify(reason).slice(1, -1);

    const operator = await readAll(
      await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId),
    );
    expect(operator).toContain(`"reason":"${onWire}"`);

    install({
      store: harness.store,
      authenticate: () =>
        Promise.resolve({ ...PRINCIPAL, scope: { kind: 'session', id: run.sessionId } }),
    });
    const response = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    expect(response.status).toBe(200);
    const visitor = await readAll(response);
    for (const frame of frames)
      expect(visitor).toContain(`event: ${frame.frame}
`);
    expect(visitor).toContain('A person will take over.');
    expect(visitor).not.toContain(onWire);
    expect(visitor).not.toContain('Wants a refund');
    expect(visitor).not.toContain('"reason"');
  });
});

describe('GET /api/runs/:id/events', () => {
  it('serves no frame that names the run directory on the runtime host (UX-02 in #2086)', async () => {
    const harness = install();
    const runId = await startedRun();
    const run = await harness.store.get(runId);
    if (run === null) throw new Error('the run was not stored');
    const cwd = `/srv/host/runner-ws/${run.workspaceId}/${run.sessionId}`;
    const engine = 'claude-agent-sdk';
    const frames = [
      {
        frame: 'agent.session',
        engine,
        raw: { type: 'system', subtype: 'init', cwd, session_id: 's1' },
        engineSessionId: 's1',
        model: null,
      },
      {
        frame: 'agent.tool.result',
        engine,
        raw: null,
        toolCallId: 'call_1',
        status: 'completed',
        output: `File created successfully at: ${cwd}/outputs/report.md`,
        isError: false,
      },
    ];
    for (const data of frames) await harness.store.append(runId, { type: data.frame, data });
    await harness.store.finish(runId, 'completed', null);

    const operator = await readAll(
      await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId),
    );
    install({
      store: harness.store,
      authenticate: () =>
        Promise.resolve({ ...PRINCIPAL, scope: { kind: 'session', id: run.sessionId } }),
    });
    const visitor = await readAll(
      await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId),
    );
    for (const body of [operator, visitor]) {
      expect(body).not.toContain('/srv/host');
      expect(body).toContain('"cwd":"<workspace>"');
      expect(body).toContain('File created successfully at: <workspace>/outputs/report.md');
    }
  });

  it('replays from Last-Event-ID and delivers no duplicate', async () => {
    const harness = install();
    const runId = await startedRun();
    for (const text of ['a', 'b', 'c']) {
      await harness.store.append(runId, { type: 'assistant', data: text });
    }
    await harness.store.finish(runId, 'completed', null);

    const response = await streamRunEvents(
      get(`http://web/api/runs/${runId}/events`, { 'Last-Event-ID': '2' }),
      runId,
    );
    const body = await readAll(response);
    expect(body).not.toContain('"a"');
    expect(body).not.toContain('"b"');
    expect(body).toMatch(/event: assistant\nid: 3\nat: [\d\-T:.]+Z\ndata: "c"\n/u);
    expect(body).not.toContain('stream-reset');
  });

  it('accepts ?after= for a manually reconstructed EventSource', async () => {
    const harness = install();
    const runId = await startedRun();
    await harness.store.append(runId, { type: 'assistant', data: 'a' });
    await harness.store.append(runId, { type: 'assistant', data: 'b' });
    await harness.store.finish(runId, 'completed', null);
    const response = await streamRunEvents(
      get(`http://web/api/runs/${runId}/events?after=1`),
      runId,
    );
    const body = await readAll(response);
    expect(body).not.toContain('"a"');
    expect(body).toContain('id: 2');
  });

  it('rejects a malformed resume cursor with 400 instead of restarting from zero', async () => {
    install();
    const runId = await startedRun();
    const response = await streamRunEvents(
      get(`http://web/api/runs/${runId}/events`, { 'Last-Event-ID': 'nonsense' }),
      runId,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_resume_cursor');
  });

  it('rejects the cursor before it looks the run up, so a bad id cannot probe for runs', async () => {
    install();
    const response = await streamRunEvents(
      get(`http://web/api/runs/${SESSION}/events`, { 'Last-Event-ID': '-1' }),
      SESSION,
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/runs/:id/events', () => {
  it('announces a stream-reset in band when the cursor is unservable', async () => {
    const store = new InMemoryRunStore({ maxEventsPerRun: 2 });
    install({ store });
    const runId = await startedRun();
    for (const text of ['a', 'b', 'c', 'd']) {
      await store.append(runId, { type: 'assistant', data: text });
    }
    await store.finish(runId, 'completed', null);
    const response = await streamRunEvents(
      get(`http://web/api/runs/${runId}/events`, { 'Last-EVENT-id': '1' }),
      runId,
    );
    expect(response.status).toBe(200);
    const body = await readAll(response);
    expect(body).toContain('event: stream-reset');
    expect(body).toContain('"resumedAfter":"2"');
    expect(body).toContain('id: 3');
  });

  it('returns 401, 400 and 404 before it opens any stream', async () => {
    install();
    const runId = await startedRun();
    expect(
      (await streamRunEvents(get(`http://web/api/runs/${runId}/events`, {}, false), runId)).status,
    ).toBe(401);
    expect((await streamRunEvents(get('http://web/api/runs/x/events'), 'x')).status).toBe(400);
    expect(
      (await streamRunEvents(get(`http://web/api/runs/${SESSION}/events`), SESSION)).status,
    ).toBe(404);
  });

  it('tears the subscription down when the client disconnects', async () => {
    const harness = install();
    const runId = await startedRun();
    const controller = new AbortController();
    const request = new Request(`http://web/api/runs/${runId}/events`, {
      headers: { 'x-test-user': '1' },
      signal: controller.signal,
    });
    const response = await streamRunEvents(request, runId);
    const body = response.body;
    if (body === null) throw new Error('no body');
    const reader = body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel();
    // The store must accept a new subscriber afterwards and deliver to it, which it cannot do if
    // the aborted one left its listener behind holding the run open.
    await harness.store.append(runId, { type: 'assistant', data: 'later' });
    await harness.store.finish(runId, 'completed', null);
    const second = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    expect(await readAll(second)).toContain('"later"');
  });
});

/**
 * The end of a stream must state the run's outcome, not merely that the stream is over.
 *
 * The reproduction is a run whose runtime is unreachable: `createRunnerLauncher` writes `failed`
 * onto the record, and a client watching the stream has to be able to tell that apart from a run
 * that succeeded — without a second request, because the whole point of §19's stream is that the
 * transcript is self-describing.
 */
describe('a run that ends failed', () => {
  it('ends the stream with run-failed before done, carrying the run error', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const store = new InMemoryRunStore();
    const harness = install(
      {
        launch: createRunnerLauncher({
          baseUrl: 'http://runner.invalid',
          store,
          // The §14.3 body is the composition root's to build (`server/compose/run-request.ts`);
          // this test is about what a client sees when the runtime cannot be reached, so the
          // body only has to exist.
          buildRunRequest: () => ({ runId: 'unused' }),
          fetch: (): Promise<Response> => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
        }),
      },
      store,
    );
    const created = (await (await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).json()) as {
      run: { id: string };
    };
    const runId = created.run.id;

    const response = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    const body = await readAll(response);

    expect(body).toContain('event: run-failed');
    expect(body).toContain('The runtime could not be reached.');
    expect(body).not.toContain('getaddrinfo ENOTFOUND');
    expect(body.endsWith('event: done\ndata: {}\n\n')).toBe(true);
    // `run-failed` precedes `done`, so a client that closes on `done` has already seen it.
    expect(body.indexOf('event: run-failed')).toBeLessThan(body.indexOf('event: done'));
    expect((await harness.store.get(runId))?.status).toBe('failed');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('sends no run-failed frame for a run that completed', async () => {
    const harness = install();
    const created = (await (await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).json()) as {
      run: { id: string };
    };
    const runId = created.run.id;
    await harness.store.finish(runId, 'completed', null);
    const response = await streamRunEvents(get(`http://web/api/runs/${runId}/events`), runId);
    const body = await readAll(response);
    expect(body).not.toContain('run-failed');
    expect(body.endsWith('event: done\ndata: {}\n\n')).toBe(true);
  });
});

/**
 * The classifier that decides what the last frames of a stream say.
 *
 * Its `succeeded` arm is the only one that lets a stream end with a bare `done`, and it is
 * reachable only from a record that positively reads `completed` (ADR-0015). The table below is
 * driven from `runStatuses` so a status added to the lifecycle and not to the classifier fails
 * here rather than falling through to `succeeded` in production.
 */
describe('classifyRunOutcome', () => {
  const record = (status: RunStatus, error: string | null = null): RunRecord => ({
    id: SESSION,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    sessionId: SESSION,
    status,
    createdAt: new Date(0),
    startedAt: null,
    endedAt: null,
    error,
  });

  it('treats a run as successful only when its record says completed', () => {
    const succeeding = runStatuses.filter(
      (status) => classifyRunOutcome(record(status), SESSION).kind === 'succeeded',
    );
    expect(succeeding).toEqual(['completed']);
  });

  it('reports every other terminal status as a failure, with the run error', () => {
    expect(classifyRunOutcome(record('failed', 'the runtime vanished'), SESSION)).toEqual({
      kind: 'failed',
      status: 'failed',
      message: 'the runtime vanished',
    });
    expect(classifyRunOutcome(record('cancelled'), SESSION).kind).toBe('failed');
  });

  it('reports a run paused for approval as paused, not as a failure or a success', () => {
    expect(classifyRunOutcome(record('awaiting_approval'), SESSION)).toEqual({ kind: 'paused' });
  });

  it('never claims an outcome it does not have', () => {
    for (const status of ['queued', 'running'] as const) {
      expect(classifyRunOutcome(record(status), SESSION).kind).toBe('indeterminate');
    }
    expect(classifyRunOutcome(null, SESSION).kind).toBe('indeterminate');
  });
});
