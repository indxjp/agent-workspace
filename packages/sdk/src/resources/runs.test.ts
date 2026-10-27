import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  ApiProblemError,
  ContractViolationError,
  InvalidArgumentError,
  TransportError,
} from '../errors.js';
import { toAgentEvent } from '../events/agent-event.js';
import { HttpClient } from '../http.js';
import {
  drain,
  droppedEventStreamResponse as dropped,
  eventStreamResponse as stream,
  fetchDouble,
  jsonResponse as json,
  openEventStreamResponse as open,
  type RecordedRequest,
} from '../testing.js';
import { RunsClient, runFailure } from './runs.js';

const AGENT = '11111111-1111-4111-8111-111111111111';
const RUN = '33333333-3333-4333-8333-333333333333';

const run = (status: string, output: unknown = null) => ({
  id: RUN,
  workspaceId: '44444444-4444-4444-8444-444444444444',
  agentId: AGENT,
  projectId: null,
  initiatingUserId: null,
  sessionId: '55555555-5555-4555-8555-555555555555',
  agentVersion: null,
  status,
  createdAt: '2026-09-21T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
  durationMs: null,
  model: null,
  provider: null,
  modelConnectionId: null,
  engine: 'claude-agent-sdk',
  engineVersion: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
  },
  cost: { amount: '0.000000', currency: 'USD', priceTableVersion: null },
  error: null,
  output,
  pendingApproval:
    status === 'awaiting_approval' ? { toolName: 'send_email', canonicalCall: '{}' } : null,
  accountingState: 'pending',
  accountingError: null,
});

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly runs: RunsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { runs: new RunsClient(http), calls: api.calls };
}

