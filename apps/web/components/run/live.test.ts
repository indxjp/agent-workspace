/**
 * The browser transport for W1-UI-05's run path: the two SDK calls `home-chat.tsx` makes after
 * **Send** — `runs.start`, then `runs.follow`.
 *
 * No real network runs here: every test hands the module an SDK client over the SDK's own
 * `fetchDouble`, with its event-stream response doubles for the stream.
 */
import type { RunResource } from '@indx-workspace/contracts/runs';
import { createClient, type RunEventFrame } from '@indx-workspace/sdk';
import {
  droppedEventStreamResponse,
  eventStreamResponse,
  fetchDouble,
  fixtures,
  jsonResponse,
  openEventStreamResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  followRunEvents,
  startAgentRun,
  startAgentRunForSession,
  startAgentRunInProject,
} from './live';

// ── followRunEvents ─────────────────────────────────────────────────────────────────────────────

type Followed =
  | { readonly kind: 'done'; readonly frames: readonly RunEventFrame[] }
  | {
      readonly kind: 'transport-error';
      readonly frames: readonly RunEventFrame[];
      readonly message: string;
    };

/** Follow run `r1` over `route` until the module reports done or a transport error. */
function follow(route: (request: RecordedRequest) => Response) {
  const { client, calls } = clientFor(route);
  const frames: RunEventFrame[] = [];
  const ended = new Promise<Followed>((resolve) => {
    followRunEvents(
      'r1',
      {
        onFrame: (frame) => frames.push(frame),
        onDone: () => resolve({ kind: 'done', frames }),
        onTransportError: (message) => resolve({ kind: 'transport-error', frames, message }),
      },
      client,
    );
  });
  return { ended, calls };
}

const STATUS_RUNNING = 'event: run.status\nid: 1\ndata: {"status":"running","error":null}\n\n';
const RELAYED = 'event: agent.usage\nid: 2\ndata: {"frame":"agent.usage"}\n\n';
const DONE = 'event: done\ndata: {}\n\n';

describe('followRunEvents', () => {
  it('delivers classified frames in order, and reports done without delivering it', async () => {
    const { ended, calls } = follow(() => eventStreamResponse(STATUS_RUNNING + RELAYED + DONE));

    const result = await ended;

    expect(result.kind).toBe('done');
    expect(result.frames.map((frame) => frame.kind)).toEqual(['run-status', 'runtime']);
    expect(calls.map((call) => call.url.pathname)).toEqual(['/api/runs/r1/events']);
    expect(calls[0]?.headers.get('last-event-id')).toBeNull();
  });

  it('delivers a run-failed frame as itself, still ending at done', async () => {
    const { ended } = follow(() =>
      eventStreamResponse(
        'event: run-failed\ndata: {"status":"failed","message":"Not logged in."}\n\n' + DONE,
      ),
    );

    const result = await ended;

    expect(result.kind).toBe('done');
    expect(result.frames).toEqual([
      { kind: 'run-failed', data: { status: 'failed', message: 'Not logged in.' } },
    ]);
  });

  it('reports a dropped connection once, without resuming it', async () => {
    const { ended, calls } = follow(() => droppedEventStreamResponse(STATUS_RUNNING));

    const result = await ended;

    expect(result.kind).toBe('transport-error');
    expect(result.frames.map((frame) => frame.kind)).toEqual(['run-status']);
    expect(calls).toHaveLength(1);
  });

  it('reports a stream that ends without a done frame, rather than treating silence as success', async () => {
    const { ended } = follow(() => eventStreamResponse(STATUS_RUNNING));

    const result = await ended;

    expect(result.kind).toBe('transport-error');
    expect(result.kind === 'transport-error' ? result.message : '').toContain('done');
  });

  it('reports a non-200 as a transport error naming the status', async () => {
    const { ended } = follow(() =>
      jsonResponse(404, { error: { code: 'run_not_found', message: 'no run r1.' } }),
    );

    const result = await ended;

    expect(result).toEqual({
      kind: 'transport-error',
      frames: [],
      message: 'the events endpoint answered 404 instead of opening a stream',
    });
  });

  it('aborting closes the open stream and reports neither done nor a transport error', async () => {
    const open = openEventStreamResponse(STATUS_RUNNING);
    const { client } = clientFor(() => open.response);
    const reported: string[] = [];

    const abort = followRunEvents(
      'r1',
      {
        onFrame: (frame) => reported.push(frame.kind),
        onDone: () => reported.push('done'),
        onTransportError: () => reported.push('transport-error'),
      },
      client,
    );
    await vi.waitFor(() => {
      expect(reported).toEqual(['run-status']);
    });
    abort();
    // Give the cancelled read a turn to (not) reach the handlers above.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(open.cancelled()).toBe(true);
    expect(reported).toEqual(['run-status']);
  });
});

