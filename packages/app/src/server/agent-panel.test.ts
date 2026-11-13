import { ApiProblemSchema } from '@indx-workspace/contracts';
import type { RunResource } from '@indx-workspace/contracts/runs';
import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import {
  classifyRunEventFrame,
  readSseFrames,
  type RunEventFrame,
} from '@indx-workspace/sdk/events';
import {
  eventStreamResponse,
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentPanelRunResponseSchema, AgentPanelStartResponseSchema } from '../agent-panel-wire.js';
import { enumOf, person, text } from '../fields/index.js';
import type { Person } from '../person.js';
import { defineResource } from '../resource.js';
import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import {
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
} from '../testing/runtime.js';
import { agentPanelRoutes } from './agent-panel.js';
import { PANEL_SSE_HEADERS } from './agent-panel-sse.js';

/** A ticket only its assignee and admins may read. */
const ticket = defineResource({
  name: 'ticket',
  fields: {
    title: text({ max: 200 }),
    status: enumOf(['open', 'closed'], { default: 'open' }),
    assignee: person({ optional: true }),
  },
  access: {
    read: ['assignee', 'role:admin'],
    create: 'member',
    update: 'role:admin',
    delete: 'role:admin',
  },
  agents: { read: true, write: ['status'] },
});

const TRIAGE = '11111111-1111-4111-8111-111111111111';
const SECRET = 'internal: the database at 10.0.0.7 refused the connection';
const BASE = 'https://app.test/api/agent-panel';

const routes = agentPanelRoutes({
  resources: [ticket],
  agents: { triage: TRIAGE, unset: undefined },
});

/** The platform's people, by token. */
const people = new Map<string, Person>();
/** The platform's runs, by id. */
const runs = new Map<string, RunResource>();
let busy = false;
let staleSessions = new Set<string>();
let eventsText = '';
let eventsCalls = 0;
let lastEventIdSeen: string | null | undefined;

function signIn(role: MembershipRoleName): { token: string; person: Person } {
  const token = `awo_live_${crypto.randomUUID().replaceAll('-', '')}`;
  const found: Person = {
    principalId: crypto.randomUUID(),
    workspaceId: FAKE_WORKSPACE_ID,
    role,
    via: 'person',
  };
  people.set(token, found);
  return { token, person: found };
}

function newRun(overrides: Partial<RunResource>): RunResource {
  const created = fixtures.run({
    id: crypto.randomUUID(),
    workspaceId: FAKE_WORKSPACE_ID,
    ...overrides,
  });
  runs.set(created.id, created);
  return created;
}

const problemOfPlatform = (status: number, code: string) =>
  jsonResponse(status, { error: { code, message: SECRET, details: [SECRET] } });

function platformRoute(request: RecordedRequest): Response {
  const token = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';
  const who = people.get(token);
  if (who === undefined) return problemOfPlatform(401, 'unauthenticated');
  const path = request.url.pathname;
  if (path === '/api/me') {
    return jsonResponse(200, {
      principalId: who.principalId,
      kind: 'membership',
      role: who.role,
      workspaceId: who.workspaceId,
      userId: crypto.randomUUID(),
      label: 'Someone',
      features: [],
    });
  }
  const start = /^\/api\/agents\/([^/]+)\/runs$/u.exec(path);
  if (start !== null && request.method === 'POST') {
    if (busy) return problemOfPlatform(409, 'session_busy');
    const body = request.json as { prompt: string; sessionId: string | null };
    if (body.sessionId !== null && staleSessions.has(body.sessionId)) {
      return problemOfPlatform(409, 'session_not_usable');
    }
    const started = newRun({
      agentId: start[1] ?? '',
      sessionId: body.sessionId ?? crypto.randomUUID(),
    });
    return jsonResponse(202, { run: started, events: `/api/runs/${started.id}/events` });
  }
  const one = /^\/api\/runs\/([^/]+)(?:\/(events|approval))?$/u.exec(path);
  const found = one === null ? undefined : runs.get(one[1] ?? '');
  if (one === null || found === undefined) return problemOfPlatform(404, 'run_not_found');
  if (one[2] === 'events') {
    eventsCalls += 1;
    // A reconnect after a stream that broke finds the run gone, which the SDK does not retry.
    if (eventsCalls > 1) return problemOfPlatform(404, 'run_not_found');
    lastEventIdSeen = request.headers.get('last-event-id');
    return eventStreamResponse(eventsText);
  }
  if (one[2] === 'approval') {
    if (found.status !== 'awaiting_approval')
      return problemOfPlatform(409, 'run_not_awaiting_approval');
    const continuation = newRun({ agentId: found.agentId, sessionId: found.sessionId });
    return jsonResponse(202, { run: continuation, events: `/api/runs/${continuation.id}/events` });
  }
  return jsonResponse(200, { run: fixtures.runDetail(found) });
}

