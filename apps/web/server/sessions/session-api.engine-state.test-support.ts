import {
  createInMemoryWorkspaceScopeResolver,
  SESSION_STATE_PAGE_LIMIT,
  type SessionRecord,
} from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';
import { installTestDomains } from '../application-context-fixtures';
import { sessionPageOf } from '../pagination/testing';
import { appendTranscript, deleteTranscript, listTranscriptSubkeys, loadTranscript } from './api';
import { InMemoryTranscriptStore } from './memory-store';
import {
  del,
  errorCode,
  get,
  post,
  PRINCIPAL,
  SESSION,
  TRANSCRIPT,
  USER,
  WORKSPACE,
} from './session-api.test-support';
import { InMemorySessionStateStore } from './state-memory-store';
import { createRepositorySessionsStoreProvider } from './store';

export function registerEngineStateTests() {
  describe('GET …/transcript and …/subkeys over the engine-scoped store', () => {
    registerEngineReads();
    registerEngineAppends();
    registerEngineDeletes();
  });
}

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

async function servesPostENG06SessionEngineScopedStore() {
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
}

async function answersEmptyStreamEmptyTranscriptNot404() {
  const { state } = installBoth();
  await state.append(stream(`${WORKSPACE}/`), []);
  const response = await loadTranscript(get(TRANSCRIPT), SESSION);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ entries: [] });
}

async function prefersEngineScopedStreamOverLegacyTranscriptSame() {
  const { legacy, state } = installBoth();
  await legacy.append({ projectKey: WORKSPACE, sessionId: SESSION }, [{ type: 'legacy' }]);
  await state.append(stream(`${WORKSPACE}/`), [{ entry: { type: 'current' } }]);
  const response = await loadTranscript(get(TRANSCRIPT), SESSION);
  await expect(response.json()).resolves.toEqual({ entries: [{ type: 'current' }] });
}

async function fallsBackLegacyTablesPreENG06Session() {
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
}

async function listsUnionBothStoresSubkeysBecauseReadFalls() {
  const { legacy, state } = installBoth();
  await legacy.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/b' }, [
    { type: 'user' },
  ]);
  await state.append(stream(`${WORKSPACE}/subagents/a`), [{ entry: { type: 'user' } }]);
  await state.append(stream(`${WORKSPACE}/subagents/b`), [{ entry: { type: 'user' } }]);
  const subkeys = await listTranscriptSubkeys(get(`/api/sessions/${SESSION}/subkeys`), SESSION);
  await expect(subkeys.json()).resolves.toEqual({ subkeys: ['subagents/a', 'subagents/b'] });
}

async function answers404TranscriptNotFoundWhenNeitherStore() {
  installBoth();
  const response = await loadTranscript(get(TRANSCRIPT), SESSION);
  expect(response.status).toBe(404);
  expect(await errorCode(response)).toBe('transcript_not_found');
}

async function readsTranscriptLongerThanOneStorePageWhole() {
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
}

async function refusesArchivedSessionWhoseEngineSessionIdIs() {
  const { state } = installBoth({ status: 'archived', engineSessionId: null });
  await state.append(stream(`${WORKSPACE}/`), [{ entry: { type: 'user' } }]);
  const response = await loadTranscript(get(TRANSCRIPT), SESSION);
  expect(response.status).toBe(409);
  expect(await errorCode(response)).toBe('session_archived');
}

async function subkeysRefusesArchivedSession409SessionArchived() {
  const { state } = installBoth({ status: 'archived' });
  await state.append(stream(`${WORKSPACE}/subagents/agent-1`), [{ entry: { type: 'user' } }]);
  const response = await listTranscriptSubkeys(get(`/api/sessions/${SESSION}/subkeys`), SESSION);
  expect(response.status).toBe(409);
  expect(await errorCode(response)).toBe('session_archived');
}

async function postAppendsEngineScopedStreamSoNextGET() {
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
}

async function postRefusesSessionPinnedAnotherEngine409Session() {
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
}