// ── startAgentRun ───────────────────────────────────────────────────────────────────────────────

const SESSION = '77777777-7777-4777-8777-777777777777';
const problem = (status: number, code: string, message: string) =>
  jsonResponse(status, { error: { code, message } });

function clientFor(route: (request: RecordedRequest) => Response) {
  const double = fetchDouble(route);
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  return { client, calls: double.calls };
}

const accepted = (overrides: Partial<RunResource> = {}) =>
  jsonResponse(202, {
    run: fixtures.run({ sessionId: SESSION, ...overrides }),
    events: '/api/runs/r1/events',
  });

describe('startAgentRun', () => {
  it('posts the run to the agent and reads the 202 body', async () => {
    const { client, calls } = clientFor(() => accepted());

    const outcome = await startAgentRun('a1', 'Summarise the contracts.', null, null, client);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/agents/a1/runs');
    expect(calls[0]?.json).toEqual({
      prompt: 'Summarise the contracts.',
      sessionId: null,
      modelConnectionId: null,
      model: null,
    });
    expect(outcome).toEqual({
      kind: 'started',
      status: 'queued',
      runId: fixtures.run().id,
      sessionId: SESSION,
    });
  });

  it('sends the (connection, model) pair chosen for this run — issue #130, never one without the other', async () => {
    const { client, calls } = clientFor(() => accepted());

    await startAgentRun(
      'a1',
      'hello',
      { connectionId: '10000000-0000-4000-8000-000000000004', model: 'claude-sonnet-4-5' },
      null,
      client,
    );

    expect(calls[0]?.json).toMatchObject({
      modelConnectionId: '10000000-0000-4000-8000-000000000004',
      model: 'claude-sonnet-4-5',
    });
  });

  it('resumes the session chosen for a follow-up and reads it back from the run', async () => {
    const { client, calls } = clientFor(() => accepted());

    const outcome = await startAgentRun('a1', 'follow up', null, SESSION, client);

    expect(calls[0]?.json).toEqual({
      prompt: 'follow up',
      sessionId: SESSION,
      modelConnectionId: null,
      model: null,
    });
    expect(outcome).toMatchObject({ kind: 'started', sessionId: SESSION });
  });

  it("reads the server's own code and message on rejection", async () => {
    const { client } = clientFor(() =>
      problem(404, 'agent_not_found', 'no agent a1 in this workspace.'),
    );

    await expect(startAgentRun('a1', 'hello', null, null, client)).resolves.toEqual({
      kind: 'rejected',
      status: 404,
      code: 'agent_not_found',
      message: 'no agent a1 in this workspace.',
    });
  });

  it('reports a network failure as a transport error rather than throwing', async () => {
    const client = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });

    const outcome = await startAgentRun('a1', 'hello', null, null, client);

    expect(outcome.kind).toBe('transport-error');
  });

  it('reports a 202 that breaks the contract as a transport error', async () => {
    const { client } = clientFor(() => jsonResponse(202, { run: { status: 'queued' } }));

    const outcome = await startAgentRun('a1', 'hello', null, null, client);

    expect(outcome.kind).toBe('transport-error');
  });
});

