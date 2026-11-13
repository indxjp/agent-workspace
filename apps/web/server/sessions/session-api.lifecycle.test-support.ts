import {
  createInMemoryWorkspaceScopeResolver,
  type SessionRecord,
  type SessionRepositoryProvider,
} from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';
import { installTestDomains } from '../application-context-fixtures';
import { sessionPageOf } from '../pagination/testing';
import { getSession, listSessions, loadTranscript, updateSession } from './api';
import type { SessionApiPrincipal } from './environment';
import { InMemoryTranscriptStore } from './memory-store';
import {
  errorCode,
  get,
  installLifecycle,
  patch,
  SESSION,
  USER,
  WORKSPACE,
} from './session-api.test-support';
import { createRepositorySessionsStoreProvider } from './store';

export function registerLifecycleTests() {
  describe('GET /api/sessions', () => {
    it(
      'answers 500, not 200, when the workspace id could not be a projectKey',
      answers500Not200WhenWorkspaceIdCould,
    );
  });

  describe('complete session lifecycle', () => {
    it(
      'lists only sessions owned by the exact API-key principal when user ids are null',
      listsOnlySessionsOwnedExactAPIKeyPrincipal,
    );

    it(
      'lists complete rows and marks only active mapped sessions resumable',
      listsCompleteRowsMarksOnlyActiveMappedSessions,
    );

    it(
      'updates the title, archives idempotently, and restores without deleting the transcript',
      updatesTitleArchivesIdempotentlyRestoresWithoutDeletingTranscript,
    );

    it('refuses transcript resume while archived', refusesTranscriptResumeWhileArchived);
  });
}

async function answers500Not200WhenWorkspaceIdCould() {
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
}

async function listsOnlySessionsOwnedExactAPIKeyPrincipal() {
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
}

async function listsCompleteRowsMarksOnlyActiveMappedSessions() {
  installLifecycle();
  const response = await listSessions(get('/api/sessions?status=active'));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    sessions: [{ id: SESSION, title: 'First session', status: 'active', resumable: true }],
  });
}

async function updatesTitleArchivesIdempotentlyRestoresWithoutDeletingTranscript() {
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
}

async function refusesTranscriptResumeWhileArchived() {
  const current = installLifecycle('archived');
  const claudeId = current().engineSessionId!;
  const response = await loadTranscript(
    get(`/api/sessions/${claudeId}/transcript?projectKey=${WORKSPACE}`),
    claudeId,
  );
  expect(response.status).toBe(409);
  expect(await errorCode(response)).toBe('session_archived');
}
