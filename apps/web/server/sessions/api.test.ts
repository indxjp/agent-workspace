/**
 * The five §20 session handlers, against a real store and a real principal.
 *
 * The order every handler is written in — configured → authenticated → well-formed → scoped →
 * found — is asserted step by step, because each step is a lock and a lock that is never tried is
 * not known to be locked (ADR-0015).
 */
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionListResponseSchema } from '@indx-workspace/contracts/sessions';

import {
  appendTranscript,
  deleteTranscript,
  listSessions,
  listTranscriptSubkeys,
  loadTranscript,
  getSession,
  updateSession,
} from './api';
import {
  createInMemoryWorkspaceScopeResolver,
  SESSION_STATE_PAGE_LIMIT,
  type SessionRecord,
  type SessionRepositoryProvider,
} from '@agent-workspace/core/db';
import { encodeListCursor } from '../pagination/list-cursor';
import { sessionPageOf } from '../pagination/testing';
import type { SessionApiPrincipal } from './environment';
import { createRepositorySessionsStoreProvider } from './store';
import { InMemoryTranscriptStore } from './memory-store';
import { InMemorySessionStateStore } from './state-memory-store';
import type { TranscriptStore } from './transcript';

const WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';
const OTHER_WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000002';
const USER = 'c8b1f0de-6a2e-4a1f-9d3b-000000000009';
const SESSION = '11111111-2222-4333-8444-555555555555';

const PRINCIPAL: SessionApiPrincipal = {
  kind: 'user',
  principalId: USER,
  ownerPrincipalId: USER,
  userId: USER,
  workspaceId: WORKSPACE,
  role: 'builder',
};

/**
 * What an API key resolves to here. `SessionApiPrincipal` has no `api-key` variant: a key becomes a
 * `kind: 'user'` principal whose `userId` is `null`, because `Principal.fromApiKey` carries no
 * human (`apps/web/server/composition/session-rbac.ts`). S-21's default must hold for it too —
 * §5.11 promises the omitted key defaults "for both a user and an API-key principal".
 */
const API_KEY_PRINCIPAL: SessionApiPrincipal = { ...PRINCIPAL, userId: null };

/** Both callers the S-21 default is promised for, as `it.each` rows. */
const DEFAULTING_PRINCIPALS = [
  ['a user', PRINCIPAL],
  ['an API-key principal', API_KEY_PRINCIPAL],
] as const;

function install(
  options: {
    authenticated?: boolean;
    store?: TranscriptStore;
    principal?: SessionApiPrincipal;
  } = {},
): {
  store: TranscriptStore;
} {
  const store = options.store ?? new InMemoryTranscriptStore();
  const principal = options.principal ?? PRINCIPAL;
  installTestDomains({
    sessions: {
      authenticate: () => Promise.resolve((options.authenticated ?? true) ? principal : null),
      canAccessSession: () => Promise.resolve(true),
      store,
    },
  });
  return { store };
}

function get(path: string): Request {
  return new Request(`https://control.example${path}`);
}