const platform = fetchDouble(platformRoute);
let runtime: TestAppRuntime;

beforeEach(() => {
  people.clear();
  runs.clear();
  busy = false;
  staleSessions = new Set();
  eventsText = '';
  eventsCalls = 0;
  lastEventIdSeen = undefined;
  platform.calls.length = 0;
  runtime = setAppRuntimeForTests({ fetch: platform.fetch });
});

afterEach(() => {
  resetAppRuntimeForTests();
});

function send(
  method: 'GET' | 'POST',
  path: readonly string[],
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const request = new Request(`${BASE}/${path.join('/')}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const context = { params: Promise.resolve({ path }) };
  return method === 'GET' ? routes.GET(request, context) : routes.POST(request, context);
}

/** The problem of `response`, parsed with the contracts' envelope; never the platform's words. */
async function problemOf(response: Response): Promise<{ status: number; code: string }> {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text();
  expect(text).not.toContain(SECRET);
  const parsed = ApiProblemSchema.parse(JSON.parse(text));
  return { status: response.status, code: parsed.error.code };
}

async function seed(assignee: Person): Promise<string> {
  const admin = { ...assignee, role: 'admin' as const };
  const record = await runtime.storeOf(ticket).create(admin, {
    title: 'Printer jam',
    assignee: assignee.principalId,
  });
  return record.id;
}

async function start(token: string, id: string, prompt = 'classify and route'): Promise<Response> {
  return send('POST', ['ticket', id, 'runs'], { token, body: { agent: 'triage', prompt } });
}

describe('agentPanelRoutes POST …/runs', () => {
  it('starts a run as the person, about the record, and keeps its session for the next prompt', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);

    const first = await start(token, id);
    expect(first.status).toBe(202);
    const started = AgentPanelStartResponseSchema.parse(await first.json());
    expect(started.events).toBe(`/api/agent-panel/ticket/${id}/runs/${started.run.id}/events`);
    expect(first.headers.get('location')).toBe(started.events);

    const call = platform.calls.find((c) => c.url.pathname === `/api/agents/${TRIAGE}/runs`);
    expect(call?.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(call?.json).toMatchObject({
      prompt: `ticket ${id}: classify and route`,
      sessionId: null,
    });
    const session = runs.get(started.run.id)?.sessionId;
    expect(
      await runtime.agentPanelSessions.find({
        workspaceId: who.workspaceId,
        resource: 'ticket',
        recordId: id,
        agent: 'triage',
        principalId: who.principalId,
      }),
    ).toBe(session);

    const second = await start(token, id, 'and now close it');
    expect(second.status).toBe(202);
    const calls = platform.calls.filter((c) => c.url.pathname === `/api/agents/${TRIAGE}/runs`);
    expect(calls.at(-1)?.json).toMatchObject({ sessionId: session });
    expect(runtime.agentPanelSessions.size).toBe(1);
  });

  it('starts a new session once when the stored one can no longer be continued', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    const first = AgentPanelStartResponseSchema.parse(await (await start(token, id)).json());
    const old = runs.get(first.run.id)?.sessionId ?? '';
    staleSessions.add(old);

    const again = await start(token, id);
    expect(again.status).toBe(202);
    const renewed = AgentPanelStartResponseSchema.parse(await again.json());
    expect(runs.get(renewed.run.id)?.sessionId).not.toBe(old);
  });

  it("keeps each person's own conversation on one record, and serves a run of a replaced session", async () => {
    // A ticket an admin and its assignee may both read.
    const a = signIn('admin');
    const b = signIn('admin');
    const ownSessions = new Map<'a' | 'b', string>();
    // The platform continues a session only for the person who started it.
    const sessionOwner = new Map<string, string>();
    const strictPlatform = fetchDouble((request) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';
      const startPath = /^\/api\/agents\/[^/]+\/runs$/u.test(request.url.pathname);
      if (startPath && request.method === 'POST') {
        const body = request.json as { sessionId: string | null };
        if (body.sessionId !== null && sessionOwner.get(body.sessionId) !== token) {
          return problemOfPlatform(409, 'session_not_usable');
        }
        const answer = platformRoute(request);
        const run = [...runs.values()].at(-1);
        if (run !== undefined && !sessionOwner.has(run.sessionId)) {
          sessionOwner.set(run.sessionId, token);
        }
        return answer;
      }
      return platformRoute(request);
    });
    runtime = setAppRuntimeForTests({ fetch: strictPlatform.fetch });
    const id = await seed(a.person);

    const runA = AgentPanelStartResponseSchema.parse(await (await start(a.token, id)).json()).run;
    ownSessions.set('a', runs.get(runA.id)?.sessionId ?? '');
    const runB = AgentPanelStartResponseSchema.parse(await (await start(b.token, id)).json()).run;
    ownSessions.set('b', runs.get(runB.id)?.sessionId ?? '');
    expect(ownSessions.get('a')).not.toBe(ownSessions.get('b'));

    // A's run in flight is still the record's after B started theirs.
    expect((await send('GET', ['ticket', id, 'runs', runA.id], { token: a.token })).status).toBe(
      200,
    );
    // Each person's next prompt continues their own session, never the other's.
    const starts = () =>
      strictPlatform.calls.filter((c) => c.url.pathname === `/api/agents/${TRIAGE}/runs`);
    expect((await start(a.token, id, 'and then')).status).toBe(202);
    expect(starts().at(-1)?.json).toMatchObject({ sessionId: ownSessions.get('a') });
    expect((await start(b.token, id, 'and then')).status).toBe(202);
    expect(starts().at(-1)?.json).toMatchObject({ sessionId: ownSessions.get('b') });
    expect(runtime.agentPanelSessions.size).toBe(2);

    // A session replaced because it can no longer be continued keeps its runs the record's.
    staleSessions.add(ownSessions.get('a') ?? '');
    const renewed = AgentPanelStartResponseSchema.parse(
      await (await start(a.token, id)).json(),
    ).run;
    expect(runs.get(renewed.id)?.sessionId).not.toBe(ownSessions.get('a'));
    expect((await send('GET', ['ticket', id, 'runs', runA.id], { token: a.token })).status).toBe(
      200,
    );
    expect(runtime.agentPanelSessions.size).toBe(3);
  });

  it('refuses without a person: 401 unauthenticated, before the platform runs anything', async () => {
    const id = crypto.randomUUID();
    expect(
      await problemOf(
        await send('POST', ['ticket', id, 'runs'], { body: { agent: 'triage', prompt: 'x' } }),
      ),
    ).toEqual({ status: 401, code: 'unauthenticated' });
    expect(await problemOf(await start('awo_live_unknown', id))).toEqual({
      status: 401,
      code: 'unauthenticated',
    });
    expect(platform.calls.some((c) => c.url.pathname.endsWith('/runs'))).toBe(false);
  });

  it('conceals a record the person cannot read behind the same 404 as a missing one', async () => {
    const owner = signIn('builder');
    const stranger = signIn('builder');
    const id = await seed(owner.person);
    expect(await problemOf(await start(stranger.token, id))).toEqual({
      status: 404,
      code: 'resource_not_found',
    });
    expect(await problemOf(await start(owner.token, crypto.randomUUID()))).toEqual({
      status: 404,
      code: 'resource_not_found',
    });
    expect(
      await problemOf(
        await send('POST', ['note', id, 'runs'], {
          token: owner.token,
          body: { agent: 'triage', prompt: 'x' },
        }),
      ),
    ).toEqual({ status: 404, code: 'resource_not_found' });
    expect(
      await problemOf(
        await send('POST', ['ticket', 'not-a-uuid', 'runs'], {
          token: owner.token,
          body: { agent: 'triage', prompt: 'x' },
        }),
      ),
    ).toEqual({ status: 404, code: 'resource_not_found' });
    expect(platform.calls.some((c) => c.url.pathname.endsWith('/runs'))).toBe(false);
  });

  it('refuses an agent the panel does not offer (403 agent_not_offered) and one without an id (500)', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    const ask = (agent: string) =>
      send('POST', ['ticket', id, 'runs'], { token, body: { agent, prompt: 'x' } });
    expect(await problemOf(await ask('writer'))).toEqual({
      status: 403,
      code: 'agent_not_offered',
    });
    expect(await problemOf(await ask('constructor'))).toEqual({
      status: 403,
      code: 'agent_not_offered',
    });
    expect(await problemOf(await ask('unset'))).toEqual({
      status: 500,
      code: 'agent_panel_misconfigured',
    });
  });

  it('refuses a body that is not the strict shape: blank, too long, unknown keys, not JSON', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    for (const body of [
      { agent: 'triage', prompt: '   ' },
      { agent: 'triage', prompt: 'x'.repeat(100_001) },
      { agent: 'triage', prompt: 'x', sessionId: crypto.randomUUID() },
      { agent: 'Triage!', prompt: 'x' },
      { prompt: 'x' },
    ]) {
      expect(await problemOf(await send('POST', ['ticket', id, 'runs'], { token, body }))).toEqual({
        status: 400,
        code: 'invalid_body',
      });
    }
    const malformed = new Request(`${BASE}/ticket/${id}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{',
    });
    expect(
      await problemOf(
        await routes.POST(malformed, { params: Promise.resolve({ path: ['ticket', id, 'runs'] }) }),
      ),
    ).toEqual({ status: 400, code: 'malformed_body' });
  });

  it('passes 409 session_busy through by code and status, in its own words, and queues nothing', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    busy = true;
    const response = await start(token, id);
    expect(await problemOf(response.clone())).toEqual({ status: 409, code: 'session_busy' });
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /still working/u,
    );
    expect(runtime.agentPanelSessions.size).toBe(0);
  });

  it('answers 502 upstream_failure when Agent Workspace fails, never its words', async () => {
    const failing = fetchDouble((request) =>
      request.url.pathname === '/api/me'
        ? platformRoute(request)
        : problemOfPlatform(503, 'database_unavailable'),
    );
    runtime = setAppRuntimeForTests({ fetch: failing.fetch });
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    expect(await problemOf(await start(token, id))).toEqual({
      status: 502,
      code: 'upstream_failure',
    });
  });
});