describe('RunsClient.start', () => {
  it('posts the wire body the route parses and reads the 202', async () => {
    const { runs, calls } = client(() =>
      json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
    );
    const started = await runs.start(AGENT, {
      prompt: 'Hello',
      modelOverride: { connectionId: '22222222-2222-4222-8222-222222222222', model: 'm' },
    });
    expect(started.run.status).toBe('queued');
    expect(started.events).toBe(`/api/runs/${RUN}/events`);
    const [call] = calls;
    expect(call?.url.pathname).toBe(`/api/agents/${AGENT}/runs`);
    expect(call?.json).toEqual({
      prompt: 'Hello',
      sessionId: null,
      modelConnectionId: '22222222-2222-4222-8222-222222222222',
      model: 'm',
    });
  });

  it('sends the version a run is targeted at, and only then (issue #697)', async () => {
    const { runs, calls } = client(() =>
      json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
    );
    await runs.start(AGENT, { prompt: 'Hello', version: 3 });
    await runs.start(AGENT, { prompt: 'Hello' });
    expect(calls[0]?.json).toMatchObject({ version: 3 });
    expect(calls[1]?.json).not.toHaveProperty('version');
  });

  it('sends the subject a run acts for, and only when given (ADR-0142 D2)', async () => {
    const { runs, calls } = client(() =>
      json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
    );
    await runs.start(AGENT, { prompt: 'Hello', subject: 'customer-17' });
    await runs.start(AGENT, { prompt: 'Hello' });
    expect(calls[0]?.json).toMatchObject({ subject: 'customer-17' });
    expect(calls[1]?.json).not.toHaveProperty('subject');
  });

  it('sends the file scope a run is narrowed to, and only when given (issue #1539)', async () => {
    const { runs, calls } = client(() =>
      json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
    );
    await runs.start(AGENT, { prompt: 'Hello', fileScope: ['docs/alice', 'docs/b.md'] });
    await runs.start(AGENT, { prompt: 'Hello' });
    expect(calls[0]?.json).toMatchObject({ fileScope: ['docs/alice', 'docs/b.md'] });
    expect(calls[1]?.json).not.toHaveProperty('fileScope');
  });

  it('sends idempotencyKey as the Idempotency-Key header, not in the body, and only when given (ADR-0151)', async () => {
    const { runs, calls } = client(() =>
      json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
    );
    await runs.start(AGENT, { prompt: 'Hello', idempotencyKey: 'order-17-reply' });
    await runs.start(AGENT, { prompt: 'Hello' });
    expect(calls[0]?.headers.get('idempotency-key')).toBe('order-17-reply');
    expect(calls[0]?.json).not.toHaveProperty('idempotencyKey');
    expect(calls[1]?.headers.has('idempotency-key')).toBe(false);
  });

  it('surfaces run_idempotency_conflict (409) by code (ADR-0151)', async () => {
    const { runs } = client(() =>
      json(409, { error: { code: 'run_idempotency_conflict', message: 'send a new key' } }),
    );
    const failure = await runs
      .start(AGENT, { prompt: 'x', idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('run_idempotency_conflict');
  });

  it('surfaces run_subject_forbidden (403) by code (ADR-0142 D2)', async () => {
    const { runs } = client(() =>
      json(403, { error: { code: 'run_subject_forbidden', message: 'only an API key' } }),
    );
    const failure = await runs.start(AGENT, { prompt: 'x', subject: 'a' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('run_subject_forbidden');
  });

  it('sends attachments as file ids, and only when given (issue #1307)', async () => {
    const { runs, calls } = client(() =>
      json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
    );
    await runs.start(AGENT, {
      prompt: 'Hello',
      attachments: [{ fileId: 'f-1' }, { fileId: 'f-2' }],
    });
    await runs.start(AGENT, { prompt: 'Hello' });
    expect(calls[0]?.json).toMatchObject({ attachments: [{ fileId: 'f-1' }, { fileId: 'f-2' }] });
    expect(calls[1]?.json).not.toHaveProperty('attachments');
  });

  it.each([
    [404, 'file_not_found'],
    [422, 'run_attachments_unreadable'],
    [422, 'run_attachments_too_large'],
    [422, 'run_attachments_unsupported_runtime'],
    [422, 'run_attachments_untranscribable'],
  ])('surfaces the %i attachment refusal by code (issue #1307)', async (status, code) => {
    const { runs } = client(() => json(status, { error: { code, message: 'refused' } }));
    const failure = await runs
      .start(AGENT, { prompt: 'x', attachments: [{ fileId: 'f-1' }] })
      .catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe(code);
  });

  it('sends a Zod outputSchema as JSON Schema 2020-12, and a JSON Schema as it is (ADR-0143)', async () => {
    const { runs, calls } = client(() =>
      json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
    );
    await runs.start(AGENT, {
      prompt: 'Hello',
      outputSchema: z.object({ verdict: z.string() }),
    });
    const plain = { type: 'object', properties: { n: { type: 'number' } } };
    await runs.start(AGENT, { prompt: 'Hello', outputSchema: plain });
    await runs.start(AGENT, { prompt: 'Hello' });
    expect(calls[0]?.json).toMatchObject({
      outputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { verdict: { type: 'string' } },
        required: ['verdict'],
      },
    });
    expect(calls[1]?.json).toMatchObject({ outputSchema: plain });
    expect(calls[2]?.json).not.toHaveProperty('outputSchema');
  });

  it('refuses a Zod schema with no JSON Schema form as InvalidArgumentError, keeping the cause', async () => {
    const { runs, calls } = client(() => json(202, { run: run('queued'), events: '' }));
    const refusal: unknown = await runs
      .start(AGENT, { prompt: 'x', outputSchema: z.object({ d: z.date() }) })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(InvalidArgumentError);
    expect(refusal).toMatchObject({ code: 'unconvertible_output_schema', value: null });
    expect((refusal as Error).cause).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
  });

  it('surfaces engine_capability_unsupported (422) with its capability (ADR-0143)', async () => {
    const { runs } = client(() =>
      json(422, {
        error: {
          code: 'engine_capability_unsupported',
          message: 'no structured output',
          details: ['structuredOutput'],
        },
      }),
    );
    const failure = await runs
      .start(AGENT, { prompt: 'x', outputSchema: { type: 'object' } })
      .catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('engine_capability_unsupported');
    expect((failure as ApiProblemError).details).toEqual(['structuredOutput']);
  });

  it('surfaces agent_version_not_found (404) by code (issue #697)', async () => {
    const { runs } = client(() =>
      json(404, { error: { code: 'agent_version_not_found', message: 'no version 9' } }),
    );
    const failure = await runs.start(AGENT, { prompt: 'x', version: 9 }).catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('agent_version_not_found');
  });

  it('surfaces the route refusal by code', async () => {
    const { runs } = client(() =>
      json(409, { error: { code: 'session_not_usable', message: 'omit sessionId' } }),
    );
    const failure = await runs
      .start(AGENT, { prompt: 'x', sessionId: RUN })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('session_not_usable');
  });

  it('surfaces session_engine_mismatch (409) by code, apart from session_not_usable (ADR-0065)', async () => {
    // Both are 409s on the same call, and a caller acts differently on each: `session_not_usable`
    // means "omit sessionId and this will work", while a pinned session means the *agent's* engine
    // changed. Branching on `status` alone would conflate them, which is why the code is asserted.
    const { runs } = client(() =>
      json(409, {
        error: {
          code: 'session_engine_mismatch',
          message:
            "this session runs on the engine 'claude-agent-sdk' and the agent's policy now names 'pi'.",
        },
      }),
    );
    const failure = await runs
      .start(AGENT, { prompt: 'x', sessionId: RUN })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(409);
    expect((failure as ApiProblemError).code).toBe('session_engine_mismatch');
  });
});

describe('runs.start refusals (issue #393)', () => {
  it('surfaces agent_runtime_profile_missing (422) by code, before any run exists', async () => {
    const { runs } = client(() =>
      json(422, {
        error: {
          code: 'agent_runtime_profile_missing',
          message: 'agent "General" has no runtime profile.',
        },
      }),
    );
    const failure = await runs.start(AGENT, { prompt: 'x' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(422);
    expect((failure as ApiProblemError).code).toBe('agent_runtime_profile_missing');
  });
});

describe('runFailure', () => {
  it('reads the code a queued run was refused with back out of its error', async () => {
    const { runs } = client(() =>
      json(200, {
        run: {
          ...run('failed'),
          error: 'model_connection_unresolved: no workspace default is configured.',
        },
      }),
    );
    expect(runFailure(await runs.get(RUN))).toEqual({
      code: 'model_connection_unresolved',
      message: 'no workspace default is configured.',
    });
  });

  it('answers null for a run that did not fail, and no code for an uncoded failure', async () => {
    const { runs } = client(() => json(200, { run: { ...run('completed') } }));
    expect(runFailure(await runs.get(RUN))).toBeNull();
    const failed = client(() =>
      json(200, { run: { ...run('failed'), error: 'The workspace could not be prepared.' } }),
    );
    expect(runFailure(await failed.runs.get(RUN))).toEqual({
      code: null,
      message: 'The workspace could not be prepared.',
    });
  });
});

describe('RunsClient.list', () => {
  it('renders the query and reads the page', async () => {
    const { runs, calls } = client(() =>
      json(200, { runs: [run('completed')], nextCursor: 'abc' }),
    );
    const page = await runs.list({ status: 'completed', limit: 1 });
    expect(page.nextCursor).toBe('abc');
    expect(calls[0]?.url.search).toBe('?status=completed&limit=1');
  });
});

describe('RunsClient.events', () => {
  it('classifies platform frames, passes runtime frames through, and ends on done', async () => {
    const { runs, calls } = client(() =>
      stream(
        'retry: 3000\n\n' +
          'event: run.status\nid: 1\ndata: {"status":"running","error":null}\n\n' +
          'event: sdk-event\nid: 2\ndata: {"kind":"event","type":"assistant"}\n\n' +
          'event: run-failed\ndata: {"status":"failed","message":"The runtime exited."}\n\n' +
          'event: done\ndata: null\n\n',
      ),
    );
    const frames = [];
    const iterator = runs.events(RUN, { after: null });
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        expect(next.value).toEqual({ lastEventId: '2' });
        break;
      }
      frames.push(next.value);
    }
    expect(frames).toEqual([
      { kind: 'run-status', id: '1', data: { status: 'running', error: null } },
      { kind: 'runtime', id: '2', name: 'sdk-event', data: { kind: 'event', type: 'assistant' } },
      { kind: 'run-failed', data: { status: 'failed', message: 'The runtime exited.' } },
    ]);
    expect(calls[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(calls[0]?.headers.has('last-event-id')).toBe(false);
  });

  it('classifies run.warning before the first agent frame as a platform notice, never an agent event (ADR-0146)', async () => {
    const { runs } = client(() =>
      stream(
        'event: run.status\nid: 1\ndata: {"status":"running","error":null}\n\n' +
          'event: run.warning\nid: 2\ndata: {"code":"attachments_removed_shell"}\n\n' +
          'event: agent.message\nid: 3\ndata: {"frame":"agent.message","engine":"claude-agent-sdk","raw":null,"messageId":"m1","role":"assistant","blocks":[{"type":"text","text":"hi"}]}\n\n' +
          'event: done\ndata: null\n\n',
      ),
    );
    const frames = [];
    const iterator = runs.events(RUN);
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        expect(next.value).toEqual({ lastEventId: '3' });
        break;
      }
      frames.push(next.value);
    }
    expect(frames[1]).toEqual({
      kind: 'run-warning',
      id: '2',
      data: { code: 'attachments_removed_shell' },
    });
    expect(frames.map((frame) => toAgentEvent(frame)?.frame ?? null)).toEqual([
      null,
      null,
      'agent.message',
    ]);
  });

  it('refuses a run.warning without a code as a contract violation', async () => {
    const { runs } = client(() => stream('event: run.warning\nid: 1\ndata: {}\n\n'));
    const failure = await drain(runs.events(RUN)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('sends Last-Event-ID when resuming', async () => {
    const { runs, calls } = client(() => stream('event: done\n\n'));
    await drain(runs.events(RUN, { after: '41' }));
    expect(calls[0]?.headers.get('last-event-id')).toBe('41');
  });

  it('refuses a malformed platform frame as a contract violation', async () => {
    const { runs } = client(() => stream('event: run.status\nid: 1\ndata: {"status":"lost"}\n\n'));
    const failure = await drain(runs.events(RUN)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a stream that ends without done as a transport failure, not a success', async () => {
    const { runs } = client(() => stream('event: sdk-event\nid: 5\ndata: {"kind":"event"}\n\n'));
    const failure = await drain(runs.events(RUN)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(false);
  });

  it('reports a body that errors mid-stream as a transport failure, not a raw TypeError', async () => {
    const { runs } = client(() => dropped('event: sdk-event\nid: 5\ndata: {"kind":"event"}\n\n'));
    const frames: string[] = [];
    const failure = await (async () => {
      for await (const frame of runs.events(RUN)) frames.push(frame.kind);
    })().catch((e: unknown) => e);
    expect(frames).toEqual(['runtime']);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(false);
    expect((failure as TransportError).cause).toBeInstanceOf(TypeError);
  });

  it('refuses a 200 that is not an event stream as a contract violation and releases the body', async () => {
    let cancelled = false;
    const html = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html>oops</html>'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { runs } = client(
      () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const failure = await runs
      .events(RUN)
      .next()
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues[0]).toContain('text/html');
    expect(cancelled).toBe(true);
  });

  it('cancels the body when the consumer stops iterating early', async () => {
    const body = open('event: sdk-event\nid: 1\ndata: {}\n\n');
    const { runs } = client(() => body.response);
    for await (const frame of runs.events(RUN)) {
      expect(frame.kind).toBe('runtime');
      break;
    }
    expect(body.cancelled()).toBe(true);
  });
});

describe('RunsClient.follow', () => {
  it('does not send an empty event id as a resume cursor after a dropped connection', async () => {
    let attempt = 0;
    const { runs, calls } = client(() => {
      attempt += 1;
      return attempt === 1
        ? stream(
            'event: sdk-event\nid: 5\ndata: {"kind":"event"}\n\nevent: sdk-event\nid:\ndata: {"kind":"event"}\n\n',
          )
        : stream('event: done\n\n');
    });
    const seen: string[] = [];
    for await (const frame of runs.follow(RUN, { reconnectDelayMs: 0 })) seen.push(frame.kind);
    expect(seen).toEqual(['runtime', 'runtime']);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.has('last-event-id')).toBe(false);
  });

  it('reconnects after a dropped connection with the last durable id, then ends on done', async () => {
    let attempt = 0;
    const { runs, calls } = client(() => {
      attempt += 1;
      return attempt === 1
        ? stream(
            'event: sdk-event\nid: 5\ndata: {"kind":"event"}\n\nevent: run-failed\ndata: {"status":"unknown","message":"x"}\n\n',
          )
        : stream('event: sdk-event\nid: 6\ndata: {"kind":"event"}\n\nevent: done\n\n');
    });
    const seen: string[] = [];
    for await (const frame of runs.follow(RUN, { reconnectDelayMs: 0 })) {
      seen.push(frame.kind === 'runtime' ? `runtime:${frame.id ?? ''}` : frame.kind);
    }
    expect(seen).toEqual(['runtime:5', 'run-failed', 'runtime:6']);
    expect(calls[0]?.headers.has('last-event-id')).toBe(false);
    expect(calls[1]?.headers.get('last-event-id')).toBe('5');
  });

  it('reconnects with the last durable id after the body errors mid-stream', async () => {
    let attempt = 0;
    const { runs, calls } = client(() => {
      attempt += 1;
      return attempt === 1
        ? dropped('event: sdk-event\nid: 5\ndata: {"kind":"event"}\n\n')
        : stream('event: sdk-event\nid: 6\ndata: {"kind":"event"}\n\nevent: done\n\n');
    });
    const seen: string[] = [];
    for await (const frame of runs.follow(RUN, { reconnectDelayMs: 0 })) {
      seen.push(frame.kind === 'runtime' ? `runtime:${frame.id ?? ''}` : frame.kind);
    }
    expect(seen).toEqual(['runtime:5', 'runtime:6']);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get('last-event-id')).toBe('5');
  });

  it('cancels the connection when the consumer breaks out of the loop', async () => {
    const body = open('event: sdk-event\nid: 1\ndata: {}\n\n');
    const { runs, calls } = client(() => body.response);
    for await (const frame of runs.follow(RUN, { reconnectDelayMs: 0 })) {
      expect(frame.kind).toBe('runtime');
      break;
    }
    expect(body.cancelled()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a 200 that is not an event stream', async () => {
    const { runs, calls } = client(() => json(200, { run: run('queued') }));
    const failure = await drain(runs.follow(RUN, { reconnectDelayMs: 0 })).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect(calls).toHaveLength(1);
  });

  it('ends with an aborted transport failure when the signal aborts while the stream is open', async () => {
    const during = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: sdk-event\nid: 1\ndata: {}\n\n'));
      },
      pull() {
        // The consumer gives up while the server still has the connection open.
        during.abort();
      },
    });
    const { runs, calls } = client(
      () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const seen: string[] = [];
    const failure = await (async () => {
      for await (const frame of runs.follow(RUN, { signal: during.signal })) seen.push(frame.kind);
    })().catch((e: unknown) => e);
    expect(seen).toEqual(['runtime']);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('ends with an aborted transport failure when the signal aborts between connections', async () => {
    const between = new AbortController();
    const { runs, calls } = client(() => dropped('event: sdk-event\nid: 1\ndata: {}\n\n'));
    const failure = await (async () => {
      for await (const frame of runs.follow(RUN, {
        reconnectDelayMs: 10_000,
        signal: between.signal,
      })) {
        expect(frame.kind).toBe('runtime');
        // The drop is observed within the microtask queue; this fires once follow() is waiting.
        setTimeout(() => between.abort(), 0);
      }
    })().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('reconnects again after a headers timeout on a reconnect, which is a drop and not an abort', async () => {
    let attempt = 0;
    const api = fetchDouble((request) => {
      attempt += 1;
      if (attempt === 1) return dropped('event: sdk-event\nid: 1\ndata: {}\n\n');
      if (attempt === 2) {
        // No headers within timeoutMs: the deadline aborts this request, as a real fetch would.
        return new Promise<Response>((_, reject) => {
          request.init.signal?.addEventListener('abort', () => {
            reject(new DOMException('deadline', 'TimeoutError'));
          });
        });
      }
      return stream('event: sdk-event\nid: 2\ndata: {}\n\nevent: done\n\n');
    });
    const http = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: api.fetch,
      timeoutMs: 5,
    });
    const seen: string[] = [];
    for await (const frame of new RunsClient(http).follow(RUN, { reconnectDelayMs: 0 })) {
      seen.push(frame.kind === 'runtime' ? `runtime:${frame.id ?? ''}` : frame.kind);
    }
    expect(seen).toEqual(['runtime:1', 'runtime:2']);
    expect(api.calls).toHaveLength(3);
    expect(api.calls[2]?.headers.get('last-event-id')).toBe('1');
  });

  it('gives up after maxReconnects and rethrows the transport failure', async () => {
    const { runs, calls } = client(() => stream('event: sdk-event\nid: 1\ndata: {}\n\n'));
    const failure = await drain(runs.follow(RUN, { maxReconnects: 2, reconnectDelayMs: 0 })).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(TransportError);
    expect(calls).toHaveLength(3);
  });

  it('counts only consecutive failed reconnects against maxReconnects', async () => {
    let attempt = 0;
    const { runs, calls } = client(() => {
      attempt += 1;
      // Every connection delivers one new event before the proxy drops it.
      return attempt < 4
        ? dropped(`event: sdk-event\nid: ${String(attempt)}\ndata: {}\n\n`)
        : stream('event: done\n\n');
    });
    const seen: string[] = [];
    for await (const frame of runs.follow(RUN, { maxReconnects: 1, reconnectDelayMs: 0 })) {
      seen.push(frame.kind);
    }
    expect(seen).toEqual(['runtime', 'runtime', 'runtime']);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.headers.get('last-event-id')).toBe('3');
  });

  it('reconnects after a 5xx or 429 answer, waiting the Retry-After it names', async () => {
    const answers = [503, 429];
    const { runs, calls } = client(() => {
      const status = answers.shift();
      return status === undefined
        ? stream('event: done\n\n')
        : json(status, { error: { code: 'busy', message: 'restarting' } }, { 'retry-after': '0' });
    });
    // A 10 s reconnectDelayMs would time the test out: Retry-After: 0 is what is waited.
    await drain(runs.follow(RUN, { reconnectDelayMs: 10_000 }));
    expect(calls).toHaveLength(3);
  });

  it('does not reconnect after a problem response', async () => {
    const { runs, calls } = client(() =>
      json(404, { error: { code: 'run_not_found', message: 'no run' } }),
    );
    const failure = await runs
      .follow(RUN, { reconnectDelayMs: 0 })
      .next()
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect(calls).toHaveLength(1);
  });
});

describe('RunsClient.waitForOutcome', () => {
  it('follows to done and returns the settled record', async () => {
    const { runs } = client((call) =>
      call.url.pathname.endsWith('/events')
        ? stream('event: done\n\n')
        : json(200, { run: run('completed') }),
    );
    const settled = await runs.waitForOutcome(RUN);
    expect(settled.status).toBe('completed');
  });

  it('refuses a record that is still live after done', async () => {
    const { runs } = client((call) =>
      call.url.pathname.endsWith('/events')
        ? stream('event: done\n\n')
        : json(200, { run: run('running') }),
    );
    await expect(runs.waitForOutcome(RUN)).rejects.toBeInstanceOf(ContractViolationError);
  });
});

describe('RunsClient.rate (issue #665)', () => {
  it('posts the rating and comment to the feedback path and resolves on 204', async () => {
    const { runs, calls } = client(() => new Response(null, { status: 204 }));
    await expect(runs.rate(RUN, { rating: 'down', comment: 'wrong' })).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/runs/${RUN}/feedback`);
    expect(calls[0]?.json).toEqual({ rating: 'down', comment: 'wrong' });
  });

  it('surfaces a 404 for an unknown run as an ApiProblemError', async () => {
    const { runs } = client(() =>
      json(404, { error: { code: 'run_not_found', message: 'no such run' } }),
    );
    const failure = await runs.rate(RUN, { rating: 'up' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('run_not_found');
  });
});

describe('RunsClient.interrupt (issue #235, S-14)', () => {
  it('posts to the interrupt path and returns the run at its new status', async () => {
    const { runs, calls } = client(() => json(200, { run: run('cancelled') }));
    const stopped = await runs.interrupt(RUN);
    expect(stopped.status).toBe('cancelled');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/runs/${RUN}/interrupt`);
  });

  it('surfaces a 409 for an already-terminal run as an ApiProblemError', async () => {
    const { runs } = client(() =>
      json(409, { error: { code: 'run_not_interruptible', message: 'already completed' } }),
    );
    const failure = await runs.interrupt(RUN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('run_not_interruptible');
    expect((failure as ApiProblemError).status).toBe(409);
  });

  it('surfaces a 404 for an unknown or foreign run as an ApiProblemError', async () => {
    const { runs } = client(() =>
      json(404, { error: { code: 'run_not_found', message: 'no such run' } }),
    );
    const failure = await runs.interrupt(RUN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(404);
  });

  it('refuses a 200 missing the run, as a contract violation', async () => {
    const { runs } = client(() => json(200, {}));
    const failure = await runs.interrupt(RUN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runs, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const failure = await runs
      .interrupt(RUN, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('RunsClient.approve and reject (ADR-0145, P5-4)', () => {
  const accepted = () => json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` });

  it('posts the decision, and the comment when there is one, and reads the 202', async () => {
    const { runs, calls } = client(accepted);
    const response = await runs.approve(RUN, { comment: 'go ahead' });
    expect(response.run.status).toBe('queued');
    expect(response.events).toBe(`/api/runs/${RUN}/events`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/runs/${RUN}/approval`);
    expect(calls[0]?.json).toEqual({ decision: 'approve', comment: 'go ahead' });
  });

  it('sends reject without a comment key when none is given', async () => {
    const { runs, calls } = client(accepted);
    await runs.reject(RUN);
    expect(calls[0]?.json).toEqual({ decision: 'reject' });
  });

  it('surfaces a second decision as an ApiProblemError', async () => {
    const { runs } = client(() =>
      json(409, { error: { code: 'approval_already_decided', message: 'already decided' } }),
    );
    const failure = await runs.approve(RUN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('approval_already_decided');
    expect((failure as ApiProblemError).status).toBe(409);
  });

  it('waitForOutcome returns a run paused for approval instead of failing', async () => {
    const { runs } = client((request) =>
      request.url.pathname.endsWith('/events')
        ? stream('event: done\n\n')
        : json(200, { run: run('awaiting_approval') }),
    );
    const paused = await runs.waitForOutcome(RUN);
    expect(paused.status).toBe('awaiting_approval');
    expect(paused.pendingApproval).toEqual({ toolName: 'send_email', canonicalCall: '{}' });
  });
});

describe('RunsClient.revokeTokens (issue #235, S-15)', () => {
  it('posts to the named path with tokenId null when omitted, and reads the outcome', async () => {
    const { runs, calls } = client(() => json(200, { revoked: 3, outcome: 'revoked' }));
    const result = await runs.revokeTokens(RUN);
    expect(result).toEqual({ revoked: 3, outcome: 'revoked' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/runs/${RUN}/revoke-tokens`);
    expect(calls[0]?.json).toEqual({ tokenId: null });
  });

  it('sends one tokenId when given', async () => {
    const { runs, calls } = client(() => json(200, { revoked: 1, outcome: 'revoked' }));
    await runs.revokeTokens(RUN, { tokenId: '22222222-2222-4222-8222-222222222222' });
    expect(calls[0]?.json).toEqual({ tokenId: '22222222-2222-4222-8222-222222222222' });
  });

  it('surfaces a 403 for a role without the grant, as an ApiProblemError', async () => {
    const { runs } = client(() =>
      json(403, { error: { code: 'run_token_revoke_forbidden', message: 'not allowed' } }),
    );
    const failure = await runs.revokeTokens(RUN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(403);
  });
});

describe('RunsClient.result (ADR-0143)', () => {
  const answer = { text: '{"verdict":"ok"}', structured: { verdict: 'ok' } };
  const settledWith = (status: string, output: unknown) =>
    client((call) =>
      call.url.pathname.endsWith('/events')
        ? stream('event: done\n\n')
        : json(200, { run: run(status, output) }),
    ).runs;

  it('returns the text and the structured output of a completed run', async () => {
    const result = await settledWith('completed', answer).result(RUN);
    expect(result.text).toBe(answer.text);
    expect(result.output).toEqual({ verdict: 'ok' });
    expect(result.run.status).toBe('completed');
  });

  it('parses the output with the schema and types it', async () => {
    const schema = z.object({ verdict: z.string() });
    const result = await settledWith('completed', answer).result(RUN, { schema });
    expectTypeOf(result.output).toEqualTypeOf<{ verdict: string } | null>();
    expect(result.output?.verdict).toBe('ok');
  });

  it('raises ContractViolationError when the output does not match the schema', async () => {
    const schema = z.object({ verdict: z.number() });
    const failure = await settledWith('completed', answer)
      .result(RUN, { schema })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).message).toContain('runs.result');
    expect((failure as ContractViolationError).issues[0]).toContain('verdict');
  });

  it('returns a null structured output as null, with the text, when the run asked for none', async () => {
    const plain = { text: 'hello', structured: null };
    const result = await settledWith('completed', plain).result(RUN, {
      schema: z.object({ verdict: z.string() }),
    });
    expect(result).toMatchObject({ text: 'hello', output: null });
  });

  it('resolves a failed or cancelled run with no text and no output', async () => {
    for (const status of ['failed', 'cancelled']) {
      const result = await settledWith(status, null).result(RUN);
      expect(result).toMatchObject({ text: null, output: null });
      expect(result.run.status).toBe(status);
    }
  });
});

describe('RunsClient.outputs', () => {
  const file = (
    path: string,
    kind: 'file' | 'folder' = 'file',
    contentType: string | null = null,
  ) => ({
    id: `id:${path}`,
    path,
    kind,
    sizeBytes: kind === 'file' ? 4 : null,
    contentType,
    lastModified: kind === 'file' ? '2026-10-17T10:00:00.000Z' : null,
  });
  const root = `runs/${RUN}/outputs`;
  const tree: Record<string, readonly unknown[]> = {
    [root]: [
      file(`${root}/BRK-1101.dxf`),
      file(`${root}/report.pdf`, 'file', 'application/pdf'),
      file(`${root}/reports`, 'folder'),
    ],
    [`${root}/reports`]: [file(`${root}/reports/summary.md`)],
  };
  const served = (request: RecordedRequest): Response =>
    json(200, { files: tree[request.url.searchParams.get('path') ?? ''] ?? [] });

  // @story US-STO-07
  it('[US-STO-07][api][sdk] outputs appear with the right type', async () => {
    const { runs } = client(served);
    const files = await runs.outputs(RUN);
    expect(files.find((f) => f.name === 'report.pdf')?.contentType).toBe('application/pdf');
  });

  it('lists the run prefix only, walks folders and names files relative to outputs/', async () => {
    const { runs, calls } = client(served);
    const files = await runs.outputs(RUN);
    expect(files.map((f) => [f.name, f.path])).toEqual([
      ['BRK-1101.dxf', `${root}/BRK-1101.dxf`],
      ['report.pdf', `${root}/report.pdf`],
      ['reports/summary.md', `${root}/reports/summary.md`],
    ]);
    expect(calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get('path')])).toEqual([
      ['GET', '/api/files', root],
      ['GET', '/api/files', `${root}/reports`],
    ]);
  });

  it('answers an empty list for a run that wrote nothing', async () => {
    const { runs } = client(() => json(200, { files: [] }));
    expect(await runs.outputs(RUN)).toEqual([]);
  });

  it('passes the signal on every request, so aborting mid-walk stops it', async () => {
    const controller = new AbortController();
    const { runs, calls } = client((request) => {
      if (request.init.signal?.aborted === true)
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      // The caller aborts once the first level has been listed.
      controller.abort();
      return served(request);
    });
    const failure = await runs.outputs(RUN, { signal: controller.signal }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls.map((c) => c.url.searchParams.get('path'))).toEqual([root, `${root}/reports`]);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runs } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const failure = await runs.outputs(RUN, { signal: controller.signal }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });

  it('surfaces a problem as an ApiProblemError and drift as a contract violation', async () => {
    const problem = client(() =>
      json(400, { error: { code: 'invalid_path', message: 'not a valid path' } }),
    );
    expect(await problem.runs.outputs(RUN).catch((e: unknown) => e)).toBeInstanceOf(
      ApiProblemError,
    );
    const drift = client(() => json(200, { entries: [] }));
    expect(await drift.runs.outputs(RUN).catch((e: unknown) => e)).toBeInstanceOf(
      ContractViolationError,
    );
  });
});
