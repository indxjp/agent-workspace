/**
 * The seven ENG-06 session-state handlers, against a real store and a real principal.
 *
 * The order every handler is written in — configured → authenticated → well-formed → scoped →
 * found — is asserted step by step, because each step is a lock and a lock that is never tried is
 * not known to be locked (ADR-0015).
 *
 * The four properties this family exists for get their own blocks, because each one is an
 * acceptance criterion of #305 rather than an implementation detail: idempotency by `entryKey`,
 * delete-last and replace-all, the engine check, and the 404 concealment a run token gets for a
 * session that is not its own.
 */
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { log as webLogger } from '../telemetry/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createInMemoryWorkspaceScopeResolver,
  type SessionRecord,
  type SessionRepositoryProvider,
} from '@agent-workspace/core/db';
import { ENGINE_IDS } from '@indx-workspace/contracts/engines';

import type { SessionApiPrincipal } from './environment';
import { createRepositorySessionsStoreProvider } from './store';
import { InMemoryTranscriptStore } from './memory-store';
import { InMemorySessionStateStore } from './state-memory-store';
import {
  appendSessionState,
  deleteSessionState,
  getSessionStateBlob,
  listSessionStateEntries,
  listSessionStateStreams,
  projectKeyMismatch,
  putSessionStateBlob,
  replaceSessionState,
} from './state-api';
import { GET as getStateBlobRoute } from '../../app/api/sessions/[engineSessionId]/state-blobs/route';

const WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';
const USER = 'c8b1f0de-6a2e-4a1f-9d3b-000000000009';
const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER_SESSION = '22222222-3333-4444-8555-666666666666';
const ENGINE = 'claude-agent-sdk';
const STREAM = `${WORKSPACE}/`;

const PRINCIPAL: SessionApiPrincipal = {
  kind: 'user',
  principalId: USER,
  ownerPrincipalId: USER,
  userId: USER,
  workspaceId: WORKSPACE,
  role: 'builder',
};

/** A runner, as `apps/web/server/composition/session-rbac.ts` resolves a per-run token. */
const RUNNER: SessionApiPrincipal = {
  kind: 'runner',
  workspaceId: WORKSPACE,
  runId: '33333333-4444-4555-8666-777777777777',
  sessionId: SESSION,
};