/** A paused run of the record, started through the panel. */
async function pausedRunOf(token: string, id: string): Promise<string> {
  const started = AgentPanelStartResponseSchema.parse(await (await start(token, id)).json());
  const found = runs.get(started.run.id);
  if (found === undefined) throw new Error('the run vanished');
  runs.set(found.id, {
    ...found,
    status: 'awaiting_approval',
    pendingApproval: { toolName: 'ticket_update', canonicalCall: '{"assignee":"Net"}' },
  });
  return found.id;
}

describe('agentPanelRoutes GET …/runs/:runId', () => {
  it('answers the run with the call it waits on, and nothing of its cost or output', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    const runId = await pausedRunOf(token, id);
    const response = await send('GET', ['ticket', id, 'runs', runId], { token });
    expect(response.status).toBe(200);
    const body = AgentPanelRunResponseSchema.parse(await response.json());
    expect(body.run).toEqual({
      id: runId,
      status: 'awaiting_approval',
      pendingApproval: { toolName: 'ticket_update', canonicalCall: '{"assignee":"Net"}' },
      error: null,
    });
  });

  it("refuses a run that is not this record's, and a run id that is not one, as 404 run_not_found", async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    const other = await seed(who);
    const runId = await pausedRunOf(token, other);
    const foreign = newRun({ sessionId: crypto.randomUUID() });
    for (const target of [runId, foreign.id, 'x']) {
      expect(await problemOf(await send('GET', ['ticket', id, 'runs', target], { token }))).toEqual(
        { status: 404, code: 'run_not_found' },
      );
    }
    expect(
      await problemOf(await send('GET', ['ticket', id, 'runs', runId, 'other'], { token })),
    ).toEqual({ status: 404, code: 'resource_not_found' });
  });
});