describe('startAgentRunInProject', () => {
  const session = () =>
    jsonResponse(201, { id: SESSION, projectId: 'project/one', agentId: 'agent/one' });

  it('creates the attributed session before starting the run with that session id', async () => {
    const { client, calls } = clientFor((request) =>
      request.url.pathname.endsWith('/sessions') ? session() : accepted(),
    );

    const outcome = await startAgentRunInProject('agent/one', 'hello', null, 'project/one', client);

    expect(calls.map((call) => [call.method, call.url.pathname, call.json])).toEqual([
      ['POST', '/api/projects/project%2Fone/sessions', { agentId: 'agent/one' }],
      [
        'POST',
        '/api/agents/agent%2Fone/runs',
        { prompt: 'hello', sessionId: SESSION, modelConnectionId: null, model: null },
      ],
    ]);
    expect(outcome).toMatchObject({ kind: 'started', sessionId: SESSION });
  });

  it('does not start an unattributed run when project session creation is rejected', async () => {
    const { client, calls } = clientFor(() =>
      problem(409, 'project_archived', 'Restore the project first.'),
    );

    const outcome = await startAgentRunInProject('agent-1', 'hello', null, 'project-1', client);

    expect(calls).toHaveLength(1);
    expect(outcome).toEqual({
      kind: 'rejected',
      status: 409,
      code: 'project_archived',
      message: 'Restore the project first.',
    });
  });

  it('keeps project attribution when a failed first send is retried without a session id', async () => {
    const double = fetchDouble((request) =>
      request.url.pathname.endsWith('/sessions') ? session() : accepted(),
    );
    let failedOnce = false;
    const client = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: (input, init) => {
        if (failedOnce) return double.fetch(input, init);
        failedOnce = true;
        return Promise.reject(new TypeError('temporary network failure'));
      },
    });

    await expect(
      startAgentRunForSession('agent-1', 'first', null, null, 'project-1', client),
    ).resolves.toMatchObject({ kind: 'transport-error' });
    await expect(
      startAgentRunForSession('agent-1', 'retry', null, null, 'project-1', client),
    ).resolves.toMatchObject({ kind: 'started', sessionId: SESSION });

    expect(double.calls.map((call) => [call.url.pathname, call.json])).toEqual([
      ['/api/projects/project-1/sessions', { agentId: 'agent-1' }],
      [
        '/api/agents/agent-1/runs',
        { prompt: 'retry', sessionId: SESSION, modelConnectionId: null, model: null },
      ],
    ]);
  });
});

// Issue #393 (E): the chat's follow-up is a second run in the same session. It must take the
// same route as the first message — with the session id, and without opening a second project
// session — and a refusal on it must come back with its typed code for the transcript to show.
describe('a follow-up message resumes its session through the same route', () => {
  it('posts the session id to the agent run route, and reads a typed refusal back', async () => {
    let attempt = 0;
    const { client, calls } = clientFor(() => {
      attempt += 1;
      return attempt === 1
        ? accepted({ sessionId: 'session-1' })
        : problem(422, 'model_connection_unresolved', 'no workspace default is configured.');
    });

    await expect(
      startAgentRunForSession('agent-1', 'second', null, 'session-1', 'project-1', client),
    ).resolves.toMatchObject({ kind: 'started', sessionId: 'session-1' });
    await expect(
      startAgentRunForSession('agent-1', 'third', null, 'session-1', 'project-1', client),
    ).resolves.toEqual({
      kind: 'rejected',
      status: 422,
      code: 'model_connection_unresolved',
      message: 'no workspace default is configured.',
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      '/api/agents/agent-1/runs',
      '/api/agents/agent-1/runs',
    ]);
    expect(calls[0]?.json).toMatchObject({ prompt: 'second', sessionId: 'session-1' });
    expect(calls[0]?.json).not.toHaveProperty('attachments');
  });

  // @story US-STO-11
  it('[US-STO-11][unit][chat] sends the files attached in the session with the follow-up', async () => {
    const { client, calls } = clientFor(() => accepted({ sessionId: 'session-1' }));
    await startAgentRunForSession('agent-1', 'read it', null, 'session-1', null, client, ['f1']);
    expect(calls[0]?.json).toMatchObject({
      sessionId: 'session-1',
      attachments: [{ fileId: 'f1' }],
    });
  });
});

describe('a run pinned to a version', () => {
  it('[US-BLD-05][unit][web] sends the version with the first run of a new session, and only then', async () => {
    const { client, calls } = clientFor(() => accepted());

    await startAgentRunForSession('a1', 'first', null, null, null, client, [], 2);
    await startAgentRunForSession('a1', 'second', null, SESSION, null, client, [], 2);

    expect(calls[0]?.json).toMatchObject({ prompt: 'first', version: 2 });
    expect(calls[1]?.json).toMatchObject({ prompt: 'second', sessionId: SESSION });
    expect(calls[1]?.json).not.toHaveProperty('version');
  });

  it('[US-BLD-05][unit][web] sends no version when none is pinned', async () => {
    const { client, calls } = clientFor(() => accepted());

    await startAgentRunForSession('a1', 'first', null, null, null, client);

    expect(calls[0]?.json).not.toHaveProperty('version');
  });

  it('[US-BLD-05][unit][web] lets the server refuse a version together with a project session', async () => {
    let attempt = 0;
    const { client, calls } = clientFor(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse(201, { id: SESSION, projectId: 'p1', agentId: 'a1' })
        : problem(400, 'invalid_request', 'version applies to a new session: omit sessionId');
    });

    const outcome = await startAgentRunInProject('a1', 'first', null, 'p1', client, 2);

    expect(calls[1]?.json).toMatchObject({ sessionId: SESSION, version: 2 });
    expect(outcome).toMatchObject({ kind: 'rejected', status: 400 });
  });
});