function row(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION,
    workspaceId: WORKSPACE,
    ownerPrincipalId: USER,
    userId: USER,
    agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: null,
    engineSessionId: SESSION,
    engine: ENGINE,
    agentVersionId: null,
    title: 'state',
    status: 'active',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function repository(session: SessionRecord): SessionRepositoryProvider {
  return {
    forScope: () => ({
      ensure: () => Promise.resolve({ kind: 'existing', session }),
      get: (id) => Promise.resolve(id === session.id ? session : null),
      getByEngineSessionId: (id) =>
        Promise.resolve(id === session.engineSessionId ? session : null),
      list: () => Promise.resolve({ items: [session], nextCursor: null }),
      update: () => Promise.resolve({ kind: 'no-op', session }),
      archive: () => Promise.resolve({ kind: 'no-op', session }),
      restore: () => Promise.resolve({ kind: 'no-op', session }),
      discardIfUnused: () => Promise.resolve(false),
    }),
  };
}

interface InstallOptions {
  readonly session?: SessionRecord;
  readonly principal?: SessionApiPrincipal | null;
  readonly stateStore?: InMemorySessionStateStore;
  readonly canAccess?: (principal: SessionApiPrincipal, id: string) => boolean;
}

function install(options: InstallOptions = {}): InMemorySessionStateStore {
  const session = options.session ?? row();
  const stateStore = options.stateStore ?? new InMemorySessionStateStore();
  const principal = options.principal === undefined ? PRINCIPAL : options.principal;
  const canAccess =
    options.canAccess ??
    ((caller: SessionApiPrincipal, id: string) =>
      caller.kind === 'runner' ? caller.sessionId === id : true);
  installTestDomains({
    sessions: {
      authenticate: () => Promise.resolve(principal),
      canAccessSession: (caller, id) => Promise.resolve(canAccess(caller, id)),
      store: new InMemoryTranscriptStore(),
      stateStore,
      sessions: createRepositorySessionsStoreProvider({
        repositories: repository(session),
        scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
      }),
    },
  });
  return stateStore;
}

afterEach(() => {
  clearApplicationContext();
  vi.restoreAllMocks();
});

function entriesUrl(query: Record<string, string> = {}, id = SESSION): string {
  const params = new URLSearchParams({ engine: ENGINE, streamKey: STREAM, ...query });
  return `https://control.example/api/sessions/${id}/state-entries?${params.toString()}`;
}

function appendRequest(body: unknown, id = SESSION): Request {
  return new Request(`https://control.example/api/sessions/${id}/state-entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function batch(entries: readonly unknown[]): unknown {
  return { engine: ENGINE, streamKey: STREAM, entries };
}

async function readEntries(id = SESSION): Promise<unknown> {
  const response = await listSessionStateEntries(new Request(entriesUrl({}, id)), id);
  expect(response.status).toBe(200);
  return response.json();
}

describe('the order every session-state handler is written in', () => {
  it('answers 503 before anything else when no session API is installed', async () => {
    clearApplicationContext();
    const response = await appendSessionState(appendRequest(batch([])), SESSION);
    expect(response.status).toBe(503);
  });

  it('answers 401 when the request carries no usable credential', async () => {
    install({ principal: null });
    const response = await appendSessionState(appendRequest(batch([])), SESSION);
    expect(response.status).toBe(401);
  });

  it('answers 400 for a path id that is not a UUID, before any lookup', async () => {
    install();
    const response = await appendSessionState(appendRequest(batch([]), 'not-a-uuid'), 'not-a-uuid');
    expect(response.status).toBe(400);
  });

  it.each([
    ['an engine this platform does not know', { engine: 'acp', streamKey: STREAM, entries: [] }],
    [
      'a stream key that is not printable ASCII',
      { engine: ENGINE, streamKey: 'a\nb', entries: [] },
    ],
    ['an empty stream key', { engine: ENGINE, streamKey: '', entries: [] }],
    ['an unknown body field', { engine: ENGINE, streamKey: STREAM, entries: [], extra: 1 }],
    ['an entry that is not an object', { engine: ENGINE, streamKey: STREAM, entries: [7] }],
    [
      'an entry whose payload is not an object',
      { engine: ENGINE, streamKey: STREAM, entries: [{ entry: 'text' }] },
    ],
    [
      'one batch naming a key twice',
      {
        engine: ENGINE,
        streamKey: STREAM,
        entries: [
          { entryKey: 'a', entry: { type: 'user' } },
          { entryKey: 'a', entry: { type: 'user' } },
        ],
      },
    ],
  ])('answers 400 for %s', async (_name, body) => {
    install();
    const response = await appendSessionState(appendRequest(body), SESSION);
    expect(response.status).toBe(400);
  });
});

describe('a run token reaches its own session and conceals every other', () => {
  it('lets the runner of this session write it', async () => {
    install({ principal: RUNNER });
    const response = await appendSessionState(
      appendRequest(batch([{ entryKey: 'a', entry: { type: 'user' } }])),
      SESSION,
    );
    expect(response.status).toBe(204);
  });

  it('answers 404 — not 403 — when the token names another session', async () => {
    // Concealment: these are private runner routes reached with a token scoped to one session, so
    // "that session exists and is not yours" is a fact the credential has no business learning.
    install({
      session: row({ id: OTHER_SESSION, engineSessionId: OTHER_SESSION }),
      principal: RUNNER,
    });
    const write = await appendSessionState(appendRequest(batch([]), OTHER_SESSION), OTHER_SESSION);
    expect(write.status).toBe(404);
    const read = await listSessionStateEntries(
      new Request(entriesUrl({}, OTHER_SESSION)),
      OTHER_SESSION,
    );
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ error: { code: 'session_state_not_found' } });
  });

  it('answers 404 for a session this workspace does not have', async () => {
    install();
    const response = await listSessionStateEntries(
      new Request(entriesUrl({}, OTHER_SESSION)),
      OTHER_SESSION,
    );
    expect(response.status).toBe(404);
  });
});

describe('the engine a stream declares must be the engine the session is pinned to', () => {
  it('refuses a disagreement with 409 session_engine_mismatch', async () => {
    // The fixture pins `claude-agent-sdk`; the only other value the closed set admits would be a
    // second engine id, so the disagreement is produced by pinning the session to a value the
    // request does not name.
    install({ session: row({ engine: null }) });
    const accepted = await appendSessionState(appendRequest(batch([])), SESSION);
    expect(accepted.status).toBe(204);

    clearApplicationContext();
    const store = new InMemorySessionStateStore();
    installTestDomains({
      sessions: {
        authenticate: () => Promise.resolve(PRINCIPAL),
        canAccessSession: () => Promise.resolve(true),
        store: new InMemoryTranscriptStore(),
        stateStore: store,
        // A session pinned to an engine that is not the one the request will name. The cast is the
        // narrowest way to express "a row written by a release whose engine set was larger", which is
        // exactly the state this check exists for.
        sessions: createRepositorySessionsStoreProvider({
          repositories: repository(row({ engine: 'another-engine' as SessionRecord['engine'] })),
          scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
        }),
      },
    });
    const refused = await appendSessionState(appendRequest(batch([])), SESSION);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'session_engine_mismatch' } });

    const deleted = await deleteSessionState(
      new Request(entriesUrl({ last: '1' }), { method: 'DELETE' }),
      SESSION,
    );
    expect(deleted.status).toBe(409);
    const replaced = await replaceSessionState(
      new Request(`https://control.example/api/sessions/${SESSION}/state-entries`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch([])),
      }),
      SESSION,
    );
    expect(replaced.status).toBe(409);
  });

  it('refuses a read or write of an archived session with 409 session_archived', async () => {
    // Every handler, read and write alike: `GET …/transcript` refuses an archived session because
    // the read is the resume path, and this family is the same resume path for every engine.
    install({ session: row({ status: 'archived' }) });
    const blobUrl = `https://control.example/api/sessions/${SESSION}/state-blobs?engine=${ENGINE}&blobKey=state.tar`;
    const responses = [
      await appendSessionState(appendRequest(batch([])), SESSION),
      await replaceSessionState(
        new Request(`https://control.example/api/sessions/${SESSION}/state-entries`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batch([])),
        }),
        SESSION,
      ),
      await deleteSessionState(new Request(entriesUrl(), { method: 'DELETE' }), SESSION),
      await listSessionStateEntries(new Request(entriesUrl()), SESSION),
      await listSessionStateStreams(
        new Request(`https://control.example/api/sessions/${SESSION}/state-streams`),
        SESSION,
      ),
      await putSessionStateBlob(
        new Request(blobUrl, { method: 'PUT', body: new Uint8Array([1]) }),
        SESSION,
      ),
      await getSessionStateBlob(new Request(blobUrl), SESSION),
    ];
    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'session_archived' } });
    }
  });
});