async function framesOf(response: Response): Promise<RunEventFrame[]> {
  const frames: RunEventFrame[] = [];
  if (response.body === null) throw new Error('no body');
  for await (const raw of readSseFrames(response.body)) frames.push(classifyRunEventFrame(raw));
  return frames;
}

describe('agentPanelRoutes GET …/runs/:runId/events', () => {
  const STREAM = [
    'event: run.status\nid: 7\nat: 2026-10-31T09:00:00.000Z\ndata: {"status":"running","error":null}\n\n',
    'event: agent.message\nid: 8\ndata: {"frame":"agent.message","text":"reading ticket"}\n\n',
    `event: ${'error'}\nid: 9\ndata: {}\n\n`,
    'event: run-failed\ndata: {"status":"failed","message":"The run failed."}\n\n',
    'event: done\ndata: {}\n\n',
  ].join('');

  it('streams the platform frames with the three headers, forwarding Last-Event-ID as after', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    const runId = await pausedRunOf(token, id);
    eventsText = STREAM;
    const response = await send('GET', ['ticket', id, 'runs', runId, 'events'], {
      token,
      headers: { 'last-event-id': '6' },
    });
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual(
      Object.fromEntries(Object.entries(PANEL_SSE_HEADERS).map(([k, v]) => [k.toLowerCase(), v])),
    );
    const frames = await framesOf(response);
    expect(lastEventIdSeen).toBe('6');
    expect(frames.map((frame) => frame.kind)).toEqual([
      'run-status',
      'runtime',
      'run-failed',
      'done',
    ]);
    expect(frames[0]).toMatchObject({ id: '7', at: '2026-10-31T09:00:00.000Z' });
    expect(frames[1]).toMatchObject({ id: '8', name: 'agent.message' });
  });

  it('ends a stream that broke with run-failed and no done, so the panel reconnects', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    const runId = await pausedRunOf(token, id);
    eventsText = 'event: run.status\nid: 7\ndata: {"status":"running","error":null}\n\n';
    const response = await send('GET', ['ticket', id, 'runs', runId, 'events'], { token });
    // The SDK reconnects once, after its 3 s pause, and the reconnect is refused.
    const frames = await framesOf(response);
    expect(frames.at(-1)).toEqual({
      kind: 'run-failed',
      data: { status: 'unknown', message: 'The event stream ended unexpectedly.' },
    });
    expect(frames.some((frame) => frame.kind === 'done')).toBe(false);
  }, 15_000);

  it('refuses a Last-Event-ID that is not an event id, and a run of another record', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    const runId = await pausedRunOf(token, id);
    expect(
      await problemOf(
        await send('GET', ['ticket', id, 'runs', runId, 'events'], {
          token,
          headers: { 'last-event-id': 'abc' },
        }),
      ),
    ).toEqual({ status: 400, code: 'invalid_last_event_id' });
    const other = await seed(who);
    expect(
      await problemOf(await send('GET', ['ticket', other, 'runs', runId, 'events'], { token })),
    ).toEqual({ status: 404, code: 'run_not_found' });
  });
});