function post(path: string, body: unknown): Request {
  return new Request(`https://control.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(path: string): Request {
  return new Request(`https://control.example${path}`, { method: 'DELETE' });
}

function patch(path: string, body: unknown): Request {
  return new Request(`https://control.example${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function installLifecycle(status: 'active' | 'archived' = 'active') {
  const initial: SessionRecord = {
    engine: null,
    agentVersionId: null,
    id: SESSION,
    workspaceId: WORKSPACE,
    ownerPrincipalId: USER,
    userId: USER,
    agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: null,
    engineSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    title: 'First session',
    status,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
  let row = initial;
  const provider: SessionRepositoryProvider = {
    forScope: () => ({
      ensure: () => Promise.resolve({ kind: 'existing', session: row }),
      get: (id) => Promise.resolve(id === row.id ? row : null),
      getByEngineSessionId: (id) => Promise.resolve(id === row.engineSessionId ? row : null),
      list: (input) => Promise.resolve(sessionPageOf([row], input)),
      update: (id, input) => {
        if (id !== row.id) return Promise.resolve({ kind: 'not-found' });
        if (Object.keys(input).length === 0)
          return Promise.resolve({ kind: 'no-op', session: row });
        row = { ...row, ...input, updatedAt: new Date('2026-09-02T00:00:00Z') };
        return Promise.resolve({ kind: 'updated', session: row });
      },
      archive: (id) => {
        if (id !== row.id) return Promise.resolve({ kind: 'not-found' });
        if (row.status === 'archived') return Promise.resolve({ kind: 'no-op', session: row });
        row = { ...row, status: 'archived' };
        return Promise.resolve({ kind: 'updated', session: row });
      },
      restore: (id) => {
        if (id !== row.id) return Promise.resolve({ kind: 'not-found' });
        if (row.status === 'active') return Promise.resolve({ kind: 'no-op', session: row });
        row = { ...row, status: 'active' };
        return Promise.resolve({ kind: 'updated', session: row });
      },
      discardIfUnused: () => Promise.resolve(false),
    }),
  };
  installTestDomains({
    sessions: {
      authenticate: () => Promise.resolve(PRINCIPAL),
      canAccessSession: (_principal, id) =>
        Promise.resolve(id === row.id || id === row.engineSessionId),
      store: new InMemoryTranscriptStore(),
      sessions: createRepositorySessionsStoreProvider({
        repositories: provider,
        scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'workspace' }]),
      }),
    },
  });
  return () => row;
}

const TRANSCRIPT = `/api/sessions/${SESSION}/transcript`;

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(no code)';
}

afterEach(() => {
  clearApplicationContext();
});

describe('nothing installed', () => {
  it.each([
    ['GET /api/sessions', (): Promise<Response> => listSessions(get('/api/sessions'))],
    ['GET transcript', (): Promise<Response> => loadTranscript(get(TRANSCRIPT), SESSION)],
    ['POST transcript', (): Promise<Response> => appendTranscript(post(TRANSCRIPT, {}), SESSION)],
    ['DELETE transcript', (): Promise<Response> => deleteTranscript(del(TRANSCRIPT), SESSION)],
    [
      'GET subkeys',
      (): Promise<Response> =>
        listTranscriptSubkeys(get(`/api/sessions/${SESSION}/subkeys`), SESSION),
    ],
  ])('%s answers 503 and names what is missing', async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(503);
    // Not 401, which would promise credentials could fix it; not 200 with an empty transcript,
    // which would present an unconfigured deployment as an empty conversation.
    expect(await errorCode(response)).toBe('session_api_not_configured');
  });
});

describe('unauthenticated', () => {
  it('answers 401 before it looks at the body', async () => {
    install({ authenticated: false });
    const response = await appendTranscript(
      post(TRANSCRIPT, { this: 'body', is: 'nonsense' }),
      SESSION,
    );
    expect(response.status).toBe(401);
  });
});

describe('POST …/transcript — append', () => {
  it('stores a batch under the caller’s own tenant key and answers 204', async () => {
    const { store } = install();
    const response = await appendTranscript(
      post(TRANSCRIPT, {
        projectKey: WORKSPACE,
        entries: [{ type: 'user', uuid: 'a', text: 'ORCHID' }],
      }),
      SESSION,
    );
    expect(response.status).toBe(204);
    await expect(store.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toEqual([
      { type: 'user', uuid: 'a', text: 'ORCHID' },
    ]);
  });

  it('stores a subagent transcript separately', async () => {
    const { store } = install();
    await appendTranscript(
      post(TRANSCRIPT, {
        projectKey: WORKSPACE,
        subpath: 'subagents/agent-7',
        entries: [{ type: 'user' }],
      }),
      SESSION,
    );
    await expect(store.listSubkeys({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toEqual(
      ['subagents/agent-7'],
    );
  });

  it('refuses a projectKey that is not the caller’s, and stores nothing', async () => {
    const { store } = install();
    const response = await appendTranscript(
      post(TRANSCRIPT, { projectKey: OTHER_WORKSPACE, entries: [{ type: 'user' }] }),
      SESSION,
    );
    // The §25 lever. R-01 §7: the SDK substitutes a cwd-derived key silently when it refuses the
    // one the runner asked for, so a mismatch is a misconfigured runtime and not a routing detail.
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('project_key_mismatch');
    await expect(
      store.load({ projectKey: OTHER_WORKSPACE, sessionId: SESSION }),
    ).resolves.toBeNull();
    await expect(store.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toBeNull();
  });

  it('refuses a cwd-derived projectKey, which is what a silent SDK fallback produces', async () => {
    install();
    const response = await appendTranscript(
      post(TRANSCRIPT, { projectKey: 'C--app-workspaces-tenant', entries: [{ type: 'user' }] }),
      SESSION,
    );
    expect(response.status).toBe(403);
  });

  it.each(DEFAULTING_PRINCIPALS)(
    'defaults to the caller’s own projectKey when the field is omitted, for %s (issue #235, S-21)',
    async (_name, principal) => {
      const { store } = install({ principal });
      const response = await appendTranscript(
        post(TRANSCRIPT, { entries: [{ type: 'user' }] }),
        SESSION,
      );
      expect(response.status).toBe(204);
      await expect(store.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toEqual([
        { type: 'user' },
      ]);
    },
  );

  it('still parses and compares a projectKey that is stated, even though it is no longer required', async () => {
    install();
    const response = await appendTranscript(
      post(TRANSCRIPT, { projectKey: 123, entries: [] }),
      SESSION,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_project_key');
  });

  it.each([
    ['a non-UUID session id', SESSION.replace('1', 'z'), 'invalid_session_id'],
    ['a session id that is a path', '../../etc', 'invalid_session_id'],
  ])('refuses %s', async (_name, id, code) => {
    install();
    const response = await appendTranscript(
      post(TRANSCRIPT, { projectKey: WORKSPACE, entries: [] }),
      id,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(code);
  });

  it('refuses a traversing subpath', async () => {
    install();
    const response = await appendTranscript(
      post(TRANSCRIPT, { projectKey: WORKSPACE, subpath: '../../escape', entries: [] }),
      SESSION,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_subpath');
  });

  it('refuses an entry with no type, naming the index', async () => {
    install();
    const response = await appendTranscript(
      post(TRANSCRIPT, { projectKey: WORKSPACE, entries: [{ type: 'user' }, { uuid: 'b' }] }),
      SESSION,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_entries');
  });

  it('refuses a body that is not a JSON object', async () => {
    install();
    const response = await appendTranscript(post(TRANSCRIPT, [1, 2, 3]), SESSION);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_body');
  });

  it('is idempotent under an SDK retry of the same batch', async () => {
    const { store } = install();
    const batch = { projectKey: WORKSPACE, entries: [{ type: 'user', uuid: 'a' }] };
    await appendTranscript(post(TRANSCRIPT, batch), SESSION);
    await appendTranscript(post(TRANSCRIPT, batch), SESSION);
    await expect(store.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toHaveLength(
      1,
    );
  });
});

describe('GET …/transcript — load', () => {
  it('returns what was appended', async () => {
    const { store } = install();
    await store.append({ projectKey: WORKSPACE, sessionId: SESSION }, [
      { type: 'user', uuid: 'a' },
    ]);
    const response = await loadTranscript(get(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entries: [{ type: 'user', uuid: 'a' }] });
  });

  it('answers 404 for a session nothing was written under', async () => {
    install();
    const response = await loadTranscript(get(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('transcript_not_found');
  });

  it('answers 200 with [] for a session that exists and is empty', async () => {
    const { store } = install();
    await store.append({ projectKey: WORKSPACE, sessionId: SESSION }, []);
    const response = await loadTranscript(get(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
    // The SDK resumes this one and not the 404 above, so the two must not be one status.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entries: [] });
  });

  it('cannot read another tenant’s transcript by naming its key', async () => {
    const { store } = install();
    await store.append({ projectKey: OTHER_WORKSPACE, sessionId: SESSION }, [{ type: 'user' }]);
    const response = await loadTranscript(
      get(`${TRANSCRIPT}?projectKey=${OTHER_WORKSPACE}`),
      SESSION,
    );
    expect(response.status).toBe(403);
  });

  it('cannot read another tenant’s transcript by omitting the key either — an omitted key defaults to the caller’s own (issue #235, S-21)', async () => {
    const { store } = install();
    await store.append({ projectKey: OTHER_WORKSPACE, sessionId: SESSION }, [{ type: 'user' }]);
    const response = await loadTranscript(get(TRANSCRIPT), SESSION);
    // Not 403 (nothing was declared to disagree with the caller) and not the other tenant's
    // entries: the omitted key resolves to the caller's own workspace, under which nothing was
    // ever written for this session.
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('transcript_not_found');
  });

  it.each(DEFAULTING_PRINCIPALS)(
    'with no projectKey returns the same body as with the principal’s own workspace key, for %s (issue #235, S-21)',
    async (_name, principal) => {
      const { store } = install({ principal });
      await store.append({ projectKey: WORKSPACE, sessionId: SESSION }, [
        { type: 'user', uuid: 'a' },
      ]);
      const withKey = await loadTranscript(get(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
      const withoutKey = await loadTranscript(get(TRANSCRIPT), SESSION);
      expect(withoutKey.status).toBe(withKey.status);
      await expect(withoutKey.json()).resolves.toEqual(await withKey.json());
    },
  );

  it('refuses a same-workspace session that the authenticated user does not own', async () => {
    const store = new InMemoryTranscriptStore();
    await store.append({ projectKey: WORKSPACE, sessionId: SESSION }, [{ type: 'user' }]);
    installTestDomains({
      sessions: {
        authenticate: () => Promise.resolve(PRINCIPAL),
        canAccessSession: () => Promise.resolve(false),
        store,
      },
    });

    const response = await loadTranscript(get(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);

    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('session_forbidden');
  });

  it('reads a subagent transcript when the subpath is named', async () => {
    const { store } = install();
    await store.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/a-1' }, [
      { type: 'user', uuid: 'sub' },
    ]);
    const response = await loadTranscript(
      get(`${TRANSCRIPT}?projectKey=${WORKSPACE}&subpath=subagents%2Fa-1`),
      SESSION,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entries: [{ type: 'user', uuid: 'sub' }] });
  });
});

describe('DELETE …/transcript', () => {
  it('removes the transcript and every subkey, and is idempotent', async () => {
    const { store } = install();
    await store.append({ projectKey: WORKSPACE, sessionId: SESSION }, [{ type: 'user' }]);
    await store.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/a-1' }, [
      { type: 'user' },
    ]);
    const first = await deleteTranscript(del(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
    expect(first.status).toBe(204);
    await expect(store.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toBeNull();
    await expect(
      store.load({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/a-1' }),
    ).resolves.toBeNull();
    const second = await deleteTranscript(del(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
    expect(second.status).toBe(204);
  });

  it('refuses to delete under another tenant’s key', async () => {
    const { store } = install();
    await store.append({ projectKey: OTHER_WORKSPACE, sessionId: SESSION }, [{ type: 'user' }]);
    const response = await deleteTranscript(
      del(`${TRANSCRIPT}?projectKey=${OTHER_WORKSPACE}`),
      SESSION,
    );
    expect(response.status).toBe(403);
    await expect(
      store.load({ projectKey: OTHER_WORKSPACE, sessionId: SESSION }),
    ).resolves.not.toBeNull();
  });
});

describe('GET …/subkeys', () => {
  it('lists the subagent transcripts of one session', async () => {
    const { store } = install();
    await store.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/a-1' }, [
      { type: 'user' },
    ]);
    const response = await listTranscriptSubkeys(
      get(`/api/sessions/${SESSION}/subkeys?projectKey=${WORKSPACE}`),
      SESSION,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ subkeys: ['subagents/a-1'] });
  });

  it('refuses another tenant’s key', async () => {
    install();
    const response = await listTranscriptSubkeys(
      get(`/api/sessions/${SESSION}/subkeys?projectKey=${OTHER_WORKSPACE}`),
      SESSION,
    );
    expect(response.status).toBe(403);
  });

  it.each(DEFAULTING_PRINCIPALS)(
    'with no projectKey returns the same body as with the principal’s own workspace key, for %s (issue #235, S-21)',
    async (_name, principal) => {
      const { store } = install({ principal });
      await store.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/a-1' }, [
        { type: 'user' },
      ]);
      const withKey = await listTranscriptSubkeys(
        get(`/api/sessions/${SESSION}/subkeys?projectKey=${WORKSPACE}`),
        SESSION,
      );
      const withoutKey = await listTranscriptSubkeys(
        get(`/api/sessions/${SESSION}/subkeys`),
        SESSION,
      );
      expect(withoutKey.status).toBe(withKey.status);
      await expect(withoutKey.json()).resolves.toEqual(await withKey.json());
    },
  );
});

/**
 * ENG-06 (ADR-0071): the runner writes a Claude transcript to the engine-scoped store and nothing
 * writes the legacy tables any more, so the two public reads serve the new store first and fall back
 * to the legacy one only for a session the new store has no stream for.
 */
describe('GET …/transcript and …/subkeys over the engine-scoped store', () => {
  const ENGINE_ID = 'claude-agent-sdk';

  function installBoth(session: Partial<SessionRecord> = {}): {
    legacy: InMemoryTranscriptStore;
    state: InMemorySessionStateStore;
  } {
    const record: SessionRecord = {
      id: SESSION,
      workspaceId: WORKSPACE,
      ownerPrincipalId: USER,
      userId: USER,
      agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: null,
      engineSessionId: SESSION,
      engine: ENGINE_ID,
      agentVersionId: null,
      title: null,
      status: 'active',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      ...session,
    };
    const legacy = new InMemoryTranscriptStore();
    const state = new InMemorySessionStateStore();
    installTestDomains({
      sessions: {
        authenticate: () => Promise.resolve(PRINCIPAL),
        canAccessSession: () => Promise.resolve(true),
        store: legacy,
        stateStore: state,
        sessions: createRepositorySessionsStoreProvider({
          repositories: {
            forScope: () => ({
              ensure: () => Promise.resolve({ kind: 'existing', session: record }),
              get: (id) => Promise.resolve(id === record.id ? record : null),
              getByEngineSessionId: (id) =>
                Promise.resolve(id === record.engineSessionId ? record : null),
              list: (input) => Promise.resolve(sessionPageOf([record], input)),
              update: () => Promise.resolve({ kind: 'no-op', session: record }),
              archive: () => Promise.resolve({ kind: 'no-op', session: record }),
              restore: () => Promise.resolve({ kind: 'no-op', session: record }),
              discardIfUnused: () => Promise.resolve(false),
            }),
          },
          scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'workspace' }]),
        }),
      },
    });
    return { legacy, state };
  }

  function stream(streamKey: string) {
    return { workspaceId: WORKSPACE, sessionId: SESSION, engine: ENGINE_ID, streamKey } as const;
  }

  it('serves a post-ENG-06 session from the engine-scoped store, keyed projectKey + "/" + subpath', async () => {
    const { state } = installBoth();
    await state.append(stream(`${WORKSPACE}/`), [
      { entryKey: 'u-1', entry: { type: 'user', uuid: 'u-1' } },
      { entryKey: 'a-1', entry: { type: 'assistant', uuid: 'a-1' } },
    ]);
    await state.append(stream(`${WORKSPACE}/subagents/agent-1`), [{ entry: { type: 'user' } }]);

    const main = await loadTranscript(get(TRANSCRIPT), SESSION);
    expect(main.status).toBe(200);
    await expect(main.json()).resolves.toEqual({
      entries: [
        { type: 'user', uuid: 'u-1' },
        { type: 'assistant', uuid: 'a-1' },
      ],
    });
    const sub = await loadTranscript(get(`${TRANSCRIPT}?subpath=subagents/agent-1`), SESSION);
    await expect(sub.json()).resolves.toEqual({ entries: [{ type: 'user' }] });

    const subkeys = await listTranscriptSubkeys(get(`/api/sessions/${SESSION}/subkeys`), SESSION);
    await expect(subkeys.json()).resolves.toEqual({ subkeys: ['subagents/agent-1'] });
  });

  it('answers an empty stream as an empty transcript, not a 404', async () => {
    const { state } = installBoth();
    await state.append(stream(`${WORKSPACE}/`), []);
    const response = await loadTranscript(get(TRANSCRIPT), SESSION);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entries: [] });
  });

  it('prefers the engine-scoped stream over a legacy transcript of the same key', async () => {
    const { legacy, state } = installBoth();
    await legacy.append({ projectKey: WORKSPACE, sessionId: SESSION }, [{ type: 'legacy' }]);
    await state.append(stream(`${WORKSPACE}/`), [{ entry: { type: 'current' } }]);
    const response = await loadTranscript(get(TRANSCRIPT), SESSION);
    await expect(response.json()).resolves.toEqual({ entries: [{ type: 'current' }] });
  });

  it('falls back to the legacy tables for a pre-ENG-06 session the new store has no stream for', async () => {
    const { legacy } = installBoth({ engine: null });
    await legacy.append({ projectKey: WORKSPACE, sessionId: SESSION }, [
      { type: 'user', uuid: 'old-1' },
    ]);
    await legacy.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/old' }, [
      { type: 'user' },
    ]);

    const main = await loadTranscript(get(TRANSCRIPT), SESSION);
    expect(main.status).toBe(200);
    await expect(main.json()).resolves.toEqual({ entries: [{ type: 'user', uuid: 'old-1' }] });

    const subkeys = await listTranscriptSubkeys(get(`/api/sessions/${SESSION}/subkeys`), SESSION);
    await expect(subkeys.json()).resolves.toEqual({ subkeys: ['subagents/old'] });
  });

  it('lists the union of both stores’ subkeys, because a read falls back per stream', async () => {
    const { legacy, state } = installBoth();
    await legacy.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/b' }, [
      { type: 'user' },
    ]);
    await state.append(stream(`${WORKSPACE}/subagents/a`), [{ entry: { type: 'user' } }]);
    await state.append(stream(`${WORKSPACE}/subagents/b`), [{ entry: { type: 'user' } }]);
    const subkeys = await listTranscriptSubkeys(get(`/api/sessions/${SESSION}/subkeys`), SESSION);
    await expect(subkeys.json()).resolves.toEqual({ subkeys: ['subagents/a', 'subagents/b'] });
  });

  it('answers 404 transcript_not_found when neither store has the stream', async () => {
    installBoth();
    const response = await loadTranscript(get(TRANSCRIPT), SESSION);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('transcript_not_found');
  });

  it('reads a transcript longer than one store page whole, in order', async () => {
    const { state } = installBoth();
    const total = SESSION_STATE_PAGE_LIMIT + 1;
    const entries = Array.from({ length: total }, (_, index) => ({
      entryKey: `u-${String(index)}`,
      entry: { type: 'user', uuid: `u-${String(index)}` },
    }));
    await state.append(stream(`${WORKSPACE}/`), entries);
    // The fake caps a page the way the repository does, so this read has to follow the cursor.
    await expect(state.list(stream(`${WORKSPACE}/`), {})).resolves.toHaveLength(
      SESSION_STATE_PAGE_LIMIT,
    );

    const response = await loadTranscript(get(TRANSCRIPT), SESSION);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: { uuid: string }[] };
    expect(body.entries.map((entry) => entry.uuid)).toEqual(entries.map((one) => one.entryKey));
  });

  it('refuses an archived session whose engine_session_id is still NULL with 409 session_archived', async () => {
    const { state } = installBoth({ status: 'archived', engineSessionId: null });
    await state.append(stream(`${WORKSPACE}/`), [{ entry: { type: 'user' } }]);
    const response = await loadTranscript(get(TRANSCRIPT), SESSION);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('session_archived');
  });

  it('subkeys refuses an archived session with 409 session_archived', async () => {
    const { state } = installBoth({ status: 'archived' });
    await state.append(stream(`${WORKSPACE}/subagents/agent-1`), [{ entry: { type: 'user' } }]);
    const response = await listTranscriptSubkeys(get(`/api/sessions/${SESSION}/subkeys`), SESSION);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('session_archived');
  });

  it('POST appends to the engine-scoped stream, so the next GET reads the posted entries', async () => {
    const { legacy, state } = installBoth();
    const posted = await appendTranscript(
      post(TRANSCRIPT, {
        entries: [
          { type: 'user', uuid: 'p-1' },
          { type: 'assistant', uuid: 'p-2' },
        ],
      }),
      SESSION,
    );
    expect(posted.status).toBe(204);

    const response = await loadTranscript(get(TRANSCRIPT), SESSION);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      entries: [
        { type: 'user', uuid: 'p-1' },
        { type: 'assistant', uuid: 'p-2' },
      ],
    });
    // Written to the stream the read serves, keyed by `uuid`, and not to the legacy tables.
    await expect(state.list(stream(`${WORKSPACE}/`), {})).resolves.toMatchObject([
      { entryKey: 'p-1' },
      { entryKey: 'p-2' },
    ]);
    await expect(legacy.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toBeNull();
  });

  it('POST refuses a session pinned to another engine with 409 session_engine_mismatch', async () => {
    // No second engine is registered yet (`ENGINE_IDS`), so the row is cast: this is the pin a
    // future engine's session carries.
    const { legacy } = installBoth({ engine: 'another-engine' as SessionRecord['engine'] });
    const posted = await appendTranscript(
      post(TRANSCRIPT, { entries: [{ type: 'user', uuid: 'p-1' }] }),
      SESSION,
    );
    expect(posted.status).toBe(409);
    expect(await errorCode(posted)).toBe('session_engine_mismatch');
    await expect(legacy.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toBeNull();
  });

  it('DELETE removes a post-ENG-06 transcript, so the next GET is 404', async () => {
    const { state } = installBoth();
    await state.append(stream(`${WORKSPACE}/`), [{ entryKey: 'u-1', entry: { type: 'user' } }]);
    const deleted = await deleteTranscript(del(TRANSCRIPT), SESSION);
    expect(deleted.status).toBe(204);
    const response = await loadTranscript(get(TRANSCRIPT), SESSION);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('transcript_not_found');
  });

  it('DELETE removes a pre-ENG-06 transcript from the legacy tables, so the next GET is 404', async () => {
    const { legacy } = installBoth({ engine: null });
    await legacy.append({ projectKey: WORKSPACE, sessionId: SESSION }, [
      { type: 'user', uuid: 'old-1' },
    ]);
    const deleted = await deleteTranscript(del(TRANSCRIPT), SESSION);
    expect(deleted.status).toBe(204);
    const response = await loadTranscript(get(TRANSCRIPT), SESSION);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('transcript_not_found');
  });

  it('DELETE removes both copies when a migrated session still has its legacy rows', async () => {
    const { legacy, state } = installBoth();
    await legacy.append({ projectKey: WORKSPACE, sessionId: SESSION }, [{ type: 'legacy' }]);
    await state.append(stream(`${WORKSPACE}/`), [{ entry: { type: 'current' } }]);
    await deleteTranscript(del(TRANSCRIPT), SESSION);
    const response = await loadTranscript(get(TRANSCRIPT), SESSION);
    expect(response.status).toBe(404);
  });
});

describe('GET /api/sessions', () => {
  it('answers 500, not 200, when the workspace id could not be a projectKey', async () => {
    installTestDomains({
      sessions: {
        authenticate: () =>
          Promise.resolve({
            kind: 'user',
            principalId: USER,
            ownerPrincipalId: USER,
            userId: USER,
            workspaceId: 'not a valid project key',
            role: 'builder',
          }),
        canAccessSession: () => Promise.resolve(true),
        store: new InMemoryTranscriptStore(),
      },
    });
    const response = await listSessions(get('/api/sessions'));
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe('workspace_not_addressable');
  });
});

describe('complete session lifecycle', () => {
  it('lists only sessions owned by the exact API-key principal when user ids are null', async () => {
    const apiKeyA: SessionApiPrincipal = {
      kind: 'user',
      principalId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      ownerPrincipalId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      userId: null,
      workspaceId: WORKSPACE,
      role: 'builder',
    };
    const apiKeyB: SessionApiPrincipal = {
      kind: 'user',
      principalId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      ownerPrincipalId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      userId: null,
      workspaceId: WORKSPACE,
      role: 'builder',
    };
    const rowFor = (principalId: string, id: string): SessionRecord => ({
      engine: null,
      agentVersionId: null,
      id,
      workspaceId: WORKSPACE,
      ownerPrincipalId: principalId,
      userId: null,
      agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: null,
      engineSessionId: null,
      title: null,
      status: 'active',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    });
    const sessionA = '11111111-1111-4111-8111-111111111111';
    const sessionB = '22222222-2222-4222-8222-222222222222';
    const rows = [rowFor(apiKeyA.principalId, sessionA), rowFor(apiKeyB.principalId, sessionB)];
    let caller = apiKeyA;
    const unused = (): Promise<never> => Promise.reject(new Error('not used by session listing'));
    const provider: SessionRepositoryProvider = {
      forScope: () => ({
        ensure: unused,
        get: unused,
        getByEngineSessionId: unused,
        list: (input) => Promise.resolve(sessionPageOf(rows, input)),
        update: unused,
        archive: unused,
        restore: unused,
        discardIfUnused: () => Promise.resolve(false),
      }),
    };
    installTestDomains({
      sessions: {
        authenticate: () => Promise.resolve(caller),
        canAccessSession: () => Promise.resolve(true),
        store: new InMemoryTranscriptStore(),
        sessions: createRepositorySessionsStoreProvider({
          repositories: provider,
          scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'workspace' }]),
        }),
      },
    });

    const listedForA = (await (await listSessions(get('/api/sessions'))).json()) as {
      sessions: Array<{ id: string }>;
    };
    caller = apiKeyB;
    const listedForB = (await (await listSessions(get('/api/sessions'))).json()) as {
      sessions: Array<{ id: string }>;
    };

    expect(listedForA.sessions.map(({ id }) => id)).toEqual([sessionA]);
    expect(listedForB.sessions.map(({ id }) => id)).toEqual([sessionB]);
  });

  it('lists complete rows and marks only active mapped sessions resumable', async () => {
    installLifecycle();
    const response = await listSessions(get('/api/sessions?status=active'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessions: [{ id: SESSION, title: 'First session', status: 'active', resumable: true }],
    });
  });

  it('updates the title, archives idempotently, and restores without deleting the transcript', async () => {
    const current = installLifecycle();
    const titled = await updateSession(
      patch(`/api/sessions/${SESSION}`, { title: 'Renamed' }),
      SESSION,
    );
    expect(titled.status).toBe(200);
    const archived = await updateSession(
      patch(`/api/sessions/${SESSION}`, { status: 'archived' }),
      SESSION,
    );
    expect(archived.status).toBe(200);
    expect(current()).toMatchObject({ title: 'Renamed', status: 'archived' });
    const again = await updateSession(
      patch(`/api/sessions/${SESSION}`, { status: 'archived' }),
      SESSION,
    );
    expect(again.status).toBe(200);
    const restored = await updateSession(
      patch(`/api/sessions/${SESSION}`, { status: 'active' }),
      SESSION,
    );
    expect(restored.status).toBe(200);
    expect(current().status).toBe('active');
    expect((await getSession(get(`/api/sessions/${SESSION}`), SESSION)).status).toBe(200);
  });

  it('refuses transcript resume while archived', async () => {
    const current = installLifecycle('archived');
    const claudeId = current().engineSessionId!;
    const response = await loadTranscript(
      get(`/api/sessions/${claudeId}/transcript?projectKey=${WORKSPACE}`),
      claudeId,
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('session_archived');
  });
});

describe('GET /api/sessions cursor pages (S-5)', () => {
  const OWNER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const OWNER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const rowAt = (id: string, owner: string, createdAt: string): SessionRecord => ({
    engine: null,
    agentVersionId: null,
    id,
    workspaceId: WORKSPACE,
    ownerPrincipalId: owner,
    userId: null,
    agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: null,
    engineSessionId: null,
    title: null,
    status: 'active',
    createdAt: new Date(createdAt),
    // `updated_at` runs the other way on purpose: the page order must not follow it.
    updatedAt: new Date(Date.parse('2027-01-01T00:00:00Z') - Date.parse(createdAt)),
  });
  const ROWS = [
    rowAt('00000000-0000-4000-8000-000000000001', OWNER_A, '2026-09-01T00:00:00.000Z'),
    rowAt('00000000-0000-4000-8000-000000000002', OWNER_B, '2026-09-01T00:00:01.000Z'),
    rowAt('00000000-0000-4000-8000-000000000003', OWNER_A, '2026-09-01T00:00:01.000Z'),
    rowAt('00000000-0000-4000-8000-000000000004', OWNER_A, '2026-09-01T00:00:01.000Z'),
    rowAt('00000000-0000-4000-8000-000000000005', OWNER_B, '2026-09-01T00:00:02.000Z'),
  ];
  const caller = (role: 'owner' | 'builder', principalId = OWNER_A): SessionApiPrincipal => ({
    kind: 'user',
    principalId,
    ownerPrincipalId: principalId,
    userId: null,
    workspaceId: WORKSPACE,
    role,
  });

  function installRows(principal: SessionApiPrincipal): string[] {
    const listed: string[] = [];
    const unused = (): Promise<never> => Promise.reject(new Error('not used by session listing'));
    installTestDomains({
      sessions: {
        authenticate: () => Promise.resolve(principal),
        canAccessSession: () => Promise.resolve(true),
        store: new InMemoryTranscriptStore(),
        sessions: createRepositorySessionsStoreProvider({
          repositories: {
            forScope: (scope) => ({
              ensure: unused,
              get: unused,
              getByEngineSessionId: unused,
              list: (input) => {
                listed.push(scope.workspaceId);
                return Promise.resolve(sessionPageOf(ROWS, input));
              },
              update: unused,
              archive: unused,
              restore: unused,
              discardIfUnused: () => Promise.resolve(false),
            }),
          } satisfies SessionRepositoryProvider,
          scopes: createInMemoryWorkspaceScopeResolver([
            { id: WORKSPACE, slug: 'workspace' },
            { id: OTHER_WORKSPACE, slug: 'other' },
          ]),
        }),
      },
    });
    return listed;
  }

  async function walk(search: string): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await listSessions(get(`/api/sessions?${search}${suffix}`));
      expect(response.status).toBe(200);
      // Every page is pinned to the published contract, not just to the fields read here.
      const body = SessionListResponseSchema.parse(await response.json());
      expect(body.sessions.length).toBeLessThanOrEqual(1);
      ids.push(...body.sessions.map(({ id }) => id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages <= ROWS.length);
    return { ids, pages };
  }

  it('walks limit=1 pages over every row exactly once, newest created first, and terminates', async () => {
    installRows(caller('owner'));
    const { ids, pages } = await walk('limit=1');
    expect(ids).toEqual([
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(pages).toBe(5);
  });

  it('pages only the rows a Builder may see, with every page full', async () => {
    installRows(caller('builder', OWNER_B));
    expect((await walk('limit=1')).ids).toEqual([
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000002',
    ]);
  });

  it('answers every row and nextCursor null when no limit is given', async () => {
    installRows(caller('owner'));
    const body = (await (await listSessions(get('/api/sessions'))).json()) as {
      sessions: unknown[];
      nextCursor: unknown;
    };
    expect(body.sessions).toHaveLength(5);
    expect(body.nextCursor).toBeNull();
  });

  const position = {
    createdAt: '2026-09-01T00:00:01.000Z',
    id: '00000000-0000-4000-8000-000000000004',
  };
  it.each([
    ['another workspace', encodeListCursor('sessions', OTHER_WORKSPACE, position)],
    ['the audit list', encodeListCursor('audit-events', WORKSPACE, position)],
    ['a truncated value', encodeListCursor('sessions', WORKSPACE, position).slice(0, -2)],
    ['not base64url', '%%%'],
  ])('refuses a cursor from %s with 400 invalid_cursor before reading a row', async (_, cursor) => {
    const listed = installRows(caller('owner'));
    const response = await listSessions(
      get(`/api/sessions?limit=1&cursor=${encodeURIComponent(cursor)}`),
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_cursor');
    expect(listed).toEqual([]);
  });

  it.each(['0', '201', '1.5', 'ten', ''])(
    'refuses limit=%j with 400 invalid_limit',
    async (limit) => {
      installRows(caller('owner'));
      const response = await listSessions(get(`/api/sessions?limit=${limit}`));
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_limit');
    },
  );

  it('ignores a projectKey the caller puts in the query string', async () => {
    const listed = installRows(caller('owner'));
    // The tenant comes from the principal. A query parameter naming another tenant changes
    // nothing, which is why the listing route reads none.
    const response = await listSessions(get(`/api/sessions?projectKey=${OTHER_WORKSPACE}`));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { projectKey: string }).projectKey).toBe(WORKSPACE);
    expect(listed).toEqual([WORKSPACE]);
  });
});