describe('appending is idempotent by entryKey', () => {
  it('stores one entry for two deliveries of the same key, in its original position', async () => {
    install();
    await appendSessionState(
      appendRequest(
        batch([
          { entryKey: 'a', entry: { type: 'user', text: 'first' } },
          { entryKey: 'b', entry: { type: 'assistant' } },
        ]),
      ),
      SESSION,
    );
    await appendSessionState(
      appendRequest(batch([{ entryKey: 'a', entry: { type: 'user', text: 'redelivered' } }])),
      SESSION,
    );
    expect(await readEntries()).toEqual({
      entries: [
        { sequence: 1, entryKey: 'a', entry: { type: 'user', text: 'redelivered' } },
        { sequence: 2, entryKey: 'b', entry: { type: 'assistant' } },
      ],
      nextCursor: 2,
    });
  });

  it('appends every keyless entry, because an entry with no identity cannot be deduped', async () => {
    install();
    await appendSessionState(
      appendRequest(batch([{ entry: { type: 'summary' } }, { entry: { type: 'summary' } }])),
      SESSION,
    );
    const read = (await readEntries()) as { entries: unknown[] };
    expect(read.entries).toHaveLength(2);
  });

  it('creates the stream for an empty batch, so "empty" and "never written" stay different', async () => {
    install();
    const before = await listSessionStateEntries(new Request(entriesUrl()), SESSION);
    expect(before.status).toBe(404);
    await appendSessionState(appendRequest(batch([])), SESSION);
    expect(await readEntries()).toEqual({ entries: [], nextCursor: null });
  });
});