describe('agentPanelRoutes POST …/runs/:runId/approval', () => {
  it('approves as the person and answers the continuation in the same session', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    const runId = await pausedRunOf(token, id);
    const response = await send('POST', ['ticket', id, 'runs', runId, 'approval'], {
      token,
      body: { decision: 'approve' },
    });
    expect(response.status).toBe(202);
    const body = AgentPanelStartResponseSchema.parse(await response.json());
    expect(body.run.id).not.toBe(runId);
    expect(runs.get(body.run.id)?.sessionId).toBe(runs.get(runId)?.sessionId);
    const call = platform.calls.find((c) => c.url.pathname === `/api/runs/${runId}/approval`);
    expect(call?.json).toEqual({ decision: 'approve' });
    expect(call?.headers.get('authorization')).toBe(`Bearer ${token}`);
    // The continuation is the record's too.
    expect((await send('GET', ['ticket', id, 'runs', body.run.id], { token })).status).toBe(200);
  });

  it('rejects with a comment, and refuses a body that is not the strict shape', async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    const runId = await pausedRunOf(token, id);
    expect(
      await problemOf(
        await send('POST', ['ticket', id, 'runs', runId, 'approval'], {
          token,
          body: { decision: 'maybe' },
        }),
      ),
    ).toEqual({ status: 400, code: 'invalid_body' });
    expect(
      await problemOf(
        await send('POST', ['ticket', id, 'runs', runId, 'approval'], {
          token,
          body: { decision: 'reject', subject: 'x' },
        }),
      ),
    ).toEqual({ status: 400, code: 'invalid_body' });
    const rejected = await send('POST', ['ticket', id, 'runs', runId, 'approval'], {
      token,
      body: { decision: 'reject', comment: 'not Net' },
    });
    expect(rejected.status).toBe(202);
    expect(platform.calls.at(-1)?.json).toEqual({ decision: 'reject', comment: 'not Net' });
  });

  it("passes the platform's 409 through by code, and refuses another record's run", async () => {
    const { token, person: who } = signIn('builder');
    const id = await seed(who);
    const runId = await pausedRunOf(token, id);
    await send('POST', ['ticket', id, 'runs', runId, 'approval'], {
      token,
      body: { decision: 'approve' },
    });
    const found = runs.get(runId);
    if (found !== undefined)
      runs.set(runId, { ...found, status: 'completed', pendingApproval: null });
    expect(
      await problemOf(
        await send('POST', ['ticket', id, 'runs', runId, 'approval'], {
          token,
          body: { decision: 'approve' },
        }),
      ),
    ).toEqual({ status: 409, code: 'run_not_awaiting_approval' });
    const other = await seed(who);
    expect(
      await problemOf(
        await send('POST', ['ticket', other, 'runs', runId, 'approval'], {
          token,
          body: { decision: 'approve' },
        }),
      ),
    ).toEqual({ status: 404, code: 'run_not_found' });
  });
});

describe('agentPanelRoutes', () => {
  it('refuses an agent name outside the grammar, and two resources of one name', () => {
    expect(() => agentPanelRoutes({ resources: [ticket], agents: { 'Bad Name': TRIAGE } })).toThrow(
      TypeError,
    );
    expect(() => agentPanelRoutes({ resources: [ticket, ticket], agents: {} })).toThrow(TypeError);
  });
});