async function deleteRemovesPostENG06TranscriptSoNext() {
  const { state } = installBoth();
  await state.append(stream(`${WORKSPACE}/`), [{ entryKey: 'u-1', entry: { type: 'user' } }]);
  const deleted = await deleteTranscript(del(TRANSCRIPT), SESSION);
  expect(deleted.status).toBe(204);
  const response = await loadTranscript(get(TRANSCRIPT), SESSION);
  expect(response.status).toBe(404);
  expect(await errorCode(response)).toBe('transcript_not_found');
}

async function deleteRemovesPreENG06TranscriptLegacyTables() {
  const { legacy } = installBoth({ engine: null });
  await legacy.append({ projectKey: WORKSPACE, sessionId: SESSION }, [
    { type: 'user', uuid: 'old-1' },
  ]);
  const deleted = await deleteTranscript(del(TRANSCRIPT), SESSION);
  expect(deleted.status).toBe(204);
  const response = await loadTranscript(get(TRANSCRIPT), SESSION);
  expect(response.status).toBe(404);
  expect(await errorCode(response)).toBe('transcript_not_found');
}

async function deleteRemovesBothCopiesWhenMigratedSessionStill() {
  const { legacy, state } = installBoth();
  await legacy.append({ projectKey: WORKSPACE, sessionId: SESSION }, [{ type: 'legacy' }]);
  await state.append(stream(`${WORKSPACE}/`), [{ entry: { type: 'current' } }]);
  await deleteTranscript(del(TRANSCRIPT), SESSION);
  const response = await loadTranscript(get(TRANSCRIPT), SESSION);
  expect(response.status).toBe(404);
}

function registerEngineReads() {
  it(
    'serves a post-ENG-06 session from the engine-scoped store, keyed projectKey + "/" + subpath',
    servesPostENG06SessionEngineScopedStore,
  );

  it(
    'answers an empty stream as an empty transcript, not a 404',
    answersEmptyStreamEmptyTranscriptNot404,
  );

  it(
    'prefers the engine-scoped stream over a legacy transcript of the same key',
    prefersEngineScopedStreamOverLegacyTranscriptSame,
  );

  it(
    'falls back to the legacy tables for a pre-ENG-06 session the new store has no stream for',
    fallsBackLegacyTablesPreENG06Session,
  );

  it(
    'lists the union of both stores’ subkeys, because a read falls back per stream',
    listsUnionBothStoresSubkeysBecauseReadFalls,
  );

  it(
    'answers 404 transcript_not_found when neither store has the stream',
    answers404TranscriptNotFoundWhenNeitherStore,
  );

  it(
    'reads a transcript longer than one store page whole, in order',
    readsTranscriptLongerThanOneStorePageWhole,
  );

  it(
    'refuses an archived session whose engine_session_id is still NULL with 409 session_archived',
    refusesArchivedSessionWhoseEngineSessionIdIs,
  );

  it(
    'subkeys refuses an archived session with 409 session_archived',
    subkeysRefusesArchivedSession409SessionArchived,
  );
}

function registerEngineAppends() {
  it(
    'POST appends to the engine-scoped stream, so the next GET reads the posted entries',
    postAppendsEngineScopedStreamSoNextGET,
  );

  it(
    'POST refuses a session pinned to another engine with 409 session_engine_mismatch',
    postRefusesSessionPinnedAnotherEngine409Session,
  );
}

function registerEngineDeletes() {
  it(
    'DELETE removes a post-ENG-06 transcript, so the next GET is 404',
    deleteRemovesPostENG06TranscriptSoNext,
  );

  it(
    'DELETE removes a pre-ENG-06 transcript from the legacy tables, so the next GET is 404',
    deleteRemovesPreENG06TranscriptLegacyTables,
  );

  it(
    'DELETE removes both copies when a migrated session still has its legacy rows',
    deleteRemovesBothCopiesWhenMigratedSessionStill,
  );
}
