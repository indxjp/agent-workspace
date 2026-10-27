import { describe, expect, it } from 'vitest';

import { CONTRACTS_VERSION, CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { SessionsClient } from './sessions.js';

const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const PROVIDER_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const session = {
  id: SESSION,
  workspaceId: WORKSPACE,
  agentId: '11111111-1111-4111-8111-111111111111',
  userId: null,
  ownerPrincipalId: 'principal-1',
  projectId: null,
  engineSessionId: PROVIDER_SESSION,
  engine: 'claude-agent-sdk',
  title: null,
  status: 'active',
  resumable: true,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const entries = [
  { type: 'user', uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z', message: { role: 'user' } },
  { type: 'assistant', uuid: 'a-1', message: { content: [{ type: 'text', text: 'hi' }] } },
];

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly sessions: SessionsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { sessions: new SessionsClient(http), calls: api.calls };
}

function problem(status: number, code: string): Response {
  return json(status, { error: { code, message: `${code}.` } });
}

describe('SessionsClient.list', () => {
  it('reads the list with its projectKey and sends the status filter as the route spells it', async () => {
    const { sessions, calls } = client(() =>
      json(200, { sessions: [session], projectKey: WORKSPACE, nextCursor: null }),
    );
    const page = await sessions.list({ status: 'active' });
    expect(page.projectKey).toBe(WORKSPACE);
    expect(page.sessions[0]?.id).toBe(SESSION);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/api/sessions?status=active');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(call?.headers.get('accept')).toBe('application/json');
  });

  it('sends no query when no filter was given', async () => {
    const { sessions, calls } = client(() =>
      json(200, { sessions: [], projectKey: WORKSPACE, nextCursor: null }),
    );
    await sessions.list();
    expect(calls[0]?.url.search).toBe('');
  });

  it('sends limit and cursor as the route spells them', async () => {
    const { sessions, calls } = client(() =>
      json(200, { sessions: [session], projectKey: WORKSPACE, nextCursor: 'c-2' }),
    );
    const page = await sessions.list({ status: 'archived', limit: 1, cursor: 'c-1' });
    expect(page.nextCursor).toBe('c-2');
    expect(calls[0]?.url.search).toBe('?status=archived&limit=1&cursor=c-1');
  });

  it('surfaces the unconfigured seam, an unauthenticated caller, and a bad filter by code', async () => {
    for (const [status, code] of [
      [503, 'session_api_not_configured'],
      [401, 'unauthenticated'],
      [400, 'invalid_session_status'],
      [400, 'invalid_cursor'],
    ] as const) {
      const { sessions } = client(() => problem(status, code));
      const failure = await sessions.list().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });

  it('refuses a list without projectKey or nextCursor as a contract violation', async () => {
    const { sessions } = client(() => json(200, { sessions: [session], nextCursor: null }));
    const failure = await sessions.list().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues.join('\n')).toContain('projectKey');
    const cursorless = client(() => json(200, { sessions: [session], projectKey: WORKSPACE }));
    const second = await cursorless.sessions.list().catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ContractViolationError);
  });
});

describe('SessionsClient.listAll', () => {
  it('walks limit=1 pages with the filter kept on every request, until nextCursor is null', async () => {
    const later = { ...session, id: '66666666-6666-4666-8666-666666666666' };
    const pages: Readonly<Record<string, unknown>> = {
      '': { sessions: [later], projectKey: WORKSPACE, nextCursor: 'c-2' },
      'c-2': { sessions: [session], projectKey: WORKSPACE, nextCursor: null },
    };
    const { sessions, calls } = client((request) =>
      json(200, pages[request.url.searchParams.get('cursor') ?? '']),
    );
    const walked: string[] = [];
    for await (const row of sessions.listAll({ status: 'active', limit: 1 })) walked.push(row.id);
    expect(walked).toEqual([later.id, SESSION]);
    expect(calls.map((call) => call.url.search)).toEqual([
      '?status=active&limit=1',
      '?status=active&limit=1&cursor=c-2',
    ]);
    // Every page request carries the contracts version (ADR-0078), not only the first.
    for (const call of calls) {
      expect(call.headers.get(CONTRACTS_VERSION_HEADER)).toBe(CONTRACTS_VERSION);
    }
  });
});

describe('SessionsClient.get', () => {
  it('reads the wrapped item and unwraps it', async () => {
    const { sessions, calls } = client(() => json(200, { session }));
    expect(await sessions.get(SESSION)).toEqual(session);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe(`/api/sessions/${SESSION}`);
  });

  it('encodes a caller-supplied id so it cannot escape the path', async () => {
    const { sessions, calls } = client(() => problem(400, 'invalid_session_id'));
    const failure = await sessions.get('../runs?x=1#f').catch((e: unknown) => e);
    expect(calls[0]?.url.pathname).toBe('/api/sessions/..%2Fruns%3Fx%3D1%23f');
    expect(calls[0]?.url.search).toBe('');
    expect((failure as ApiProblemError).code).toBe('invalid_session_id');
  });

  it('surfaces a forbidden and a missing session by code', async () => {
    const forbidden = client(() => problem(403, 'session_forbidden'));
    const refused = await forbidden.sessions.get(SESSION).catch((e: unknown) => e);
    expect((refused as ApiProblemError).status).toBe(403);
    expect((refused as ApiProblemError).code).toBe('session_forbidden');
    const missing = client(() => problem(404, 'session_not_found'));
    const notFound = await missing.sessions.get(SESSION).catch((e: unknown) => e);
    expect((notFound as ApiProblemError).status).toBe(404);
    expect((notFound as ApiProblemError).code).toBe('session_not_found');
  });

  it('refuses a bare session and one with an unknown status as contract violations', async () => {
    const bare = client(() => json(200, session));
    await expect(bare.sessions.get(SESSION)).rejects.toBeInstanceOf(ContractViolationError);
    const drifted = client(() => json(200, { session: { ...session, status: 'paused' } }));
    await expect(drifted.sessions.get(SESSION)).rejects.toBeInstanceOf(ContractViolationError);
  });
});

describe('SessionsClient.attach', () => {
  // @story US-STO-11
  it('[US-STO-11][api][sdk] sends the file bytes under its name and reads the saved row', async () => {
    const saved = { fileId: 'file-1', path: '.attachments/s/u/scan.txt', size: 5 };
    const { sessions, calls } = client(() => json(201, saved));
    const file = new File(['hello'], 'my scan.txt', { type: 'text/plain' });
    expect(await sessions.attach(SESSION, file)).toEqual(saved);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe(`/api/sessions/${SESSION}/attachments`);
    expect(call?.url.searchParams.get('name')).toBe('my scan.txt');
    expect(call?.headers.get('content-type')).toBe('text/plain');
    expect(call?.init.body).toBe(file);
  });

  // @story US-STO-11
  it('[US-STO-11][api][sdk] surfaces the concealed refusal by code', async () => {
    const { sessions } = client(() => problem(404, 'file_not_found'));
    const failure = await sessions.attach(SESSION, new File(['x'], 'a')).catch((e: unknown) => e);
    expect((failure as ApiProblemError).status).toBe(404);
    expect((failure as ApiProblemError).code).toBe('file_not_found');
  });
});

describe('SessionsClient.update', () => {
  it('patches exactly the fields given and reads the wrapped 200', async () => {
    const renamed = { ...session, title: 'Incident 42' };
    const { sessions, calls } = client(() => json(200, { session: renamed }));
    expect(await sessions.update(SESSION, { title: 'Incident 42' })).toEqual(renamed);
    const [call] = calls;
    expect(call?.method).toBe('PATCH');
    expect(call?.url.pathname).toBe(`/api/sessions/${SESSION}`);
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.json).toEqual({ title: 'Incident 42' });
  });

  it('sends an explicit null title and a status transition as the route parses them', async () => {
    const { sessions, calls } = client(() =>
      json(200, { session: { ...session, title: null, status: 'archived' } }),
    );
    await sessions.update(SESSION, { title: null, status: 'archived' });
    expect(calls[0]?.json).toEqual({ title: null, status: 'archived' });
  });

  it('surfaces the route refusals by code', async () => {
    for (const [status, code] of [
      [400, 'invalid_body'],
      [400, 'invalid_title'],
      [400, 'invalid_session_status'],
      [404, 'session_not_found'],
    ] as const) {
      const { sessions } = client(() => problem(status, code));
      const failure = await sessions.update(SESSION, { title: 'x' }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { sessions } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const failure = await sessions
      .update(SESSION, { title: 'x' }, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});

describe('SessionsClient.transcript.read', () => {
  it('reads the main transcript by provider session id with the projectKey the route requires', async () => {
    const { sessions, calls } = client(() => json(200, { entries }));
    const read = await sessions.transcript.read(PROVIDER_SESSION, { projectKey: WORKSPACE });
    expect(read).toEqual(entries);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.pathname).toBe(`/api/sessions/${PROVIDER_SESSION}/transcript`);
    expect([...(call?.url.searchParams.entries() ?? [])]).toEqual([['projectKey', WORKSPACE]]);
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(call?.json).toBeUndefined();
  });

  it('omits projectKey entirely when not given — the server defaults it (issue #235, S-21)', async () => {
    const { sessions, calls } = client(() => json(200, { entries }));
    const read = await sessions.transcript.read(PROVIDER_SESSION);
    expect(read).toEqual(entries);
    expect(calls[0]?.url.search).toBe('');
    expect(calls[0]?.url.searchParams.has('projectKey')).toBe(false);
  });

  it('addresses a subagent transcript through subpath, percent-encoded', async () => {
    const { sessions, calls } = client(() => json(200, { entries: [] }));
    const read = await sessions.transcript.read(PROVIDER_SESSION, {
      projectKey: WORKSPACE,
      subpath: 'subagents/agent-1a2b',
    });
    expect(read).toEqual([]);
    expect(calls[0]?.url.search).toBe(`?projectKey=${WORKSPACE}&subpath=subagents%2Fagent-1a2b`);
  });

  it('encodes a caller-supplied provider session id so it cannot escape the path', async () => {
    const { sessions, calls } = client(() => problem(400, 'invalid_session_id'));
    const failure = await sessions.transcript
      .read('../runs?x=1#f', { projectKey: WORKSPACE })
      .catch((e: unknown) => e);
    expect(calls[0]?.url.pathname).toBe('/api/sessions/..%2Fruns%3Fx%3D1%23f/transcript');
    expect((failure as ApiProblemError).code).toBe('invalid_session_id');
  });

  it('surfaces every refusal the route documents by status and code', async () => {
    for (const [status, code] of [
      [503, 'session_api_not_configured'],
      [401, 'unauthenticated'],
      [400, 'invalid_session_id'],
      [400, 'invalid_project_key'],
      [400, 'invalid_subpath'],
      [403, 'project_key_mismatch'],
      [403, 'session_forbidden'],
      [409, 'session_archived'],
      [404, 'transcript_not_found'],
    ] as const) {
      const { sessions } = client(() => problem(status, code));
      const failure = await sessions.transcript
        .read(PROVIDER_SESSION, { projectKey: WORKSPACE })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });

  it('refuses a bare array, JSONL text, and an extra key as contract violations', async () => {
    const bare = client(() => json(200, entries));
    await expect(
      bare.sessions.transcript.read(PROVIDER_SESSION, { projectKey: WORKSPACE }),
    ).rejects.toBeInstanceOf(ContractViolationError);
    const jsonl = client(
      () =>
        new Response(entries.map((entry) => JSON.stringify(entry)).join('\n'), {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    );
    const notJson = await jsonl.sessions.transcript
      .read(PROVIDER_SESSION, { projectKey: WORKSPACE })
      .catch((e: unknown) => e);
    expect(notJson).toBeInstanceOf(ContractViolationError);
    expect((notJson as ContractViolationError).issues.join('\n')).toContain('not JSON');
    const extra = client(() => json(200, { entries, subkeys: [] }));
    await expect(
      extra.sessions.transcript.read(PROVIDER_SESSION, { projectKey: WORKSPACE }),
    ).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { sessions, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const failure = await sessions.transcript
      .read(PROVIDER_SESSION, { projectKey: WORKSPACE }, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('SessionsClient.transcript.subkeys', () => {
  it('lists the subkeys by provider session id with the projectKey the route requires', async () => {
    const subkeys = ['subagents/agent-1a2b', 'subagents/agent-3c4d'];
    const { sessions, calls } = client(() => json(200, { subkeys }));
    expect(await sessions.transcript.subkeys(PROVIDER_SESSION, { projectKey: WORKSPACE })).toEqual(
      subkeys,
    );
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.pathname).toBe(`/api/sessions/${PROVIDER_SESSION}/subkeys`);
    expect(call?.url.search).toBe(`?projectKey=${WORKSPACE}`);
  });

  it('omits projectKey entirely when not given — the server defaults it (issue #235, S-21)', async () => {
    const { sessions, calls } = client(() => json(200, { subkeys: [] }));
    expect(await sessions.transcript.subkeys(PROVIDER_SESSION)).toEqual([]);
    expect(calls[0]?.url.search).toBe('');
  });

  it('surfaces every refusal the route documents by status and code', async () => {
    for (const [status, code] of [
      [503, 'session_api_not_configured'],
      [401, 'unauthenticated'],
      [400, 'invalid_session_id'],
      [400, 'invalid_project_key'],
      [403, 'project_key_mismatch'],
      [403, 'session_forbidden'],
    ] as const) {
      const { sessions } = client(() => problem(status, code));
      const failure = await sessions.transcript
        .subkeys(PROVIDER_SESSION, { projectKey: WORKSPACE })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });

  it('refuses a bare array and a subkey outside the grammar as contract violations', async () => {
    const bare = client(() => json(200, ['subagents/agent-1']));
    await expect(
      bare.sessions.transcript.subkeys(PROVIDER_SESSION, { projectKey: WORKSPACE }),
    ).rejects.toBeInstanceOf(ContractViolationError);
    const traversal = client(() => json(200, { subkeys: ['../other'] }));
    const failure = await traversal.sessions.transcript
      .subkeys(PROVIDER_SESSION, { projectKey: WORKSPACE })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues.join('\n')).toContain('subkeys.0');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { sessions } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const failure = await sessions.transcript
      .subkeys(PROVIDER_SESSION, { projectKey: WORKSPACE }, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});