describe('delete-last and replace-all', () => {
  it('removes exactly the last entry', async () => {
    install();
    await appendSessionState(
      appendRequest(
        batch([
          { entryKey: 'a', entry: { type: 'user' } },
          { entryKey: 'b', entry: { type: 'assistant' } },
        ]),
      ),
      SESSION,
    );
    const popped = await deleteSessionState(
      new Request(entriesUrl({ last: '1' }), { method: 'DELETE' }),
      SESSION,
    );
    expect(popped.status).toBe(204);
    expect(await readEntries()).toEqual({
      entries: [{ sequence: 1, entryKey: 'a', entry: { type: 'user' } }],
      nextCursor: 1,
    });
  });

  it('replaces every entry with exactly the ones given, renumbered from 1', async () => {
    install();
    await appendSessionState(
      appendRequest(batch([{ entryKey: 'a', entry: { type: 'user' } }])),
      SESSION,
    );
    const replaced = await replaceSessionState(
      new Request(`https://control.example/api/sessions/${SESSION}/state-entries`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch([{ entryKey: 'z', entry: { type: 'system' } }])),
      }),
      SESSION,
    );
    expect(replaced.status).toBe(204);
    expect(await readEntries()).toEqual({
      entries: [{ sequence: 1, entryKey: 'z', entry: { type: 'system' } }],
      nextCursor: 1,
    });
  });

  it('removes the whole stream without last=1, and refuses a last it does not understand', async () => {
    install();
    await appendSessionState(appendRequest(batch([])), SESSION);
    const confused = await deleteSessionState(
      new Request(entriesUrl({ last: 'yes' }), { method: 'DELETE' }),
      SESSION,
    );
    expect(confused.status).toBe(400);
    const dropped = await deleteSessionState(
      new Request(entriesUrl(), { method: 'DELETE' }),
      SESSION,
    );
    expect(dropped.status).toBe(204);
    const read = await listSessionStateEntries(new Request(entriesUrl()), SESSION);
    expect(read.status).toBe(404);
  });
});

describe('the stream listing', () => {
  it('reports every stream of this session, newest write first', async () => {
    install();
    await appendSessionState(appendRequest(batch([])), SESSION);
    await appendSessionState(
      appendRequest({
        engine: ENGINE,
        streamKey: `${WORKSPACE}/subagents/agent-1`,
        entries: [],
      }),
      SESSION,
    );
    const response = await listSessionStateStreams(
      new Request(`https://control.example/api/sessions/${SESSION}/state-streams`),
      SESSION,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { streams: { streamKey: string }[] };
    expect(body.streams.map((one) => one.streamKey)).toEqual([
      `${WORKSPACE}/subagents/agent-1`,
      STREAM,
    ]);
  });
});

describe('blobs', () => {
  function blobUrl(query: Record<string, string> = {}): string {
    const params = new URLSearchParams({ engine: ENGINE, blobKey: 'state.tar', ...query });
    return `https://control.example/api/sessions/${SESSION}/state-blobs?${params.toString()}`;
  }

  it('round-trips a snapshot and reports the digest it recorded', async () => {
    install();
    const stored = await putSessionStateBlob(
      new Request(blobUrl(), { method: 'PUT', body: new Uint8Array([1, 2, 3]) }),
      SESSION,
    );
    expect(stored.status).toBe(204);
    const read = await getSessionStateBlob(new Request(blobUrl()), SESSION);
    expect(read.status).toBe(200);
    expect(read.headers.get('x-session-state-sha256')).toMatch(/^[0-9a-f]{64}$/);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('answers a store that throws with the generic 500, never its message', async () => {
    const sentinel = ['postgresql://admin:', 'TOP-SECRET', '@internal.example/state'].join('');
    const stateStore = new InMemorySessionStateStore();
    vi.spyOn(stateStore, 'getBlob').mockRejectedValue(new Error(sentinel));
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    install({ stateStore });
    const response = await getStateBlobRoute(new Request(blobUrl()), {
      params: Promise.resolve({ engineSessionId: SESSION }),
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('TOP-SECRET');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'internal_error' } });
  });

  it('serves a snapshot as an inert attachment a browser never sniffs or renders', async () => {
    install();
    const markup = new TextEncoder().encode('<script>alert(1)</script>');
    await putSessionStateBlob(new Request(blobUrl(), { method: 'PUT', body: markup }), SESSION);
    const read = await getSessionStateBlob(new Request(blobUrl()), SESSION);
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('application/octet-stream');
    expect(read.headers.get('x-content-type-options')).toBe('nosniff');
    expect(read.headers.get('content-disposition')).toBe('attachment');
  });

  it('answers 413 session_state_too_large over the cap, and stores nothing', async () => {
    const store = install();
    const declared = await putSessionStateBlob(
      new Request(blobUrl(), {
        method: 'PUT',
        headers: { 'content-length': String(33 * 1024 * 1024) },
        body: new Uint8Array([1]),
      }),
      SESSION,
    );
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({ error: { code: 'session_state_too_large' } });
    await expect(
      store.getBlob({
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        engine: ENGINE,
        blobKey: 'state.tar',
      }),
    ).resolves.toEqual({ ok: true, content: null });
  });

  it('refuses a blob key that could escape its own prefix', async () => {
    install();
    const response = await putSessionStateBlob(
      new Request(blobUrl({ blobKey: '../../etc/passwd' }), {
        method: 'PUT',
        body: new Uint8Array(),
      }),
      SESSION,
    );
    expect(response.status).toBe(400);
  });

  it('answers 404 for a blob that was never written', async () => {
    install();
    const response = await getSessionStateBlob(new Request(blobUrl()), SESSION);
    expect(response.status).toBe(404);
  });

  it('answers 503 — never a silent success — when this deployment stores no blobs', async () => {
    install({ stateStore: new InMemorySessionStateStore({ blobs: false }) });
    const response = await putSessionStateBlob(
      new Request(blobUrl(), { method: 'PUT', body: new Uint8Array([1]) }),
      SESSION,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'session_state_blobs_not_configured' },
    });
  });
});

