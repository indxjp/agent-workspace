/**
 * The browser transport for W1-UI-05's run path: parsing the wire format `server/runs/sse.ts`
 * writes, and the two network calls `home-chat.tsx` makes after **Send**.
 *
 * No real network runs here. `followRunEvents` and `startAgentRun` are exercised against a
 * `globalThis.fetch` this file replaces for the duration of each test and restores afterwards —
 * the same shape `components/agents/agent-form.tsx`'s own behaviour is proven with, one layer up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  followRunEvents,
  parseSseFrame,
  splitSseFrames,
  startAgentRun,
  startAgentRunForSession,
  startAgentRunInProject,
} from './live';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── parseSseFrame ───────────────────────────────────────────────────────────────────────────────

describe('parseSseFrame', () => {
  it('reads a durable event exactly as server/runs/sse.ts writes one', () => {
    const raw = 'event: tool_use.Read\nid: 7\ndata: {"file_path":"/a"}';
    expect(parseSseFrame(raw)).toEqual({
      event: 'tool_use.Read',
      id: '7',
      data: { file_path: '/a' },
    });
  });

  it('reads a control frame, which carries no id:', () => {
    const raw = 'event: run-failed\ndata: {"status":"failed","message":"Not logged in."}';
    expect(parseSseFrame(raw)).toEqual({
      event: 'run-failed',
      id: null,
      data: { status: 'failed', message: 'Not logged in.' },
    });
  });

  it('joins multiple data: lines with a newline, per HTML §9.2', () => {
    const raw = 'event: assistant.text\ndata: line one\ndata: line two';
    expect(parseSseFrame(raw)).toEqual({
      event: 'assistant.text',
      id: null,
      data: 'line one\nline two',
    });
  });

  it('keeps a non-JSON payload as the raw string rather than dropping the frame', () => {
    const raw = 'event: weird\ndata: not json at all {';
    expect(parseSseFrame(raw)).toEqual({ event: 'weird', id: null, data: 'not json at all {' });
  });

  it('treats no data: lines as a null payload', () => {
    expect(parseSseFrame('event: done')).toEqual({ event: 'done', id: null, data: null });
  });

  it('ignores comment lines and unrecognised fields', () => {
    const raw = ': keep-alive\nretry: 3000\nevent: system.init\ndata: "ok"';
    expect(parseSseFrame(raw)).toEqual({ event: 'system.init', id: null, data: 'ok' });
  });

  it('returns null for a frame with no event: field — this API never sends one', () => {
    expect(parseSseFrame('data: "orphaned"')).toBeNull();
    expect(parseSseFrame('')).toBeNull();
  });
});

// ── splitSseFrames ──────────────────────────────────────────────────────────────────────────────

describe('splitSseFrames', () => {
  it('splits on the blank-line boundary and keeps the trailing partial frame', () => {
    const result = splitSseFrames('event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3');
    expect(result.frames).toEqual(['event: a\ndata: 1', 'event: b\ndata: 2']);
    expect(result.rest).toBe('event: c\ndata: 3');
  });

  it('normalises CRLF before splitting', () => {
    const result = splitSseFrames('event: a\r\ndata: 1\r\n\r\nevent: b');
    expect(result.frames).toEqual(['event: a\ndata: 1']);
    expect(result.rest).toBe('event: b');
  });

  it('returns no frames and the whole buffer as rest when no boundary has arrived yet', () => {
    expect(splitSseFrames('event: a\ndata: 1')).toEqual({ frames: [], rest: 'event: a\ndata: 1' });
  });
});

// ── followRunEvents ─────────────────────────────────────────────────────────────────────────────

function streamedResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

describe('followRunEvents', () => {
  it('delivers each relayed and control frame to onFrame, and stops at done without calling it', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        streamedResponse([
          'event: system.init\ndata: "ok"\n\n',
          'event: run.status\nid: 1\ndata: {"status":"running","error":null}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );

    const frames: string[] = [];
    let done = false;
    await new Promise<void>((resolve) => {
      followRunEvents('/api/runs/r1/events', {
        onFrame: (frame) => frames.push(frame.event),
        onDone: () => {
          done = true;
          resolve();
        },
        onTransportError: (message) => {
          throw new Error(`unexpected transport error: ${message}`);
        },
      });
    });

    expect(frames).toEqual(['system.init', 'run.status']);
    expect(done).toBe(true);
  });

  it('reassembles a frame split across two chunks', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        streamedResponse(['event: tool_use.Read\nda', 'ta: {"file_path":"/a"}\n\nevent: done\n\n']),
      ),
    );

    const frames: unknown[] = [];
    await new Promise<void>((resolve) => {
      followRunEvents('/api/runs/r1/events', {
        onFrame: (frame) => frames.push(frame.data),
        onDone: resolve,
        onTransportError: (message) => {
          throw new Error(`unexpected transport error: ${message}`);
        },
      });
    });

    expect(frames).toEqual([{ file_path: '/a' }]);
  });

  it('reports a non-200 as a transport error rather than reading its body as events', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));

    const errors: string[] = [];
    await new Promise<void>((resolve) => {
      followRunEvents('/api/runs/missing/events', {
        onFrame: () => {
          throw new Error('should not receive a frame from a 404');
        },
        onDone: () => {
          throw new Error('should not signal done from a 404');
        },
        onTransportError: (message) => {
          errors.push(message);
          resolve();
        },
      });
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('404');
  });

  it('reports a stream that ends without a done frame, rather than treating silence as success', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(streamedResponse(['event: system.init\ndata: "ok"\n\n'])),
    );

    const errors: string[] = [];
    let sawDone = false;
    await new Promise<void>((resolve) => {
      followRunEvents('/api/runs/r1/events', {
        onFrame: () => undefined,
        onDone: () => {
          sawDone = true;
        },
        onTransportError: (message) => {
          errors.push(message);
          resolve();
        },
      });
    });

    expect(sawDone).toBe(false);
    expect(errors[0]).toContain('done');
  });

  it('aborting stops the read and reports neither onDone nor onTransportError', async () => {
    let cancelled = false;
    globalThis.fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            cancelled = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const abort = followRunEvents('/api/runs/r1/events', {
      onFrame: () => {
        throw new Error('should not receive a frame after abort');
      },
      onDone: () => {
        throw new Error('should not signal done after abort');
      },
      onTransportError: () => {
        throw new Error('an aborted read should not report a transport error');
      },
    });
    abort();

    // Give the fetch's rejection a turn to (not) reach the handlers above.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });
});

// ── startAgentRun ───────────────────────────────────────────────────────────────────────────────

describe('startAgentRun', () => {
  it('reads the 202 body server/runs/api.ts actually sends', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { run: { id: 'r1', status: 'queued' }, events: '/api/runs/r1/events' },
          { status: 202 },
        ),
      ),
    );

    const outcome = await startAgentRun('a1', 'Summarise the contracts.');
    expect(outcome).toEqual({
      kind: 'started',
      status: 'queued',
      eventsUrl: '/api/runs/r1/events',
      sessionId: null,
    });
  });

  it('sends sessionId: null — every run this screen starts is a new session (§19.5.1 rule 4)', async () => {
    let sentBody: unknown;
    globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return Promise.resolve(
        Response.json({ run: { status: 'queued' }, events: '/x' }, { status: 202 }),
      );
    });

    await startAgentRun('a1', 'hello');
    expect(sentBody).toEqual({
      prompt: 'hello',
      sessionId: null,
      modelConnectionId: null,
      model: null,
    });
  });

  it('sends the (connection, model) pair chosen for this run — issue #130, never one without the other', async () => {
    let sentBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body === 'string') sentBody = JSON.parse(init.body);
        return Promise.resolve(
          Response.json({ status: 'queued', events: '/api/runs/r1/events' }, { status: 202 }),
        );
      }),
    );

    await startAgentRun('a1', 'hello', {
      connectionId: '10000000-0000-4000-8000-000000000004',
      model: 'claude-sonnet-4-5',
    });
    expect(sentBody).toMatchObject({
      modelConnectionId: '10000000-0000-4000-8000-000000000004',
      model: 'claude-sonnet-4-5',
    });
  });

  it('resumes the session chosen for a follow-up and reads it back from the run', async () => {
    let sentBody: unknown;
    globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return Promise.resolve(
        Response.json(
          {
            run: { status: 'queued', sessionId: '77777777-7777-4777-8777-777777777777' },
            events: '/x',
          },
          { status: 202 },
        ),
      );
    });

    const outcome = await startAgentRun(
      'a1',
      'follow up',
      null,
      '77777777-7777-4777-8777-777777777777',
    );
    expect(sentBody).toEqual({
      prompt: 'follow up',
      sessionId: '77777777-7777-4777-8777-777777777777',
      modelConnectionId: null,
      model: null,
    });
    expect(outcome).toMatchObject({
      kind: 'started',
      sessionId: '77777777-7777-4777-8777-777777777777',
    });
  });

  it('reads the { error: { code, message } } envelope server/runs/http.ts sends on rejection', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { error: { code: 'agent_not_found', message: 'no agent a1 in this workspace.' } },
          { status: 404 },
        ),
      ),
    );

    const outcome = await startAgentRun('a1', 'hello');
    expect(outcome).toEqual({
      kind: 'rejected',
      status: 404,
      code: 'agent_not_found',
      message: 'no agent a1 in this workspace.',
    });
  });

  it('reports a network failure as a transport error rather than throwing', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed')));

    const outcome = await startAgentRun('a1', 'hello');
    expect(outcome.kind).toBe('transport-error');
  });
});

describe('startAgentRunInProject', () => {
  it('creates the attributed session before starting the run with that session id', async () => {
    const calls: Array<{ readonly url: string; readonly body: unknown }> = [];
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      if (calls.length === 1) {
        return Promise.resolve(
          Response.json(
            {
              id: '77777777-7777-4777-8777-777777777777',
              projectId: 'project/one',
              agentId: 'agent/one',
            },
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(
        Response.json(
          {
            run: {
              status: 'queued',
              sessionId: '77777777-7777-4777-8777-777777777777',
            },
            events: '/api/runs/r1/events',
          },
          { status: 202 },
        ),
      );
    });

    const outcome = await startAgentRunInProject('agent/one', 'hello', null, 'project/one');

    expect(calls).toEqual([
      {
        url: '/api/projects/project%2Fone/sessions',
        body: { agentId: 'agent/one' },
      },
      {
        url: '/api/agents/agent%2Fone/runs',
        body: {
          prompt: 'hello',
          sessionId: '77777777-7777-4777-8777-777777777777',
          modelConnectionId: null,
          model: null,
        },
      },
    ]);
    expect(outcome).toMatchObject({
      kind: 'started',
      sessionId: '77777777-7777-4777-8777-777777777777',
    });
  });

  it('does not start an unattributed run when project session creation is rejected', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { error: { code: 'project_archived', message: 'Restore the project first.' } },
          { status: 409 },
        ),
      ),
    );

    const outcome = await startAgentRunInProject('agent-1', 'hello', null, 'project-1');

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: 'rejected',
      status: 409,
      code: 'project_archived',
      message: 'Restore the project first.',
    });
  });

  it('keeps project attribution when a failed first send is retried without a session id', async () => {
    let attempt = 0;
    const calls: Array<{ readonly url: string; readonly body: unknown }> = [];
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      attempt += 1;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      if (attempt === 1) return Promise.reject(new TypeError('temporary network failure'));
      if (attempt === 2) {
        return Promise.resolve(
          Response.json(
            {
              id: '77777777-7777-4777-8777-777777777777',
              projectId: 'project-1',
              agentId: 'agent-1',
            },
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(
        Response.json(
          {
            run: { status: 'queued', sessionId: '77777777-7777-4777-8777-777777777777' },
            events: '/api/runs/r1/events',
          },
          { status: 202 },
        ),
      );
    });

    await expect(
      startAgentRunForSession('agent-1', 'first', null, null, 'project-1'),
    ).resolves.toMatchObject({ kind: 'transport-error' });
    await expect(
      startAgentRunForSession('agent-1', 'retry', null, null, 'project-1'),
    ).resolves.toMatchObject({
      kind: 'started',
      sessionId: '77777777-7777-4777-8777-777777777777',
    });

    expect(calls).toEqual([
      { url: '/api/projects/project-1/sessions', body: { agentId: 'agent-1' } },
      { url: '/api/projects/project-1/sessions', body: { agentId: 'agent-1' } },
      {
        url: '/api/agents/agent-1/runs',
        body: {
          prompt: 'retry',
          sessionId: '77777777-7777-4777-8777-777777777777',
          modelConnectionId: null,
          model: null,
        },
      },
    ]);
  });
});

// Issue #393 (E): the chat's follow-up is a second run in the same session. It must take the
// same route as the first message — with the session id, and without opening a second project
// session — and a refusal on it must come back with its typed code for the transcript to show.
describe('a follow-up message resumes its session through the same route', () => {
  it('posts the session id to the agent run route, and reads a typed refusal back', async () => {
    const calls: Array<{ readonly url: string; readonly body: unknown }> = [];
    let attempt = 0;
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      attempt += 1;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      if (attempt === 1) {
        return Promise.resolve(
          Response.json(
            { run: { status: 'queued', sessionId: 'session-1' }, events: '/api/runs/r2/events' },
            { status: 202 },
          ),
        );
      }
      return Promise.resolve(
        Response.json(
          {
            error: {
              code: 'model_connection_unresolved',
              message: 'no workspace default is configured.',
            },
          },
          { status: 422 },
        ),
      );
    });

    await expect(
      startAgentRunForSession('agent-1', 'second', null, 'session-1', 'project-1'),
    ).resolves.toMatchObject({ kind: 'started', sessionId: 'session-1' });
    await expect(
      startAgentRunForSession('agent-1', 'third', null, 'session-1', 'project-1'),
    ).resolves.toEqual({
      kind: 'rejected',
      status: 422,
      code: 'model_connection_unresolved',
      message: 'no workspace default is configured.',
    });
    expect(calls.map((call) => call.url)).toEqual([
      '/api/agents/agent-1/runs',
      '/api/agents/agent-1/runs',
    ]);
    expect(calls[0]?.body).toMatchObject({ prompt: 'second', sessionId: 'session-1' });
  });
});