describe('the cursor', () => {
  it('pages from a sequence and refuses a cursor it cannot parse', async () => {
    install();
    await appendSessionState(
      appendRequest(
        batch([
          { entryKey: 'a', entry: { type: 'user' } },
          { entryKey: 'b', entry: { type: 'assistant' } },
        ]),
      ),
      SESSION,
    );
    const second = await listSessionStateEntries(new Request(entriesUrl({ after: '1' })), SESSION);
    expect(await second.json()).toEqual({
      entries: [{ sequence: 2, entryKey: 'b', entry: { type: 'assistant' } }],
      nextCursor: 2,
    });
    // `Number('1x')` is NaN and `NaN < 0` is false, so a check written the other way round would
    // read a malformed cursor as valid and page from somewhere the caller did not ask for.
    const malformed = await listSessionStateEntries(
      new Request(entriesUrl({ after: '1x' })),
      SESSION,
    );
    expect(malformed.status).toBe(400);
  });
});

/**
 * R-01 §7's `project_key_mismatch`, moved with the writer (ADR-0071): a `claude-agent-sdk` stream is
 * keyed `projectKey + '/' + subpath`, and the public read looks under the caller's own project key.
 */
describe('the Claude project-key guard on state writes', () => {
  const FOREIGN = 'sandbox-cwd-derived/';

  function write(method: 'POST' | 'PUT', streamKey: string): Request {
    return new Request(`https://control.example/api/sessions/${SESSION}/state-entries`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: ENGINE, streamKey, entries: [{ entry: { type: 'user' } }] }),
    });
  }

  it.each([
    ['POST', appendSessionState],
    ['PUT', replaceSessionState],
  ] as const)(
    'refuses a %s under another project key with 403 and stores nothing',
    async (method, handler) => {
      const store = install({ principal: RUNNER });
      const response = await handler(write(method, FOREIGN), SESSION);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'project_key_mismatch' } });
      await expect(
        store.list(
          { workspaceId: WORKSPACE, sessionId: SESSION, engine: ENGINE, streamKey: FOREIGN },
          {},
        ),
      ).resolves.toBeNull();
    },
  );

  it('refuses a DELETE under another project key with 403', async () => {
    install({ principal: RUNNER });
    const response = await deleteSessionState(
      new Request(entriesUrl({ streamKey: FOREIGN }), { method: 'DELETE' }),
      SESSION,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'project_key_mismatch' } });
  });

  it('refuses a key that only starts with the project key and no slash', async () => {
    install({ principal: RUNNER });
    const response = await appendSessionState(write('POST', `${WORKSPACE}x/`), SESSION);
    expect(response.status).toBe(403);
  });

  it('accepts the main and a subagent stream under the caller’s own project key', async () => {
    install({ principal: RUNNER });
    for (const streamKey of [`${WORKSPACE}/`, `${WORKSPACE}/subagents/agent-1`]) {
      const response = await appendSessionState(write('POST', streamKey), SESSION);
      expect(response.status).toBe(204);
    }
  });

  it('answers 404, not 403, for a session the caller may not reach', async () => {
    install({ principal: { ...RUNNER, sessionId: OTHER_SESSION } });
    const response = await appendSessionState(write('POST', FOREIGN), SESSION);
    expect(response.status).toBe(404);
  });

  it('leaves every other engine’s stream key opaque', () => {
    for (const other of ENGINE_IDS.filter((id) => id !== ENGINE)) {
      expect(projectKeyMismatch(WORKSPACE, { engine: other, streamKey: FOREIGN })).toBeNull();
    }
    expect(projectKeyMismatch(WORKSPACE, { engine: ENGINE, streamKey: FOREIGN })?.status).toBe(403);
  });
});
